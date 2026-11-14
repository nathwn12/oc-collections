import { test, expect } from "bun:test";
import { PROGRESS_MODES, progressPolicy, formatProgress } from "../src/progress.js";

const at = 10_500;

test("defaults to the concise mode, the leanest one that still ticks", () => {
  expect(PROGRESS_MODES).toEqual(["quiet", "concise", "detailed"]);
  expect(progressPolicy().detail).toBe(false);
  expect(progressPolicy().onEvent).toBe(true);
  expect(progressPolicy().model).toBe(false);
});

test("an unknown mode is refused rather than silently guessed", () => {
  expect(() => progressPolicy("loud")).toThrow(/progress/);
});

test("concise keeps the payload to a phase and the elapsed clock", () => {
  const update = formatProgress({ startedAt: 0, at, stage: "Codex is running", detail: "thread 1234abcd", model: "deepseek-v4.1-flash" });
  expect(update.title).toBe("oc-dex");
  expect(update.status).toBe("Codex is running · 10s");
  expect(update.status).not.toContain("thread");
  expect(update.stage).toBe("Codex is running");
  expect(update.elapsedSeconds).toBe(10);
});

test("quiet keeps the clock but carries no detail and no model", () => {
  const update = formatProgress({ mode: "quiet", startedAt: 0, at, stage: "Codex is running", detail: "thread 1234abcd", model: "deepseek-v4.1-flash" });
  expect(update.title).toBe("oc-dex");
  expect(update.status).toBe("Codex is running · 10s");
  expect(progressPolicy("quiet").onEvent).toBe(false);
});

test("detailed adds the model and the moving detail", () => {
  const update = formatProgress({ mode: "detailed", startedAt: 0, at, stage: "running", detail: "thread 1234abcd", model: "deepseek-v4.1-flash" });
  expect(update.title).toBe("oc-dex · deepseek-v4.1-flash");
  expect(update.status).toBe("running · thread 1234abcd · 10s");
});

test("a blank stage falls back, and detail is flattened and capped", () => {
  const silent = formatProgress({ startedAt: 0, at, stage: "   ", model: "m" });
  expect(silent.status).toBe("starting · 10s");
  const noisy = formatProgress({ mode: "detailed", startedAt: 0, at, stage: "running", detail: `a\n\nb  ${"x".repeat(400)}`, model: "m" });
  expect(noisy.status).toContain("a b ");
  expect(noisy.status.length).toBeLessThan(160);
});

test("the elapsed clock never runs backwards and never repeats its suffix", () => {
  const early = formatProgress({ startedAt: 5_000, at: 1_000, stage: "running" });
  expect(early.elapsedSeconds).toBe(0);
  const update = formatProgress({ mode: "detailed", startedAt: 0, at, stage: "running", detail: "12s", model: "m" });
  expect(update.status.match(/\d+s/g)).toEqual(["12s", "10s"]);
});
