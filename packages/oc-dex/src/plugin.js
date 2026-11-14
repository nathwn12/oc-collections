import { loadOptions, validateRun, REASONING_EFFORTS, GO_MODELS } from "./config.js";
import { runCodex } from "./controller.js";
import { formatProgress, progressPolicy } from "./progress.js";
import { readSettings } from "./settings.js";
import { normalizeOptions } from "./models.js";

const THROTTLE_MS = 250;
const THREAD_BINDING_PREFIX = "oc-dex.thread.v1/";
const DELEGATION_GUIDANCE = "For independent, bounded read-only work, consider calling oc_dex directly rather than launching another model worker. Include all task context the worker needs, then review and verify its result. The parent keeps its selected model; oc_dex uses its separately configured OpenCode Go model and isolated Codex sandbox. Tool listing does not mean permission is granted: follow OpenCode's permission prompt and rules. If denied, stop; do not retry or route around the denial. Delegation is optional; do not send trivial or dependent work.";
const ELIGIBLE_PRIMARY_AGENTS = new Set(["build", "plan"]);
const GO_CATALOG = new Set([...GO_MODELS].map(id => `opencode-go/${id}`));
// The SDK storage API has get/set but no compare-and-set; serialize local binding writes per process.
const bindingStateKey = Symbol.for("oc-dex.thread-binding-queue");
const bindingState = globalThis[bindingStateKey] ??= { queue: Promise.resolve() };

const withBindingLock = task => {
  const result = bindingState.queue.then(task);
  bindingState.queue = result.catch(() => {});
  return result;
};

export function createPlugin(runner = runCodex, options, timing = {}) {
  return {
    id: "oc-dex",
    async setup(ctx) {
      // The config entry's options are the documented way to configure a plugin and win over the
      // standalone file beside this module; explicit options win over both so a host or a test
      // can pin them. Bad values fail here, not per call.
      const rawConfig = options ?? loadOptions({ ...(timing.settings ?? readSettings()), ...ctx.options });
      const config = normalizeOptions(rawConfig, GO_CATALOG);
      const registrations = [];
      const dispose = async () => {
        const current = registrations.splice(0).reverse();
        await Promise.all(current.map(registration => registration?.dispose?.()));
      };
      if (config.delegationGuidance && typeof ctx.session?.hook === "function") {
        registrations.push(await ctx.session.hook("context", event => {
          if (!ELIGIBLE_PRIMARY_AGENTS.has(event.agent) || !event.tools?.oc_dex) return;
          if (event.system.some(part => part.text?.includes("oc-dex:delegation-guidance"))) return;
          event.system.push({ type: "text", text: `oc-dex:delegation-guidance\n${DELEGATION_GUIDANCE}` });
        }));
      }
      const heartbeatMs = timing.heartbeatMs ?? config.heartbeatSeconds * 1000;
      const policy = progressPolicy(config.progress);
      const timeoutCeiling = Math.min(3600, config.maxTimeoutSeconds);
      const bindThread = (threadId, run, allowCreate = true) => withBindingLock(async () => {
        if (!ctx.storage || typeof ctx.storage.get !== "function" || typeof ctx.storage.set !== "function") {
          throw new Error("thread_binding_storage_unavailable");
        }
        const key = THREAD_BINDING_PREFIX + encodeURIComponent(threadId);
        let current;
        try { current = await ctx.storage.get(key); } catch { throw new Error("thread_binding_storage_unavailable"); }
        if (current !== undefined) {
          if (!current || current.version !== 1 || typeof current.providerID !== "string" || typeof current.modelID !== "string") {
            throw new Error(`thread_binding_unknown: ${threadId}`);
          }
          if (current.providerID !== run.providerID || current.modelID !== run.modelID) {
            throw new Error(`thread_binding_mismatch: ${threadId}`);
          }
          return;
        }
        if (!allowCreate) throw new Error(`thread_binding_unknown: ${threadId}`);
        const binding = { version: 1, providerID: run.providerID, modelID: run.modelID };
        try { await ctx.storage.set(key, binding); } catch { throw new Error("thread_binding_storage_unavailable"); }
      });
      const toolRegistration = Promise.resolve().then(() => ctx.tool.transform(editor => editor.add({
        name: "oc_dex",
        description: `Run a bounded headless Codex worker task using an OpenCode Go model (${config.models.join(", ")}). Native agents may choose this directly for independent delegated work; include all necessary task context and review the result. This worker uses its separately configured Go model and Codex sandbox (${config.allowWorkspaceWrite ? "read-only or workspace-write" : "read-only"}); it does not inherit OpenCode tools or permissions. Approval requests are always declined. Returns a thread ID for resumption.`,
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Task to give Codex" },
            model: { type: "string", enum: config.models, description: "Provider-qualified OpenCode model ID" },
            reasoningEffort: { type: "string", enum: REASONING_EFFORTS, description: "Codex reasoning effort for this run (for example xhigh); omit to leave the server default unchanged" },
            mode: { type: "string", enum: config.allowWorkspaceWrite ? ["read-only", "workspace-write"] : ["read-only"], description: "Codex sandbox mode" },
            timeoutSeconds: { type: "integer", minimum: 1, maximum: timeoutCeiling, default: Math.min(300, timeoutCeiling) },
            threadId: { type: "string", description: "Codex thread ID to resume" },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input, context) {
          const run = validateRun(input, config);
          if (run.threadId) {
            await bindThread(run.threadId, run, false);
          }
          let credential;
          if (run.providerID === "opencode-go") {
            const connection = await ctx.integration.connection.active(run.providerID);
            credential = connection && await ctx.integration.connection.resolve(connection);
            if (!credential || credential.type !== "key" || !credential.key) throw new Error(`No active ${run.providerID} API key connection`);
          }
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "oc_dex_run",
            resources: [ctx.location.directory],
            metadata: { mode: run.mode, model: run.model, timeoutSeconds: run.timeoutSeconds, ...(run.reasoningEffort !== undefined ? { reasoningEffort: run.reasoningEffort } : {}) },
          });

          const startedAt = Date.now();
          let stage = "starting";
          let detail = "";
          let lastShown = 0;
          let shownStage = "";
          let trailing;
          const show = force => {
            const now = Date.now();
            if (!force) {
              const wait = THROTTLE_MS - (now - lastShown);
              if (wait > 0) {
                // Never drop the newest state: keep one trailing update queued.
                if (!trailing) trailing = setTimeout(() => { trailing = undefined; show(true); }, wait);
                return;
              }
            }
            if (trailing) { clearTimeout(trailing); trailing = undefined; }
            lastShown = now;
            shownStage = stage;
            const update = formatProgress({ mode: config.progress, startedAt, at: now, stage, detail, model: run.model });
            void Promise.resolve(context.progress(update)).catch(() => {});
          };
          show(true);
          const heartbeat = setInterval(() => show(true), heartbeatMs);
          let result;
          try {
            result = await runner({ ...run, cwd: ctx.location.directory, apiKey: credential?.key, signal: context.signal, bindThread: id => bindThread(id, run) }, event => {
              if (event.type === "status") stage = event.status;
              else if (event.type === "thread") detail = `thread ${String(event.threadId).slice(0, 8)}`;
              else if (event.type === "activity") detail = String(event.status);
              else if (event.type === "approval-denied") detail = "approval denied";
              else if (event.type === "warning") detail = String(event.status).slice(0, 120);
              else if (event.type === "text") { stage = "running"; detail = String(event.text).replace(/\s+/g, " ").trim().slice(-120) || detail; }
              else return;
              if (!policy.onEvent) return;
              // Concise mode carries no moving detail, so an event that leaves the phase alone
              // would redraw the row for nothing.
              if (!policy.detail && stage === shownStage) return;
              show(false);
            }, config);
          } finally {
            clearInterval(heartbeat);
            if (trailing) clearTimeout(trailing);
            trailing = undefined;
            show(true);
          }

          if (result.threadId) await bindThread(result.threadId, run);
          const id = result.threadId || run.threadId || "not started";
          const lines = [
            `Codex ${result.status}. Thread: ${id}. Model: ${run.model}.${run.reasoningEffort !== undefined ? ` Effort: ${run.reasoningEffort}.` : ""} Mode: ${run.mode}. Denied approvals: ${result.deniedApprovals ?? 0}.`,
            result.processExit === "unconfirmed" ? "Codex process exit was not confirmed before the termination deadline." : "",
            result.error ? `Error: ${result.error}` : "",
            result.text || "",
          ].filter(Boolean);
          return {
            content: lines.join("\n"),
            metadata: { status: result.status, threadId: id, model: run.model, mode: run.mode, deniedApprovals: result.deniedApprovals ?? 0, processExit: result.processExit },
          };
        },
      })));
      try {
        registrations.push(await toolRegistration);
      } catch (error) {
        await dispose();
        throw error;
      }
      return dispose;
    },
  };
}
