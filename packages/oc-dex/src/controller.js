import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { validateRun, defaultOptions } from "./config.js";

const PROVIDER = "opencode-go";
const KEY_ENV = "OPENCODE_API_KEY";
const STDERR_LIMIT = 8000;
const KILL_GRACE_MS = 3000;

// Documented Codex app-server methods that ask a client for approval. Every one of them is
// answered with the documented "deny" payload; oc-dex never grants an escalation.
const DENIALS = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  execCommandApproval: { decision: "declined" },
  applyPatchApproval: { decision: "declined" },
  "item/permissions/requestApproval": { permissions: { fileSystem: null, network: null } },
};

function codexArgs() {
  return [
    "app-server",
    "-c", `model_provider="${PROVIDER}"`,
    "-c", `model_providers.${PROVIDER}.name="OpenCode Go"`,
    "-c", `model_providers.${PROVIDER}.base_url="https://opencode.ai/inference/go/openai/v1"`,
    "-c", `model_providers.${PROVIDER}.env_key="${KEY_ENV}"`,
    "-c", `model_providers.${PROVIDER}.wire_api="responses"`,
    "-c", `model_providers.${PROVIDER}.requires_openai_auth=false`,
    // The credential must never reach a shell Codex spawns: no login shell, and an explicit
    // exclusion on top of Codex's default KEY/SECRET/TOKEN filters.
    "-c", 'shell_environment_policy.inherit="core"',
    "-c", 'shell_environment_policy.ignore_default_excludes=false',
    "-c", `shell_environment_policy.filters.${KEY_ENV}="exclude"`,
    "-c", "allow_login_shell=false",
    ...(process.platform === "win32" ? ["-c", 'windows.sandbox="mxc"'] : []),
  ];
}

const ENV_ALLOW = ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"];

function childEnv(home, apiKey, extra) {
  const env = Object.fromEntries(ENV_ALLOW.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  Object.assign(env, { CODEX_HOME: home, [KEY_ENV]: apiKey }, extra);
  return env;
}

function sandboxPolicy(run, cwd) {
  if (run.mode === "workspace-write") return { type: "workspaceWrite", writableRoots: [resolve(cwd)], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: false };
  return { type: "readOnly", networkAccess: false };
}

export async function runCodex(input, progress = () => {}, options = defaultOptions()) {
  const run = validateRun(input, options);
  if (!input.cwd || !input.apiKey) throw new Error("Workspace and OpenCode Go credential are required");
  const cwd = resolve(input.cwd);
  const home = input.codexHome ?? options.codexHome ?? join(process.env.LOCALAPPDATA || tmpdir(), "oc-dex", "codex-home");
  mkdirSync(home, { recursive: true });
  if (input.signal?.aborted) return { status: "cancelled", threadId: run.threadId, text: "", deniedApprovals: 0 };

  const key = input.apiKey;
  const redact = value => (key ? String(value ?? "").split(key).join("[REDACTED]") : String(value ?? ""));
  const emit = event => { try { progress(event); } catch {} };

  const child = spawn(input.executable ?? (process.platform === "win32" ? "codex.exe" : "codex"), input.argsOverride ?? codexArgs(), {
    cwd,
    env: childEnv(home, key, input.argsOverride ? input.extraEnv : undefined),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const exited = new Promise(done => child.on("exit", (code, signal) => done({ code, signal })));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });

  let settled = false;
  let tearingDown = false;
  let threadId = run.threadId;
  let turnId;
  let text = "";
  let denied = 0;
  let sequence = 0;
  const pending = new Map();
  let resolveFinished;
  const finished = new Promise(done => { resolveFinished = done; });

  const interrupt = () => new Promise(done => {
    if (!threadId || !turnId || !child.stdin.writable) return done();
    const id = ++sequence;
    const timer = setTimeout(done, 500);
    pending.set(id, { resolve: () => { clearTimeout(timer); done(); }, reject: () => { clearTimeout(timer); done(); } });
    child.stdin.write(JSON.stringify({ id, method: "turn/interrupt", params: { threadId, turnId } }) + "\n", () => {});
  });

  // Kill the whole process tree and wait until the child is really gone. Resolves only after
  // 'exit' fires or the grace window closes, so a caller can never observe a live orphan.
  const teardown = async () => {
    if (tearingDown) return exited;
    tearingDown = true;
    child.stdin.end();
    if (child.pid) {
      if (process.platform === "win32") {
        await new Promise(done => {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", done);
          killer.on("exit", done);
        });
      } else child.kill("SIGKILL");
    }
    await Promise.race([exited, new Promise(done => setTimeout(done, KILL_GRACE_MS))]);
    return exited;
  };

  const finish = async (status, error, extra = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    for (const entry of pending.values()) entry.reject(new Error("Codex process ended"));
    pending.clear();
    if (status === "timeout" || status === "cancelled") await interrupt();
    await teardown();
    const detail = error ? redact(error) : undefined;
    resolveFinished({ status, threadId, text, deniedApprovals: denied, ...(detail ? { error: detail } : {}), ...extra });
  };

  const abort = () => { void finish("cancelled"); };
  const timer = setTimeout(() => { void finish("timeout"); }, run.timeoutSeconds * 1000);
  input.signal?.addEventListener("abort", abort, { once: true });

  const send = (method, params) => new Promise((res, rej) => {
    if (settled) return rej(new Error("Codex process ended"));
    const id = ++sequence;
    pending.set(id, { resolve: res, reject: rej });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => {
      if (error) { pending.delete(id); rej(error); }
    });
  });

  child.on("error", error => { void finish("failed", error.message); });
  child.on("exit", (code, signal) => {
    if (settled) return;
    const tail = stderr.trim();
    void finish("failed", `Codex exited before completing (code ${code}, signal ${signal})${tail ? `: ${tail}` : ""}`);
  });

  createInterface({ input: child.stdout }).on("line", line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { void finish("failed", "Codex returned invalid protocol output"); return; }
    if (message.id !== undefined && message.method) {
      const refusal = DENIALS[message.method];
      denied += 1;
      const payload = refusal ? { id: message.id, result: refusal } : { id: message.id, error: { code: -32601, message: "oc-dex denies approval requests" } };
      child.stdin.write(JSON.stringify(payload) + "\n", () => {});
      emit({ type: "approval-denied", method: message.method });
      return;
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(redact(message.error.message)));
      else entry.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    const scopeID = params.threadId;
    if (scopeID && threadId && scopeID !== threadId) return;
    if (message.method === "item/agentMessage/delta") {
      const delta = redact(params.delta);
      text += delta;
      emit({ type: "text", text: delta });
    } else if (message.method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item.text === "string") {
      text = redact(params.item.text);
    } else if (message.method === "item/started" || message.method === "item/completed") {
      emit({ type: "activity", status: String(params.item?.type ?? message.method) });
    } else if (message.method === "turn/started") {
      turnId = params.turn?.id ?? turnId;
      emit({ type: "turn", turnId });
    } else if (message.method === "turn/completed") {
      const turn = params.turn ?? {};
      if (turn.id && turnId && turn.id !== turnId) return;
      const ok = turn.status === "completed";
      void finish(ok ? "completed" : "failed", ok ? undefined : (turn.error?.message || `Codex turn ${turn.status}`));
    } else if (message.method === "error") {
      emit({ type: "warning", status: redact(params.message ?? params.error?.message ?? "Codex error") });
    }
  });

  emit({ type: "status", status: "Starting Codex" });
  void (async () => {
    try {
      await send("initialize", { clientInfo: { name: "oc_dex", title: "oc-dex", version: "0.1.0" }, capabilities: { experimentalApi: false } });
      child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      if (process.platform === "win32") {
        try {
          const readiness = await send("windowsSandbox/readiness", null);
          emit({ type: "readiness", status: readiness?.status ?? "unknown" });
          if (run.mode === "workspace-write" && readiness?.status !== "ready") {
            return void (await finish("failed", `The Windows sandbox is ${readiness?.status ?? "unavailable"}; refusing workspace-write without an enforced sandbox`));
          }
        } catch (error) {
          if (run.mode === "workspace-write") return void (await finish("failed", `Cannot verify the Windows sandbox; refusing workspace-write: ${error.message}`));
        }
      }
      const params = { model: run.model, modelProvider: PROVIDER, cwd, approvalPolicy: "never", sandbox: run.mode };
      const started = await (threadId ? send("thread/resume", { ...params, threadId }) : send("thread/start", params));
      threadId = started.thread.id;
      emit({ type: "thread", threadId });
      // `effort` is the documented per-turn reasoning override ("for this turn and subsequent
      // turns"); thread/start and thread/resume have no such field, so nothing is sent there.
      // When unset the key is omitted entirely and the server default applies.
      await send("turn/start", { threadId, input: [{ type: "text", text: run.prompt }], sandboxPolicy: sandboxPolicy(run, cwd), ...(run.reasoningEffort !== undefined ? { effort: run.reasoningEffort } : {}) });
      emit({ type: "status", status: "Codex is running" });
    } catch (error) {
      await finish("failed", error.message);
    }
  })();

  return finished;
}
