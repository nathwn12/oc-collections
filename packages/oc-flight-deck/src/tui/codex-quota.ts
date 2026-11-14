import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { GoUsage, GoWindow } from "./go-usage.js";
import { ownedProcess } from "./owned-process.js";

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Codex's authenticated account, not the OpenCode Go provider's allowance. */
export function quota(limits: unknown, account: unknown): GoUsage | undefined {
  if (record(account).type !== "chatgpt") return;
  const bucket = record(record(record(limits).rateLimitsByLimitId).codex);
  if (bucket.limitId !== "codex") return;
  const source = [record(bucket.primary), record(bucket.secondary)];
  const windows: GoWindow[] = [];
  for (const [minutes, id] of [[300, "5h"], [10080, "1w"]] as const) {
    const matches = source.filter(w => w.windowDurationMins === minutes);
    if (matches.length !== 1) continue;
    const { usedPercent: used, resetsAt: reset } = matches[0]!;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) continue;
    if (typeof reset !== "number" || !Number.isFinite(reset) || reset * 1000 <= Date.now()) continue;
    windows.push({ id, ratio: used / 100, resetAtMs: reset * 1000 });
  }
  return windows.length ? { windows } : undefined;
}

/** Bypass Scoop's launcher: ownership must refer to the native proxy itself. */
export function executable(pathValue = process.env.PATH ?? ""): string | undefined {
  for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    if (!existsSync(path)) continue;
    if (process.platform === "win32") {
      const shim = path.replace(/\.exe$/i, ".shim");
      if (existsSync(shim)) {
        try {
          const target = /^path\s*=\s*"([^"\r\n]+)"\s*$/m.exec(readFileSync(shim, "utf8"))?.[1];
          if (target && isAbsolute(target) && /[\\/]codex\.exe$/i.test(target) && existsSync(target)) return target;
        } catch { /* not a supported native installation */ }
        return;
      }
    }
    return path;
  }
}

/**
 * Windows uses a private stdio server enclosed in an owned Job Object.
 * Other platforms connect to the existing daemon. Never read OAuth files,
 * create threads, or kill a PID tree. Resolve only after the owned process closes.
 */
export function readCodex(signal?: AbortSignal, options: {
  command?: string; args?: string[]; timeoutMs?: number;
} = {}): Promise<{ limits: unknown; account: unknown } | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  const command = options.command ?? executable();
  if (!command) return Promise.resolve(undefined);
  const launch = options.command
    ? { command, args: options.args ?? ["app-server", "proxy"] }
    : process.platform === "win32"
      ? ownedProcess(command, ["app-server", "--stdio"])
      : { command, args: ["app-server", "proxy"] };
  return new Promise(resolve => {
    const child = spawn(launch.command, launch.args, {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    let finishing = false, bytes = 0, limits: unknown, account: unknown;
    let result: { limits: unknown; account: unknown } | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: typeof result) => {
      if (finishing) return;
      finishing = true;
      result = value;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.stdin.end();
      // A hung proxy is the exact child handle, never a launcher or PID tree.
      killTimer = setTimeout(() => { result = undefined; child.kill("SIGKILL"); }, 500);
    };
    const abort = () => finish();
    const timer = setTimeout(() => finish(), options.timeoutMs ?? 15000);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish());
    child.stdin.on("error", () => finish());
    child.on("close", code => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      resolve(code === 0 ? result : undefined);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 262144) finish();
    });
    const send = (message: unknown) => {
      if (!finishing) child.stdin.write(JSON.stringify(message) + "\n");
    };
    createInterface({ input: child.stdout }).on("line", line => {
      if (finishing) return;
      try {
        const message = record(JSON.parse(line));
        if (message.error) return finish();
        if (message.id === 0 && message.result) {
          send({ method: "initialized", params: {} });
          send({ id: 1, method: "account/rateLimits/read" });
          send({ id: 2, method: "account/read", params: { refreshToken: false } });
        }
        if (message.id === 1) limits = message.result;
        if (message.id === 2) account = record(message.result).account;
        if (limits && account) finish({ limits, account });
      } catch { finish(); }
    });
    if (signal?.aborted) finish();
    else send({ id: 0, method: "initialize", params: {
      clientInfo: { name: "flight_deck", version: "1.0.0" },
    } });
  });
}

interface State { value: GoUsage | null; at: number }
interface Host { storage: { memory(key: string, options: { initial: State }): unknown } }

export function startCodexQuota(host: Host, deps: {
  read?: (signal: AbortSignal) => ReturnType<typeof readCodex>; intervalMs?: number;
} = {}) {
  const opened = host.storage?.memory?.("flight-deck.codex-quota", { initial: { value: null, at: 0 } });
  if (!Array.isArray(opened) || typeof opened[1] !== "function") return;
  const [state, update] = opened as [State, (fn: (draft: State) => void) => void];
  let disposed = false, running = false, controller: AbortController | undefined;
  const clear = () => update(draft => { draft.value = null; draft.at = 0; });
  clear();
  const poll = async () => {
    if (disposed || running) return;
    running = true;
    controller = new AbortController();
    try {
      const result = await (deps.read ?? readCodex)(controller.signal);
      if (disposed) return;
      const value = result ? quota(result.limits, result.account) : undefined;
      update(draft => { draft.value = value ?? null; draft.at = value ? Date.now() : 0; });
    } catch { if (!disposed) clear(); }
    finally { running = false; }
  };
  void poll();
  const timer = setInterval(() => { void poll(); }, deps.intervalMs ?? 60000);
  return {
    get value() { return !disposed && Date.now() - state.at <= 90000 ? state.value ?? undefined : undefined; },
    dispose() { disposed = true; controller?.abort(); clearInterval(timer); clear(); },
  };
}
