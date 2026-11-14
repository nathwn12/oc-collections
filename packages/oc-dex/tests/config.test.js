import { test, expect } from "bun:test";
import { GO_MODELS, defaultOptions, loadOptions, validateRun } from "../src/config.js";

test("ships the two cheap Go models as the default allowlist", () => {
  const options = defaultOptions();
  expect(options.models).toEqual(["deepseek-v4.1-flash", "muse-spark-1.3-contributor"]);
  expect(options.defaultModel).toBe("deepseek-v4.1-flash");
  expect(options.allowWorkspaceWrite).toBe(false);
  expect(validateRun({ prompt: "inspect" }, options).model).toBe("deepseek-v4.1-flash");
});

test("accepts a configured Go model with default reasoning and bounded workspace", () => {
  const options = loadOptions({ models: ["muse-spark-1.3-contributor"], defaultModel: "muse-spark-1.3-contributor" });
  const run = validateRun({ prompt: "inspect" }, options);
  expect(run.model).toBe("muse-spark-1.3-contributor");
  expect(run.timeoutSeconds).toBe(300);
  expect(run.mode).toBe("read-only");
});

test("refuses anything that is not a Go model", () => {
  const options = defaultOptions();
  expect(() => validateRun({ prompt: "x", model: "openai/gpt-6.1-sol" }, options)).toThrow(/Go model/);
  expect(() => validateRun({ prompt: "x", model: "gpt-6.1-sol" }, options)).toThrow(/Go model/);
  expect(GO_MODELS.has("deepseek-v4.1-flash")).toBe(true);
  expect(GO_MODELS.has("gpt-6.1-sol")).toBe(false);
});

test("fails closed on a real Go model that is outside the configured allowlist", () => {
  const options = defaultOptions();
  expect(GO_MODELS.has("glm-5.3")).toBe(true);
  expect(() => validateRun({ prompt: "x", model: "glm-5.3" }, options)).toThrow(/allowlist/);
});

test("refuses workspace-write unless the operator opts in", () => {
  const options = defaultOptions();
  expect(() => validateRun({ prompt: "x", mode: "workspace-write" }, options)).toThrow(/workspace-write/);
  const allowed = loadOptions({ allowWorkspaceWrite: true });
  expect(validateRun({ prompt: "x", mode: "workspace-write" }, allowed).mode).toBe("workspace-write");
});

test("clamps the deadline to the configured ceiling and rejects nonsense", () => {
  const options = loadOptions({ maxTimeoutSeconds: 60 });
  expect(() => validateRun({ prompt: "x", timeoutSeconds: 61 }, options)).toThrow(/timeoutSeconds/);
  expect(() => validateRun({ prompt: "x", timeoutSeconds: 0 }, options)).toThrow(/timeoutSeconds/);
  expect(validateRun({ prompt: "x", timeoutSeconds: 60 }, options).timeoutSeconds).toBe(60);
});

test("loadOptions rejects a model that is not in the Go catalog", () => {
  expect(() => loadOptions({ models: ["deepseek-v4.1-flash", "gpt-6.1-sol"] })).toThrow(/Go model/);
  expect(() => loadOptions({ models: [] })).toThrow(/at least one/);
});

test("loadOptions rejects a default that is not in the allowlist", () => {
  expect(() => loadOptions({ models: ["muse-spark-1.3-contributor"], defaultModel: "glm-5.3" })).toThrow(/defaultModel/);
  expect(loadOptions({ models: ["muse-spark-1.3-contributor"] }).defaultModel).toBe("muse-spark-1.3-contributor");
});

test("loadOptions rejects unknown option keys so a typo cannot silently widen the allowlist", () => {
  expect(() => loadOptions({ model: "muse-spark-1.3-contributor" })).toThrow(/unknown option/);
});

test("validateRun rejects an unusable thread ID and a blank prompt", () => {
  const options = defaultOptions();
  expect(() => validateRun({ prompt: "  " }, options)).toThrow(/prompt/);
  expect(() => validateRun({ prompt: "x", threadId: "../escape" }, options)).toThrow(/thread/);
});

test("defaults the progress display to concise and a heartbeat that keeps it moving", () => {
  const options = defaultOptions();
  expect(options.progress).toBe("concise");
  expect(options.heartbeatSeconds).toBe(10);
});

test("accepts a progress mode and a heartbeat inside the movement floor", () => {
  expect(loadOptions({ progress: "quiet" }).progress).toBe("quiet");
  expect(loadOptions({ progress: "detailed" }).progress).toBe("detailed");
  expect(loadOptions({ heartbeatSeconds: 1 }).heartbeatSeconds).toBe(1);
  expect(loadOptions({ heartbeatSeconds: 300 }).heartbeatSeconds).toBe(300);
});

test("refuses a progress mode it cannot render and a heartbeat that stops movement", () => {
  expect(() => loadOptions({ progress: "loud" })).toThrow(/progress/);
  expect(() => loadOptions({ progress: true })).toThrow(/progress/);
  expect(() => loadOptions({ heartbeatSeconds: 0 })).toThrow(/heartbeatSeconds/);
  expect(() => loadOptions({ heartbeatSeconds: 301 })).toThrow(/heartbeatSeconds/);
  expect(() => loadOptions({ heartbeatSeconds: 1.5 })).toThrow(/heartbeatSeconds/);
});

test("leaves reasoning effort unset by default so the server default applies", () => {
  expect(defaultOptions().reasoningEffort).toBeUndefined();
  expect(validateRun({ prompt: "inspect" }, defaultOptions()).reasoningEffort).toBeUndefined();
});

test("accepts an explicit Codex reasoning effort and lets the call override the operator default", () => {
  const options = loadOptions({ reasoningEffort: "xhigh" });
  expect(options.reasoningEffort).toBe("xhigh");
  expect(validateRun({ prompt: "inspect" }, options).reasoningEffort).toBe("xhigh");
  expect(validateRun({ prompt: "inspect", reasoningEffort: "low" }, options).reasoningEffort).toBe("low");
  expect(validateRun({ prompt: "inspect", reasoningEffort: "xhigh" }, defaultOptions()).reasoningEffort).toBe("xhigh");
});

test("fails closed on a reasoning effort Codex does not advertise", () => {
  expect(() => loadOptions({ reasoningEffort: "ultra" })).toThrow(/reasoning/i);
  expect(() => loadOptions({ reasoningEffort: "" })).toThrow(/reasoning/i);
  expect(() => loadOptions({ reasoningEffort: null })).toThrow(/reasoning/i);
  expect(() => validateRun({ prompt: "x", reasoningEffort: "turbo" }, defaultOptions())).toThrow(/reasoning/i);
  expect(() => validateRun({ prompt: "x", reasoningEffort: "" }, defaultOptions())).toThrow(/reasoning/i);
});
