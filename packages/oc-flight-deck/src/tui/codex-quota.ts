import { spawn } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { GoUsage, GoWindow } from "./go-usage.js";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
function claims(token: unknown): RecordValue {
  try {
    if (typeof token !== "string" || token.length > 65536) return {};
    return record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()));
  } catch { return {}; }
}

/** Compare identities only in memory. JWTs are decoded, not signature-verified. */
export function identity(credentials: unknown, auth: unknown): { account: string; subject: string; email: string } | undefined {
  const outer = record(credentials).data;
  const list = Array.isArray(outer) ? outer : record(outer).data;
  if (!Array.isArray(list)) return;
  const entries = list.filter((v) => record(v).integrationID === "openai" && record(v).active === true);
  if (entries.length !== 1) return;
  const value = record(record(entries[0]).value);
  const tokens = record(record(auth).tokens);
  const account = record(value.metadata).accountID;
  const subject = claims(value.access).sub;
  const codex = claims(tokens.id_token);
  if (value.type !== "oauth" || typeof account !== "string" || !account ||
      account !== tokens.account_id || typeof subject !== "string" || !subject ||
      subject !== codex.sub || typeof codex.email !== "string" || !codex.email) return;
  return { account, subject, email: codex.email };
}

export function quota(result: unknown, account: unknown, id: ReturnType<typeof identity>): GoUsage | undefined {
  const r = record(result), a = record(account);
  if (!id || r.accountId !== id.account || a.type !== "chatgpt" || !["plus", "pro"].includes(String(a.planType)) ||
      a.email !== id.email || a.workspaceName != null) return;
  const buckets = record(r.rateLimitsByLimitId);
  const bucket = record(buckets.codex);
  if (bucket.limitId !== "codex") return;
  const windows = [record(bucket.primary), record(bucket.secondary)];
  const format = (mins: number, name: GoWindow["id"]): GoWindow | undefined => {
    const matches = windows.filter(w => w.windowDurationMins === mins);
    const v = matches[0]?.usedPercent;
    if (matches.length !== 1 || typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) return;
    const reset = matches[0]?.resetsAt;
    if (typeof reset === "number" && Number.isFinite(reset) && reset > 0 && reset * 1000 <= Date.now()) return;
    return { id: name, ratio: v / 100, ...(typeof reset === "number" && Number.isFinite(reset) && reset > 0 ? { resetAtMs: reset * 1000 } : {}) };
  };
  return { windows: [format(300, "5h"), format(10080, "1w")].filter((v): v is GoWindow => v !== undefined) };
}

interface Host {
  client: { credential: { list(): Promise<unknown> } };
  storage: { memory(key: string, options: { initial: { value: GoUsage | null; at: number } }): unknown };
  data: { listen(fn: (event: unknown) => void): () => void };
}

/** One bounded stdio request; no raw output or stderr is logged. */
export function readCodex(signal?: AbortSignal, options: { command?: string; args?: string[]; timeoutMs?: number } = {}): Promise<{ limits: unknown; account: unknown } | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(options.command ?? "codex", options.args ?? ["app-server"], { windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"] }); }
    catch { resolve(undefined); return; }
    let done = false, bytes = 0, limits: unknown, account: unknown, store: unknown;
    const finish = (result?: { limits: unknown; account: unknown }) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      const pid = child.pid;
      if (!pid) { resolve(result); return; }
      if (process.platform !== "win32") {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
        child.stdin?.destroy(); resolve(result);
        return;
      }
      try {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        let settled = false;
        const complete = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(killTimer); if (!ok) child.kill(); child.stdin?.destroy(); resolve(ok ? result : undefined); } };
        const killTimer = setTimeout(() => { killer.kill(); complete(false); }, 5000);
        killer.on("error", () => complete(false));
        killer.on("exit", code => complete(code === 0));
      } catch { child.kill(); child.stdin?.destroy(); resolve(undefined); }
    };
    const abort = () => finish();
    const timer = setTimeout(() => finish(), options.timeoutMs ?? 15000);
    child.on("error", () => finish());
    child.on("exit", () => finish());
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return finish();
    if (!child.stdout || !child.stdin) return finish();
    const stdout = child.stdout, stdin = child.stdin;
    stdin.on("error", () => finish());
    stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 262144) finish(); });
    const send = (v: unknown) => { if (!done) stdin.write(JSON.stringify(v) + "\n"); };
    createInterface({ input: stdout }).on("line", line => {
      try {
        const m = record(JSON.parse(line));
        if (m.error && (m.id === 0 || m.id === 1 || m.id === 2 || m.id === 3)) return finish();
        if (m.id === 0 && m.result) {
          send({ method: "initialized", params: {} });
          send({ id: 1, method: "account/rateLimits/read" });
          send({ id: 2, method: "account/read", params: { refreshToken: false } });
          send({ id: 3, method: "config/read", params: {} });
        }
        if (m.id === 1) limits = m.result;
        if (m.id === 2) account = record(m.result).account;
        if (m.id === 3) store = record(record(m.result).config).cli_auth_credentials_store;
        if (store !== undefined && store !== "file") return finish();
        if (limits && account && store === "file") finish({ limits, account });
      } catch { finish(); }
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "flight_deck", version: "1.0.0" } } });
  });
}

export function startCodexQuota(host: Host, deps: {
  auth?: () => unknown;
  watch?: (invalidate: () => void) => { on(event: "error", listener: () => void): unknown; close(): void };
  read?: (signal: AbortSignal) => Promise<{ limits: unknown; account: unknown } | undefined>;
  intervalMs?: number;
} = {}) {
  const opened = host.storage.memory("flight-deck.codex-quota", { initial: { value: null, at: 0 } });
  if (!Array.isArray(opened) || typeof opened[1] !== "function") return;
  const [store, update] = opened as [{ value: GoUsage | null; at: number }, (fn: (draft: { value: GoUsage | null; at: number }) => void) => void];
  const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  let generation = 0, disposed = false, running = false, watching = true, controller: AbortController | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReset = (value: GoUsage | null) => {
    if (resetTimer) clearTimeout(resetTimer);
    const resets = value?.windows.flatMap(w => w.resetAtMs === undefined ? [] : [w.resetAtMs]) ?? [];
    if (!resets.length) return;
    const delay = Math.min(2147483647, Math.max(1, Math.min(...resets) - Date.now()));
    resetTimer = setTimeout(() => {
      if (disposed) return;
      const remaining = store.value?.windows.filter(w => w.resetAtMs === undefined || w.resetAtMs > Date.now()) ?? [];
      const next = remaining.length ? { windows: remaining } : null;
      update(draft => { draft.value = next; });
      scheduleReset(next);
    }, delay);
  };
  const set = (value: GoUsage | null) => {
    if (staleTimer) clearTimeout(staleTimer);
    update(draft => { draft.value = value; draft.at = value ? Date.now() : 0; });
    scheduleReset(value);
    if (value) staleTimer = setTimeout(() => { if (!disposed) set(null); }, 90000);
  };
  const invalidate = () => { generation++; controller?.abort(); set(null); };
  const readAuth = deps.auth ?? (() => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } });
  const poll = async () => {
    if (disposed || running || !watching) return;
    running = true; invalidate(); const epoch = generation; controller = new AbortController();
    const bounded = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error("timeout")), 6000); p.finally(() => clearTimeout(t)).catch(() => {}); })]);
    try {
      const first = identity(await bounded(host.client.credential.list()), readAuth());
      if (!first) return;
      const result = await (deps.read ?? readCodex)(controller.signal);
      const second = identity(await bounded(host.client.credential.list()), readAuth());
      if (disposed || epoch !== generation || !result || !second ||
          first.account !== second.account || first.subject !== second.subject || first.email !== second.email) return;
      set(quota(result.limits, result.account, second) ?? null);
    } catch { /* unavailable */ }
    finally { running = false; }
  };
  let watcher: { on(event: "error", listener: () => void): unknown; close(): void };
  try { watcher = deps.watch ? deps.watch(invalidate) : watch(join(path, ".."), (_event, filename) => { if (!filename || ["auth.json", "config.toml"].includes(filename.toString())) invalidate(); }); }
  catch { return; }
  watcher.on("error", () => { watching = false; invalidate(); });
  const stop = host.data.listen(event => {
    const type = record(record(event).details).type;
    if (type === "credential.updated" || type === "credential.switched") invalidate();
  });
  void poll();
  const timer = setInterval(() => { void poll(); }, deps.intervalMs ?? 60000);
  return { get value() { return Date.now() - store.at <= 90000 ? store.value ?? undefined : undefined; }, dispose() { disposed = true; invalidate(); clearInterval(timer); watcher.close(); stop(); } };
}
