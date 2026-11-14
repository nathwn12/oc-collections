// Model catalog and run options. The catalog is the OpenCode Go model list as reported by
// `opencode models`; a model that is not in it is refused before anything is spawned.
export const GO_MODELS = new Set([
  "beam-free",
  "claude-haiku-5-5",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "gemini-4-argon",
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "gpt-5.6-luna",
  "gpt-6-luna",
  "grok-4.7",
  "hy3",
  "hy4",
  "hy4-preview",
  "iceman-contributor-free",
  "kimi-k2.7-code",
  "kimi-k3",
  "kimi-k3.1-pro",
  "longcat-2.0",
  "longcat-2.5-free",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "minimax-m3",
  "minimax-m3.1-flash",
  "muse-spark-1.2-contributor",
  "muse-spark-1.3-contributor",
  "qwen3.7-plus",
  "qwen3.8-flash",
  "qwen3.8-max",
  "step-5-preview",
]);

import { PROGRESS_MODES } from "./progress.js";

const CHEAP_MODELS = ["deepseek-v4.1-flash", "muse-spark-1.3-contributor"];
// Reasoning effort values Codex advertises (codex 0.169.0 string tables list
// minimal/low/medium/high/xhigh; the Responses API rejects max/ultra-style extras on some
// providers, so anything outside this set fails here instead of at the provider).
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const OPTION_KEYS = new Set(["models", "defaultModel", "allowWorkspaceWrite", "maxTimeoutSeconds", "codexHome", "reasoningEffort", "progress", "heartbeatSeconds"]);

export function defaultOptions() {
  return {
    models: [...CHEAP_MODELS],
    defaultModel: CHEAP_MODELS[0],
    allowWorkspaceWrite: false,
    maxTimeoutSeconds: 900,
    reasoningEffort: undefined,
    progress: "concise",
    heartbeatSeconds: 10,
  };
}

function modelID(value, where) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(value)) throw new Error(`${where} must be an OpenCode Go model ID without a provider prefix`);
  if (!GO_MODELS.has(value)) throw new Error(`${where} is not an OpenCode Go model: ${value}`);
  return value;
}

function effort(value, where) {
  if (typeof value !== "string" || !REASONING_EFFORTS.includes(value)) throw new Error(`${where} must be one of: ${REASONING_EFFORTS.join(", ")}`);
  return value;
}

export function loadOptions(input) {
  const options = defaultOptions();
  if (input === undefined) return options;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("oc-dex options must be an object");
  for (const key of Object.keys(input)) if (!OPTION_KEYS.has(key)) throw new Error(`unknown option: ${key}`);
  if (input.models !== undefined) {
    if (!Array.isArray(input.models) || input.models.length === 0) throw new Error("models must contain at least one OpenCode Go model");
    options.models = [...new Set(input.models.map(value => modelID(value, "models entry")))];
    if (!options.models.includes(options.defaultModel)) options.defaultModel = options.models[0];
  }
  if (input.defaultModel !== undefined) {
    options.defaultModel = modelID(input.defaultModel, "defaultModel");
    if (!options.models.includes(options.defaultModel)) throw new Error(`defaultModel must be one of the configured models: ${options.defaultModel}`);
  }
  if (input.allowWorkspaceWrite !== undefined) {
    if (typeof input.allowWorkspaceWrite !== "boolean") throw new Error("allowWorkspaceWrite must be a boolean");
    options.allowWorkspaceWrite = input.allowWorkspaceWrite;
  }
  if (input.maxTimeoutSeconds !== undefined) {
    if (!Number.isInteger(input.maxTimeoutSeconds) || input.maxTimeoutSeconds < 1 || input.maxTimeoutSeconds > 3600) throw new Error("maxTimeoutSeconds must be an integer from 1 to 3600");
    options.maxTimeoutSeconds = input.maxTimeoutSeconds;
  }
  if (input.codexHome !== undefined) {
    if (typeof input.codexHome !== "string" || !input.codexHome.trim()) throw new Error("codexHome must be an absolute path");
    options.codexHome = input.codexHome;
  }
  if (input.reasoningEffort !== undefined) {
    // Absent means unset: the field is omitted on the wire and the server default applies.
    options.reasoningEffort = effort(input.reasoningEffort, "reasoningEffort");
  }
  if (input.progress !== undefined) {
    if (!PROGRESS_MODES.includes(input.progress)) throw new Error(`progress must be one of: ${PROGRESS_MODES.join(", ")}`);
    options.progress = input.progress;
  }
  if (input.heartbeatSeconds !== undefined) {
    // A floor of one second keeps the running indicator visibly moving; zero would be a still row.
    if (!Number.isInteger(input.heartbeatSeconds) || input.heartbeatSeconds < 1 || input.heartbeatSeconds > 300) throw new Error("heartbeatSeconds must be an integer from 1 to 300");
    options.heartbeatSeconds = input.heartbeatSeconds;
  }
  return options;
}

export function validateRun(input, options = defaultOptions()) {
  if (input === null || typeof input !== "object") throw new Error("A task prompt is required");
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("A task prompt is required");
  const model = input.model === undefined ? options.defaultModel : modelID(input.model, "model");
  if (!options.models.includes(model)) throw new Error(`model is not in the configured allowlist: ${model}`);
  const timeoutSeconds = input.timeoutSeconds === undefined ? Math.min(300, options.maxTimeoutSeconds) : input.timeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > options.maxTimeoutSeconds) throw new Error(`timeoutSeconds must be an integer from 1 to ${options.maxTimeoutSeconds}`);
  const mode = input.mode === undefined ? "read-only" : input.mode;
  if (!["read-only", "workspace-write"].includes(mode)) throw new Error("Unsupported sandbox mode");
  if (mode === "workspace-write" && !options.allowWorkspaceWrite) throw new Error("workspace-write is disabled by configuration; enable allowWorkspaceWrite to permit edits");
  if (input.threadId !== undefined && (typeof input.threadId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.threadId))) throw new Error("Invalid thread ID");
  // A per-call effort wins over the operator default; undefined on both sides stays unset.
  const reasoningEffort = input.reasoningEffort === undefined ? options.reasoningEffort : effort(input.reasoningEffort, "reasoningEffort");
  return { prompt: input.prompt, model, timeoutSeconds, mode, threadId: input.threadId, reasoningEffort };
}
