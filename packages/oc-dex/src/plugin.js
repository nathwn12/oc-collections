import { loadOptions, validateRun, REASONING_EFFORTS } from "./config.js";
import { runCodex } from "./controller.js";
import { formatProgress, progressPolicy } from "./progress.js";
import { readSettings } from "./settings.js";

const THROTTLE_MS = 250;

export function createPlugin(runner = runCodex, options, timing = {}) {
  return {
    id: "oc-dex",
    async setup(ctx) {
      // The config entry's options are the documented way to configure a plugin and win over the
      // standalone file beside this module; explicit options win over both so a host or a test
      // can pin them. Bad values fail here, not per call.
      const config = options ?? loadOptions({ ...(timing.settings ?? readSettings()), ...ctx.options });
      const heartbeatMs = timing.heartbeatMs ?? config.heartbeatSeconds * 1000;
      const policy = progressPolicy(config.progress);
      const timeoutCeiling = Math.min(3600, config.maxTimeoutSeconds);
      await ctx.tool.transform(editor => editor.add({
        name: "oc_dex",
        description: `Run a bounded headless Codex task using an OpenCode Go model (${config.models.join(", ")}). Codex enforces its own sandbox (${config.allowWorkspaceWrite ? "read-only or workspace-write" : "read-only"}) and never inherits OpenCode tool permissions; approval requests are always declined. Returns a thread ID for resumption.`,
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Task to give Codex" },
            model: { type: "string", enum: config.models, description: "OpenCode Go model ID, without provider prefix" },
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
          const connection = await ctx.integration.connection.active("opencode-go");
          const credential = connection && await ctx.integration.connection.resolve(connection);
          if (!credential || credential.type !== "key" || !credential.key) throw new Error("No active OpenCode Go API key connection");
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
            result = await runner({ ...run, cwd: ctx.location.directory, apiKey: credential.key, signal: context.signal }, event => {
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

          const id = result.threadId || run.threadId || "not started";
          const lines = [
            `Codex ${result.status}. Thread: ${id}. Model: ${run.model}.${run.reasoningEffort !== undefined ? ` Effort: ${run.reasoningEffort}.` : ""} Mode: ${run.mode}. Denied approvals: ${result.deniedApprovals ?? 0}.`,
            result.error ? `Error: ${result.error}` : "",
            result.text || "",
          ].filter(Boolean);
          return {
            content: lines.join("\n"),
            metadata: { status: result.status, threadId: id, model: run.model, mode: run.mode, deniedApprovals: result.deniedApprovals ?? 0 },
          };
        },
      }));
    },
  };
}
