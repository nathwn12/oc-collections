import { afterAll, test, expect } from "bun:test";
import { readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCodex } from "../src/controller.js";
import { loadOptions } from "../src/config.js";

const fixture = resolve(import.meta.dir, "fixtures/server.js");
const scratch = join(import.meta.dir, "..", ".test-tmp");
mkdirSync(scratch, { recursive: true });
const base = {
  prompt: "test",
  timeoutSeconds: 3,
  mode: "read-only",
  cwd: import.meta.dir,
  apiKey: "test-key",
  executable: process.execPath,
  argsOverride: [fixture],
  codexHome: join(scratch, "codex-home"),
};

let counter = 0;
function paths() {
  const id = ++counter;
  return { log: join(scratch, `frames-${id}.jsonl`), pid: join(scratch, `pid-${id}.txt`) };
}

function frames(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function wire(mode, extra = {}) {
  const p = paths();
  return { ...p, input: { ...base, extraEnv: { FIXTURE_LOG: p.log, FIXTURE_PID_FILE: p.pid, ...(mode ? { FIXTURE_MODE: mode } : {}), ...extra } } };
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("streams progress, returns final result and resumes an existing thread", async () => {
  const { input, log } = wire();
  const events = [];
  const result = await runCodex({ ...input, threadId: "previous" }, event => events.push(event));
  expect(result.threadId).toBe("previous");
  expect(result.status).toBe("completed");
  expect(result.text).toBe("Working");
  expect(events.some(event => event.type === "text")).toBe(true);

  const sent = frames(log);
  const resume = sent.find(f => f.method === "thread/resume");
  expect(resume.params.threadId).toBe("previous");
  expect(resume.params.modelProvider).toBe("opencode-go");
  expect(resume.params.model).toBe("deepseek-v4.1-flash");
});

test("starts a thread against the Go provider in the requested sandbox", async () => {
  const { input, log } = wire();
  await runCodex(input);
  const start = frames(log).find(f => f.method === "thread/start");
  expect(start.params.modelProvider).toBe("opencode-go");
  expect(start.params.sandbox).toBe("read-only");
  expect(start.params.approvalPolicy).toBe("never");
});

test("pins every turn to an explicit bounded sandbox policy", async () => {
  const readOnly = wire();
  await runCodex(readOnly.input);
  const readTurn = frames(readOnly.log).find(f => f.method === "turn/start");
  expect(readTurn.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });

  const write = wire();
  const options = loadOptions({ allowWorkspaceWrite: true });
  await runCodex({ ...write.input, mode: "workspace-write" }, () => {}, options);
  const writeTurn = frames(write.log).find(f => f.method === "turn/start");
  expect(writeTurn.params.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: [import.meta.dir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: false });
});

test("refuses workspace-write when the Windows sandbox is not ready", async () => {
  const { input, log } = wire(null, { FIXTURE_READINESS: "notConfigured" });
  const options = loadOptions({ allowWorkspaceWrite: true });
  const result = await runCodex({ ...input, mode: "workspace-write" }, () => {}, options);
  expect(result.status).toBe("failed");
  expect(result.error).toMatch(/sandbox/i);
  expect(frames(log).some(f => f.method === "turn/start")).toBe(false);
});

test("still runs read-only work when the Windows sandbox is not ready", async () => {
  const { input } = wire(null, { FIXTURE_READINESS: "notConfigured" });
  const result = await runCodex(input);
  expect(result.status).toBe("completed");
});

test("declines approval requests and reports that it did", async () => {
  const { input, log } = wire("approval");
  const result = await runCodex(input);
  expect(result.status).toBe("completed");
  expect(result.deniedApprovals).toBe(1);
  const refusal = frames(log).find(f => f.id === 900);
  expect(refusal.result).toEqual({ decision: "decline" });
});

test("times out, interrupts the turn, and leaves no child process behind", async () => {
  const { input, pid } = wire("hang");
  const result = await runCodex({ ...input, timeoutSeconds: 1 });
  expect(result.status).toBe("timeout");
  const child = Number(readFileSync(pid, "utf8"));
  expect(alive(child)).toBe(false);
});

test("cancels its child on abort and leaves no child process behind", async () => {
  const { input, pid } = wire("hang");
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 250);
  const result = await runCodex({ ...input, signal: abort.signal });
  expect(result.status).toBe("cancelled");
  const child = Number(readFileSync(pid, "utf8"));
  expect(alive(child)).toBe(false);
});

test("surfaces stderr in the failure message without leaking the key", async () => {
  const { input } = wire("stderr", { FIXTURE_MODE: "stderr" });
  const result = await runCodex({ ...input, prompt: "test", timeoutSeconds: 1 });
  expect(result.status).toBe("failed");
  expect(result.error).toMatch(/fixture boom/);
  expect(result.error).not.toContain("test-key");
});

test("fails on malformed protocol output and tears the child down", async () => {
  const { input, pid } = wire("bad-json");
  const result = await runCodex(input);
  expect(result.status).toBe("failed");
  expect(result.error).toMatch(/protocol/);
  const child = Number(readFileSync(pid, "utf8"));
  expect(alive(child)).toBe(false);
});

test("redacts a credential containing regex metacharacters without mangling the text", async () => {
  const { input } = wire("stderr", { FIXTURE_MODE: "stderr" });
  const result = await runCodex({ ...input, apiKey: "a+b.c(d)", timeoutSeconds: 1 });
  expect(result.error).toContain("[REDACTED]");
  expect(result.error).not.toContain("a+b.c(d)");
});

test("never puts the credential in the child argv", async () => {
  const { input, log } = wire();
  await runCodex(input);
  const start = frames(log).find(f => f.method === "thread/start");
  expect(JSON.stringify(start)).not.toContain("test-key");
});

test("sends an explicit reasoning effort on turn/start", async () => {
  const { input, log } = wire();
  await runCodex({ ...input, reasoningEffort: "xhigh" });
  const turn = frames(log).find(f => f.method === "turn/start");
  expect(turn.params.effort).toBe("xhigh");
});

test("a resumed thread still gets the per-turn effort override, and the thread frames carry none", async () => {
  const { input, log } = wire();
  await runCodex({ ...input, threadId: "previous", reasoningEffort: "xhigh" });
  const resume = frames(log).find(f => f.method === "thread/resume");
  expect("effort" in (resume.params ?? {})).toBe(false);
  const turn = frames(log).find(f => f.method === "turn/start");
  expect(turn.params.effort).toBe("xhigh");
});

test("omits the effort field entirely when no reasoning effort is selected", async () => {
  const { input, log } = wire();
  await runCodex(input);
  const start = frames(log).find(f => f.method === "thread/start");
  expect("effort" in (start.params ?? {})).toBe(false);
  const turn = frames(log).find(f => f.method === "turn/start");
  expect("effort" in (turn.params ?? {})).toBe(false);
});
