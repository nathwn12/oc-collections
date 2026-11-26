// The only ctx-touching module: serialized, guarded title writes.

import { normalizeTitle, stateOf } from "./title.js";
import { isChild, isArchived, deriveState } from "./state.js";

export const counters = { events: 0, writes: 0, skips: 0, failures: 0 }; // Shared health counters.

const READ_TRIES = 4; // session.created can beat its own record into the store.
const READ_BACKOFF_MS = 150; // 150, 300, 600: about a second, then give up.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// unwrap: accept a record directly or wrapped as { data: record }.
function unwrap(value) {
  return value && typeof value === "object" && value.data && typeof value.data === "object" ? value.data : value;
}

// createWriter: build the enqueue and flush pair bound to one ctx.
// The chains and watermarks live here, not at module scope: a reload builds a new
// writer, and it must not inherit the previous one's pending chain.
export function createWriter(ctx, { options = {}, trace = () => {} } = {}) {
  const chains = new Map(); // One shared write chain per session id.
  const applied = new Map(); // Last applied durable seq per session id.
  const skip = (id, why) => { counters.skips++; trace("skip " + id + ": " + why); return why; }; // Count and trace a skip.

  // readRecord: retry a miss rather than drop the write. A created event can
  // arrive before the record it names is readable, and one missed read is the
  // difference between a titled session and a bare one for the life of the session.
  async function readRecord(id) {
    for (let attempt = 0; attempt < READ_TRIES; attempt++) {
      const rec = unwrap(await ctx.session.get({ sessionID: id }));
      if (rec && rec.id === id) return rec;
      if (attempt < READ_TRIES - 1) await sleep(READ_BACKOFF_MS * 2 ** attempt);
    }
    return undefined;
  }

  async function apply(id, state, seq) { // Perform one guarded write inside the chain.
    const last = applied.get(id);
    if (typeof seq === "number" && typeof last === "number" && seq < last) return skip(id, "stale seq " + seq);
    if (typeof seq === "number") applied.set(id, seq);
    try {
      const rec = await readRecord(id);
      if (!rec) return skip(id, "no matching record");
      if (typeof rec.title !== "string") return skip(id, "no title");
      // A closed title is final for every event, mapped or unmapped: the
      // lifecycle map may not reopen a session the title has already closed.
      const closed = stateOf(rec.title) === "closed";
      // A session the plugin has never stamped gets one pass from whatever event
      // reaches it, so a missed session.created repairs itself. A catch-up may
      // confirm a closed title, never reopen it.
      let target = state;
      if (target == null) {
        const meta = rec.metadata && typeof rec.metadata === "object" ? rec.metadata["oc-title"] : undefined;
        if (meta && meta.state) return skip(id, "already stamped");
        target = closed ? "closed" : deriveState(rec);
        trace("catch-up " + id + ": derived " + target);
      } else if (closed) {
        target = "closed";
      }
      const child = isChild(rec);
      const effective = isArchived(rec) ? "closed" : target;
      const next = normalizeTitle(rec.title, child ? null : effective, options);
      const old = rec.metadata && typeof rec.metadata === "object" ? rec.metadata : {};
      const metadata = { ...old, "oc-title": { state: effective, at: Date.now() } };
      const titleChanged = rec.title !== next;
      if (!titleChanged && old["oc-title"]?.state === effective) return skip(id, "unchanged");
      await ctx.session.update({ sessionID: id, metadata, ...(titleChanged && { title: next }) });
      counters.writes++;
      trace("write " + id + ": " + (titleChanged ? next : "metadata"));
      return titleChanged ? "wrote" : "metadata";
    } catch (err) {
      counters.failures++;
      trace("fail " + id + ": " + (err?.message ?? err));
      return "failed";
    }
  }

  function enqueue(id, state, seq) { // Serialize a write and never reject the returned promise.
    const prev = chains.get(id) ?? Promise.resolve();
    const run = prev.then(() => apply(id, state, seq));
    chains.set(id, run);
    // Forget a settled chain unless a newer event replaced it, so neither the map
    // nor flush() grows with every session the process has ever seen.
    const settle = () => { if (chains.get(id) === run) chains.delete(id); };
    void run.then(settle, settle);
    return run;
  }

  async function flush(timeoutMs = 2000) { // Await in-flight writes, capped by a timeout.
    const pending = Promise.allSettled([...chains.values()]);
    if (!(timeoutMs > 0)) return void (await pending);
    let timer;
    const cap = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    await Promise.race([pending, cap]);
    clearTimeout(timer);
  }

  return { enqueue, flush };
}
