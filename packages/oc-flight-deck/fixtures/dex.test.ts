import { describe, expect, test } from "bun:test";
import { quota, readCodex, startCodexQuota } from "../src/tui/codex-quota.js";
import { statLine, statSegments } from "../src/tui/rows.js";
import { resolveConfig } from "../src/tui/config.js";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const limits = { rateLimitsByLimitId: { codex: { limitId: "codex",
  primary: { windowDurationMins: 300, usedPercent: 20, resetsAt: 2000000000 },
  secondary: { windowDurationMins: 10080, usedPercent: 40, resetsAt: 2000000000 },
} } };
const account = { type: "chatgpt", planType: "plus" };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("Codex limits", () => {
  test.skipIf(process.env.FLIGHT_DECK_LIVE_CODEX !== "1")("reads real Codex quota through its private owned server", async () => {
    const result = await readCodex();
    const usage = quota(result?.limits, result?.account);
    expect(usage?.windows.map(w => w.id)).toEqual(["5h", "1w"]);
    console.log("live Codex quota:", JSON.stringify(usage));
  }, 25000);
  test("maps only the authenticated Codex bucket, never Go or API-key usage", () => {
    expect(quota(limits, account)?.windows).toEqual([
      { id: "5h", ratio: 0.2, resetAtMs: 2000000000000 },
      { id: "1w", ratio: 0.4, resetAtMs: 2000000000000 },
    ]);
    expect(quota(limits, { type: "apiKey" })).toBeUndefined();
    expect(quota({ rateLimitsByLimitId: { other: limits.rateLimitsByLimitId.codex } }, account)).toBeUndefined();
    expect(quota({ rateLimitsByLimitId: { codex: { ...limits.rateLimitsByLimitId.codex,
      primary: { windowDurationMins: 300, usedPercent: -1 } } } }, account)?.windows.map(w => w.id)).toEqual(["1w"]);
  });
  test("uses the Go row's dials, fixed window order and spacing with a distinct label", () => {
    const usage = quota(limits, account);
    expect(statLine("dex", { dex: usage }, { nowMs: 0 })).toBe("dex       \u25d4 20 \u25d1 40");
    expect(statLine("dex", { dex: usage }, { nowMs: 2000000000000 })).toBe("dex       unavailable");
    expect(statLine("dex", {}, { persist: false })).toBe("dex       unavailable");
    expect(resolveConfig({ sidebar: { rows: ["dex"] } }).config.sidebar.rows).toEqual(["dex"]);
    expect(statLine("dex", { dex: { windows: [usage!.windows[1]] } }, { nowMs: 0 })).toBe("dex       \u2014 \u25d1 40");
    const flagged = { windows: [{ id: "5h", ratio: 0.95, resetAtMs: 2000000000000 }, usage!.windows[1]] };
    expect(statSegments("dex", { dex: flagged }, { nowMs: 0 })?.filter(s => s.tone === "error").map(s => s.text).join("")).toContain("95");
    expect(statSegments("dex", { dex: flagged }, { nowMs: 0 })?.find(s => s.text.includes("40"))?.tone).toBeUndefined();
  });
  test("proxy handshake succeeds only after its owned process exits", async () => {
    const value = await readCodex(undefined, { command: process.execPath,
      args: [join(import.meta.dir, "dex-proxy-fixture.cjs")], timeoutMs: 2000 });
    expect(value?.account).toEqual(account);
    expect(quota(value?.limits, value?.account)?.windows.length).toBe(2);
  });
  test("timeout and cancellation reap a hung proxy before resolving", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flight-deck-proxy-"));
    const pidFile = join(directory, "pid");
    const args = [join(import.meta.dir, "dex-proxy-fixture.cjs"), "hang", pidFile];
    try {
      expect(await readCodex(undefined, { command: process.execPath, args, timeoutMs: 200 })).toBeUndefined();
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      const controller = new AbortController();
      const pending = readCodex(controller.signal, { command: process.execPath, args, timeoutMs: 2000 });
      await sleep(100);
      controller.abort();
      expect(await pending).toBeUndefined();
      const secondPid = Number(readFileSync(pidFile, "utf8"));
      expect(secondPid).not.toBe(pid);
      expect(() => process.kill(secondPid, 0)).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test("missing executable and pre-aborted reads fail closed", async () => {
    expect(await readCodex(undefined, { command: "flight-deck-no-such-codex" })).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    expect(await readCodex(controller.signal, { command: "flight-deck-no-such-codex" })).toBeUndefined();
  });
  test("bridge updates host memory and aborts its in-flight read on dispose", async () => {
    const state = { value: null as ReturnType<typeof quota> | null, at: 0 };
    let calls = 0, aborted = false;
    const bridge = startCodexQuota({ storage: { memory: () => [state, (fn: (s: typeof state) => void) => fn(state)] } }, {
      intervalMs: 10,
      read: async signal => {
        if (++calls === 1) return { limits, account };
        return new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(undefined); }));
      },
    });
    await sleep(5);
    expect(bridge?.value?.windows.length).toBe(2);
    await sleep(20);
    bridge?.dispose();
    expect(aborted).toBe(true);
    expect(bridge?.value).toBeUndefined();
  });
});
