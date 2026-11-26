// oc-title wiring: subscribe to lifecycle events, sweep at setup and cleanly stop.

import { normalizeTitle, stateOf } from "./title.js";
import { STATE_FOR, sessionIDOf, seqOf, deriveState, isChild } from "./state.js";
import { createWriter, counters } from "./write.js";
import { scopeFromMessage, newestUserMessage } from "./refresh.js";

function sleep(ms, signal) { // Wait for a backoff delay or an immediate abort.
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export default {
  id: "oc-title",
  // setup: wire options, trace, writer, sweep and the self-healing subscription synchronously.
  setup(ctx) {
    const trace = process.env.OC_TITLE_TRACE === "1" ? (m) => console.log(`oc-title: ${m}`) : () => {};
    const o = ctx.options ?? {};
    const options = { ...(Number.isFinite(o.maxLength) && { maxLength: o.maxLength }), ...(typeof o.fallbackTitle === "string" && { fallbackTitle: o.fallbackTitle }) };
    const writer = createWriter(ctx, { options, trace });

    // Explicit scope refresh: a small tool that rewrites only the scope text of a
    // title this plugin already stamped. The writer owns every guard and ordering.
    if (ctx.tool && typeof ctx.tool.transform === "function") {
      void ctx.tool.transform((editor) => {
        editor.add({
          name: "oc_title_refresh",
          description: "Refresh an OpenCode session title's scope from the session's latest user request (or an explicit scope), without changing its state, closing a closed session, or touching a title oc-title has not stamped. Returns JSON with ok, sessionID and outcome.",
          input: {
            type: "object",
            properties: {
              session: { type: "string", description: "Session id to refresh; defaults to the calling session" },
              scope: { type: "string", description: "Explicit scope text; defaults to the latest user request in the session" },
            },
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const args = input && typeof input === "object" ? input : {};
            const id = (typeof args.session === "string" && args.session) || (typeof context?.sessionID === "string" ? context.sessionID : "");
            if (!id) return { content: JSON.stringify({ ok: false, reason: "no session id" }) };
            let scope = typeof args.scope === "string" && args.scope.trim() ? args.scope : undefined;
            if (!scope) {
              // Documented V2 SessionContext method: session.context({sessionID})
              // returns the full SessionMessageInfo[]; there is no message.list.
              if (typeof ctx?.session?.context !== "function") return { content: JSON.stringify({ ok: false, reason: "no scope and no session context reader" }) };
              try {
                scope = scopeFromMessage(newestUserMessage(await ctx.session.context({ sessionID: id })));
              } catch (err) {
                return { content: JSON.stringify({ ok: false, reason: "message read failed: " + (err?.message ?? err) }) };
              }
            }
            if (!scope) return { content: JSON.stringify({ ok: false, reason: "no user scope" }) };
            const outcome = await writer.refresh(id, scope);
            return { content: JSON.stringify({ ok: outcome === "refreshed", sessionID: id, outcome }) };
          },
        });
      });
    }

    const controller = new AbortController();

    void (async () => { // Sweep existing sessions without ever throwing out.
      try {
        const listed = await ctx.session.list({});
        const records = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : [];
        for (const rec of records) {
          if (isChild(rec) || typeof rec?.id !== "string" || typeof rec?.title !== "string") continue;
          const state = stateOf(rec.title) ?? deriveState(rec);
          if (rec.title !== normalizeTitle(rec.title, state, options)) writer.enqueue(rec.id, state);
        }
      } catch (err) {
        counters.failures++;
        trace(`sweep failed: ${err?.message ?? err}`);
      }
    })();

    void (async () => { // Restart the subscription on end or error until aborted.
      let delay = 1000;
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            counters.events++;
            delay = 1000;
            const type = event?.type;
            if (typeof type !== "string" || !type.startsWith("session.")) continue;
            const id = sessionIDOf(event);
            if (!id) { counters.skips++; trace("skip " + type + ": no session id"); continue; }
            const state = STATE_FOR[type];
            // An unmapped session event is the catch-up path, not a no-op: the
            // writer stamps a session it has never stamped and leaves the rest be.
            if (!state) trace("catch-up " + type);
            writer.enqueue(id, state, seqOf(event));
          }
          if (controller.signal.aborted) break;
          trace("subscription ended; restarting");
        } catch (err) {
          if (controller.signal.aborted) break;
          counters.failures++;
          trace(`subscription error: ${err?.message ?? err}`);
        }
        await sleep(delay, controller.signal);
        delay = Math.min(delay * 2, 30000);
      }
    })();

    trace("subscribed");

    return async () => { // Abort first, then await in-flight writes with a timeout.
      controller.abort();
      try { await writer.flush(2000); } catch {}
    };
  },
};
