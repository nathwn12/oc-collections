// A local, silent plugin: no tool call holds a turn past a hard deadline,
// and no foreground shell call can ask for a multi-hour timeout.

const GUARD = Symbol("oc-fix.guarded");
const SENTINEL = {};
// CLAMPED_BY_INPUT is the primary path: execute.before writes it on the clamped
// input object, and the execute wrapper that receives that object reads it, so
// the mark is part of the value the tool actually returns. CLAMPED_BY_ID is a
// legacy fallback for hosts that honour a post-hoc execute.after mutation.
const CLAMPED_BY_INPUT = new WeakMap();
const CLAMPED_BY_ID = new Map();

const DEFAULT_TIMEOUT_MS = 600000; // 10 minutes for every tool
const DEFAULT_SHELL_TIMEOUT_MS = 720000; // 12 minutes for shell/bash
const DEFAULT_SHELL_CAP_MS = 600000; // clamp foreground shell timeout to 10 minutes

const EXEMPT_TOOLS = new Set(["task", "agent", "subagent"]);
const SHELL_TOOLS = new Set(["shell", "bash"]);

function traceEnabled() {
  try {
    return typeof process !== "undefined" && process.env?.OC_FIX_TRACE === "1";
  } catch {
    return false;
  }
}

function trace(message) {
  if (!traceEnabled()) return;
  try {
    console.log(`oc-fix: ${message}`);
  } catch {}
}

function numericOption(options, key, fallback) {
  const value = options?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Attach the stamp without changing the command output or the shape of a
// structured result. Primitives and arrays are returned as-is: a mark there
// would corrupt the payload or break a declared output schema, so the opt-in
// trace is the record of the clamp instead.
function withClampMark(result, stamp) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const metadata =
    result.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
      ? result.metadata
      : {};
  return { ...result, metadata: { ...metadata, "oc-fix": stamp } };
}

// Mechanism A: clamp the shell timeout before execution and leave an
// observable mark on the value the wrapper will return.
function clampShell(event, capMs) {
  if (!event) return;
  if (!SHELL_TOOLS.has(event.tool)) return;
  const input = event.input;
  if (input === null || typeof input !== "object") return;
  if (input.background === true) return;
  if (typeof input.timeout !== "number" || !(input.timeout > capMs)) return;
  const stamp = { clamped: true, requested: input.timeout, applied: capMs };
  event.input = { ...input, timeout: capMs };
  // A harness may forward either the original input object or the replacement;
  // index both so the mark survives whichever reference reaches execute.
  CLAMPED_BY_INPUT.set(input, stamp);
  CLAMPED_BY_INPUT.set(event.input, stamp);
  if (typeof event.id === "string") CLAMPED_BY_ID.set(event.id, stamp);
  trace(`clamped ${event.tool} timeout ${input.timeout}ms -> ${capMs}ms (call ${event.id ?? "?"})`);
}

// Mechanism B: a hard deadline on every (non-exempt) tool call.
function makeDeadline(original, id, limitMs) {
  const shown = limitMs >= 1000 ? `${Math.round(limitMs / 1000)}s` : `${limitMs}ms`;
  return async (input, context) => {
    let timer;
    const timerPromise = new Promise((resolve) => {
      timer = setTimeout(resolve, limitMs, SENTINEL);
    });
    try {
      timer.unref?.();
    } catch {}
    const work = Promise.resolve().then(() => original(input, context));
    // The loser must never produce an unhandled rejection.
    work.catch(() => {});
    try {
      const result = await Promise.race([work, timerPromise]);
      if (result === SENTINEL) {
        // A tool that declares an output schema rejects a bare content result, so fail the call
        // the way the runtime expects: the model sees the reason and continues.
        throw new Error(
          `oc-fix: ${id} did not return within ${shown} and was abandoned so it could not hold the turn. It may still be running. Retry with a narrower scope, or run it in the background.`,
        );
      }
      const stamp = CLAMPED_BY_INPUT.get(input);
      if (!stamp) return result;
      CLAMPED_BY_INPUT.delete(input);
      trace(`${id}: returning clamped result with oc-fix metadata (requested ${stamp.requested}ms, applied ${stamp.applied}ms)`);
      return withClampMark(result, stamp);
    } finally {
      clearTimeout(timer);
    }
  };
}

function wrapTools(editor, generalMs, shellMs) {
  if (!editor || typeof editor.list !== "function" || typeof editor.update !== "function") return;
  const tools = editor.list();
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool.execute !== "function") continue;
    if (tool.execute[GUARD] === true) continue;
    const id = tool.id;
    if (EXEMPT_TOOLS.has(id)) continue;
    const original = tool.execute;
    const limitMs = SHELL_TOOLS.has(id) ? shellMs : generalMs;
    const wrapped = makeDeadline(original, id, limitMs);
    wrapped[GUARD] = true;
    editor.update(id, (t) => {
      if (t) t.execute = wrapped;
    });
  }
}

export default {
  id: "oc-fix",
  async setup(ctx) {
    const tool = ctx?.tool;
    const options = ctx?.options;
    const envMs = (name) => {
      try {
        const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      } catch {
        return undefined;
      }
    };
    const generalMs = envMs("OC_FIX_TIMEOUT_MS") ?? numericOption(options, "timeoutMs", DEFAULT_TIMEOUT_MS);
    const shellMs = envMs("OC_FIX_SHELL_TIMEOUT_MS") ?? numericOption(options, "shellTimeoutMs", DEFAULT_SHELL_TIMEOUT_MS);
    const capMs = envMs("OC_FIX_SHELL_CAP_MS") ?? numericOption(options, "shellCapMs", DEFAULT_SHELL_CAP_MS);
    const registrations = [];

    if (typeof tool?.hook === "function") {
      try {
        const registration = await tool.hook("execute.before", (event) => {
          clampShell(event, capMs);
        });
        if (registration) registrations.push(registration);
      } catch {}
    }

    // Legacy fallback: a host that honours a post-hoc result mutation gets the
    // same stamp here. The primary mark is on the wrapper's returned result.
    if (typeof tool?.hook === "function") {
      try {
        const registration = await tool.hook("execute.after", (event) => {
          const mark = CLAMPED_BY_ID.get(event.id);
          if (!mark) return;
          CLAMPED_BY_ID.delete(event.id);
          const stamp = { clamped: true, requested: mark.requested, applied: mark.applied };
          try {
            if (event.status === "completed") {
              const result = event.result || {};
              event.result = { ...result, metadata: { ...result.metadata, "oc-fix": stamp } };
            } else if (event.status === "error" && event.error) {
              event.error.metadata = { ...event.error.metadata, "oc-fix": stamp };
            }
          } catch {}
        });
        if (registration) registrations.push(registration);
      } catch {}
    }

    if (typeof tool?.transform === "function") {
      try {
        const registration = await tool.transform((editor) => {
          wrapTools(editor, generalMs, shellMs);
        });
        if (registration) registrations.push(registration);
      } catch {}
    }

    // A transform registered before core tools exist wraps nothing; replay it over the full registry.
    if (typeof tool?.reload === "function") {
      try {
        await tool.reload();
      } catch {}
    }

    try {
      const tools = await tool?.list();
      const list = Array.isArray(tools) ? tools : [];
      const guarded = list.filter((t) => t?.execute?.[GUARD] === true);
      const ids = guarded.map((t) => t.id).join(",");
      // list() rebuilds definitions, so this count under-reports: the guard still applies to the
      // request snapshot, which is why the deadline test runs a real tool call.
      trace(`seen ${list.length} tools, ${guarded.length} shown guarded: ${ids}`);
    } catch {}

    return () => {
      for (const registration of registrations) {
        try {
          registration.dispose?.();
        } catch {}
      }
    };
  },
};
