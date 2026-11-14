// Fake Codex app-server. Records every inbound frame to FIXTURE_LOG as JSONL so a test can
// assert exactly what the controller put on the wire.
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";

const mode = process.env.FIXTURE_MODE || "";
const log = process.env.FIXTURE_LOG;
const thread = "test-thread";
const out = value => console.log(JSON.stringify(value));
const record = value => { if (log) appendFileSync(log, JSON.stringify(value) + "\n"); };

if (process.env.FIXTURE_PID_FILE) writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
if (mode === "stderr") {
  process.stderr.write("fixture boom: " + (process.env.OPENCODE_API_KEY || "no-key") + "\n");
  process.exit(1);
}

createInterface({ input: process.stdin }).on("line", line => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  record(m);
  if (m.id === undefined) return;
  if (m.method === "initialize") out({ id: m.id, result: {} });
  else if (m.method === "windowsSandbox/readiness") out({ id: m.id, result: { status: process.env.FIXTURE_READINESS || "ready" } });
  else if (m.method === "thread/start" || m.method === "thread/resume") {
    out({ id: m.id, result: { thread: { id: m.params.threadId || thread }, model: m.params.model, modelProvider: m.params.modelProvider, sandbox: m.params.sandbox, approvalPolicy: "never", approvalsReviewer: "user", cwd: m.params.cwd } });
  } else if (m.method === "turn/start") {
    if (mode === "bad-json") { out({ id: m.id, result: { turn: { id: "t" } } }); process.stdout.write("this is not json\n"); return; }
    out({ id: m.id, result: { turn: { id: "test-turn" } } });
    out({ method: "item/started", params: { threadId: m.params.threadId, turnId: "test-turn", startedAtMs: 1, item: { id: "i1", type: "commandExecution" } } });
    if (mode === "approval") {
      out({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: m.params.threadId, turnId: "test-turn", itemId: "i1" } });
      return;
    }
    out({ method: "item/agentMessage/delta", params: { threadId: m.params.threadId, turnId: "test-turn", itemId: "i2", delta: "Working" } });
    if (mode === "hang") return;
    setTimeout(() => out({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: "test-turn", status: "completed", items: [] } } }), 20);
  } else if (m.id === 900) {
    if (mode === "hang") return;
    setTimeout(() => out({ method: "turn/completed", params: { threadId: thread, turn: { id: "test-turn", status: "completed", items: [] } } }), 20);
  }
});
