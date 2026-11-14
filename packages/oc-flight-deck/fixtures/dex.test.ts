import { describe, expect, test } from "bun:test";
import { identity, quota, readCodex, startCodexQuota } from "../src/tui/codex-quota.js";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dexPanelLines } from "../src/tui/dex-panel.js";
import { resolveConfig } from "../src/tui/config.js";

const jwt = (v: unknown) => `x.${Buffer.from(JSON.stringify(v)).toString("base64url")}.x`;
const creds = { data: [{ integrationID: "openai", active: true, value: { type: "oauth", metadata: { accountID: "account" }, access: jwt({ sub: "user" }) } }] };
const auth = { tokens: { account_id: "account", id_token: jwt({ sub: "user", email: "user@example.test" }) } };
const who = identity(creds, auth);
const account = { type: "chatgpt", email: "user@example.test", planType: "plus", workspaceName: null };
const limits = { accountId: "account", rateLimitsByLimitId: { codex: { limitId: "codex", primary: { windowDurationMins: 300, usedPercent: 20, resetsAt: 2000000000 }, secondary: { windowDurationMins: 10080, usedPercent: 40 } } } };

describe("Codex quota", () => {
  test("verifies local subjects and account before mapping exact windows", () => {
    expect(who).toBeDefined();
    expect(quota(limits, account, who)?.windows).toEqual([
      { id: "5h", ratio: 0.2, resetAtMs: 2000000000000 }, { id: "1w", ratio: 0.4 },
    ]);
    expect(identity(creds, { tokens: { ...auth.tokens, id_token: jwt({ sub: "other", email: "user@example.test" }) } })).toBeUndefined();
    expect(identity(creds, {})).toBeUndefined();
    expect(quota({ ...limits, accountId: "other" }, account, who)).toBeUndefined();
    expect(quota(limits, { ...account, workspaceName: "team" }, who)).toBeUndefined();
    expect(quota(limits, { ...account, planType: "business" }, who)).toBeUndefined();
    expect(quota(limits, { ...account, email: "other" }, who)).toBeUndefined();
    expect(quota({ ...limits, rateLimitsByLimitId: {} }, account, who)).toBeUndefined();
  });
  test("missing or invalid windows never become zero", () => {
    const bad = { ...limits, rateLimitsByLimitId: { codex: { ...limits.rateLimitsByLimitId.codex, primary: { windowDurationMins: 300, usedPercent: NaN } } } };
    expect(quota(bad, account, who)?.windows.map(w => w.id)).toEqual(["1w"]);
    const expired = { ...limits, rateLimitsByLimitId: { codex: { ...limits.rateLimitsByLimitId.codex, primary: { windowDurationMins: 300, usedPercent: 1, resetsAt: 1 } } } };
    expect(quota(expired, account, who)?.windows.map(w => w.id)).toEqual(["1w"]);
  });
  test("uses two meters and configurable section label", () => {
    expect(dexPanelLines(undefined, 0).length).toBe(3);
    expect(dexPanelLines(undefined, 0)[0]?.text).toBe("dex");
    expect(dexPanelLines(undefined, 0)[1]?.text).toContain("5h");
    expect(dexPanelLines(undefined, 0)[2]?.text).toContain("1w");
    expect(dexPanelLines(quota(limits, account, who), 0, "my quota")[0]?.text).toBe("my quota");
    expect(resolveConfig({ sidebar: { footer: { dex: true } } }).config.sidebar.footer.dex).toBe(true);
    expect(resolveConfig({ sidebar: { footer: { dex: { label: "my quota" } } } }).config.sidebar.footer.dex).toEqual({ label: "my quota" });
  });
  test("a window disappears when its reset passes while displayed", () => {
    const usage = { windows: [{ id: "5h" as const, ratio: 0.2, resetAtMs: 1000 }, { id: "1w" as const, ratio: 0.4, resetAtMs: 9000 }] };
    expect(dexPanelLines(usage, 999)[1]?.text).toContain("20%");
    expect(dexPanelLines(usage, 1000)[1]?.text).not.toContain("20%");
    expect(dexPanelLines(usage, 1000)[2]?.text).toContain("40%");
  });
  test("already-aborted missing executable cannot emit an unhandled spawn error", () => {
    const run = spawnSync(process.execPath, [join(import.meta.dir, "dex-abort-fixture.ts")], { windowsHide: true, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
  });
  test("timeout tears down the app-server process and its descendant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dex-test-"));
    const marker = join(dir, "pid");
    try {
      await readCodex(undefined, { command: process.execPath, args: [join(import.meta.dir, "dex-child-fixture.cjs"), marker], timeoutMs: 1000 });
      expect(existsSync(marker)).toBe(true);
      const pid = Number(readFileSync(marker, "utf8"));
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 10000);
  test("cancellation tears down the app-server process and its descendant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dex-test-"));
    const marker = join(dir, "pid");
    const controller = new AbortController();
    try {
      const pending = readCodex(controller.signal, { command: process.execPath, args: [join(import.meta.dir, "dex-child-fixture.cjs"), marker], timeoutMs: 5000 });
      for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
      const pid = Number(readFileSync(marker, "utf8"));
      controller.abort();
      await pending;
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 10000);
  test("launcher exit does not leave a descendant running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dex-test-"));
    const marker = join(dir, "pid");
    let pid = 0;
    try {
      await readCodex(undefined, { command: process.execPath, args: [join(import.meta.dir, "dex-child-fixture.cjs"), marker, "exit"], timeoutMs: 2000 });
      expect(existsSync(marker)).toBe(true);
      pid = Number(readFileSync(marker, "utf8"));
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally {
      if (pid) { try { process.kill(pid); } catch {} }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
  test("account switch while a poll is in flight cannot publish the old result", async () => {
    let listener: (event: unknown) => void = () => {};
    let complete: ((value: { limits: unknown; account: unknown }) => void) | undefined;
    const watcher = Object.assign(new EventEmitter(), { close() {} });
    const state = { value: null, at: 0 };
    const host = { client: { credential: { list: async () => creds } }, storage: { memory: () => [state, (fn: (v: typeof state) => void) => fn(state)] }, data: { listen: (fn: typeof listener) => { listener = fn; return () => {}; } } };
    const bridge = startCodexQuota(host, { auth: () => auth, watch: () => watcher, read: () => new Promise(resolve => { complete = resolve; }) });
    await Bun.sleep(0);
    expect(complete).toBeDefined();
    listener({ details: { type: "credential.switched" } });
    complete?.({ limits, account });
    await Bun.sleep(0);
    expect(bridge?.value).toBeUndefined();
    bridge?.dispose();
  });
  test("a watcher failure clears quota and prevents further polling", async () => {
    const watcher = Object.assign(new EventEmitter(), { close() {} });
    const state = { value: null, at: 0 };
    let calls = 0;
    const host = { client: { credential: { list: async () => creds } }, storage: { memory: () => [state, (fn: (v: typeof state) => void) => fn(state)] }, data: { listen: () => () => {} } };
    const bridge = startCodexQuota(host, { auth: () => auth, watch: () => watcher, read: async () => { calls++; return { limits, account }; }, intervalMs: 20 });
    await Bun.sleep(10);
    expect(bridge?.value).toBeDefined();
    watcher.emit("error", new Error("watch failed"));
    expect(bridge?.value).toBeUndefined();
    const before = calls;
    await Bun.sleep(50);
    expect(calls).toBe(before);
    bridge?.dispose();
  });
  test("reset invalidates the host store without a rendering tick", async () => {
    const watcher = Object.assign(new EventEmitter(), { close() {} });
    const state = { value: null, at: 0 };
    const host = { client: { credential: { list: async () => creds } }, storage: { memory: () => [state, (fn: (v: typeof state) => void) => fn(state)] }, data: { listen: () => () => {} } };
    const reset = Math.ceil(Date.now() / 1000) + 1;
    const expiring = { ...limits, rateLimitsByLimitId: { codex: { ...limits.rateLimitsByLimitId.codex, primary: { windowDurationMins: 300, usedPercent: 20, resetsAt: reset } } } };
    const bridge = startCodexQuota(host, { auth: () => auth, watch: () => watcher, read: async () => ({ limits: expiring, account }) });
    try {
      await Bun.sleep(20);
      expect(bridge?.value).toBeDefined();
      await Bun.sleep(reset * 1000 - Date.now() + 40);
      expect((state.value as { windows: { id: string }[] } | null)?.windows.map(w => w.id)).toEqual(["1w"]);
    } finally { bridge?.dispose(); }
  }, 5000);
});
