//! Clipboard proof under the background-only policy: `clipboard_get` reads
//! (it cannot disturb the owner), and `clipboard_set` is ALWAYS refused with
//! `no_clipboard_policy` — writing would overwrite the owner's shared global
//! clipboard, and no flag buys it. Refusals happen before any clipboard API,
//! under dry_run too. The live proof hashes the clipboard before and after a
//! refused write and requires byte-identity; it needs a real interactive
//! session clipboard and is gated by PUPPET_LIVE_DESKTOP=1.

use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use serde_json::Value;

const TIMEOUT: Duration = Duration::from_secs(30);

/// Live clipboard tests share ONE owner clipboard, so they must not run
/// concurrently: a parallel write would be indistinguishable from a gate
/// failure. Every test that reads or writes the clipboard holds this lock.
static CLIP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn clip_guard() -> std::sync::MutexGuard<'static, ()> {
    CLIP_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn clipboard_hash(text: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.as_bytes().hash(&mut h);
    h.finish()
}

fn live() -> bool {
    if std::env::var("PUPPET_LIVE_DESKTOP").as_deref() == Ok("1") {
        true
    } else {
        println!(
            "SKIP clipboard: set PUPPET_LIVE_DESKTOP=1 to run (needs an interactive Windows session)"
        );
        false
    }
}

struct Session {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
}

impl Session {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_puppet"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn puppet binary");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let t = line.trim().to_string();
                        if t.is_empty() {
                            continue;
                        }
                        if tx.send(t).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Session { child, stdin, rx }
    }

    /// One `tools/call` round-trip, fallible. Cleanup paths (a `Drop` that
    /// puts the owner's clipboard back) must be able to report a failure
    /// instead of panicking inside an unwind, where a second panic aborts.
    fn try_result(&mut self, id: i64, name: &str, arguments: Value) -> Result<Value, String> {
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        });
        let line = serde_json::to_string(&frame).map_err(|e| format!("encode frame: {e}"))?;
        self.stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("write frame: {e}"))?;
        self.stdin
            .write_all(b"\n")
            .map_err(|e| format!("write newline: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("flush frame: {e}"))?;
        let line = self
            .rx
            .recv_timeout(TIMEOUT)
            .map_err(|e| format!("response in time for tools/call {name}: {e}"))?;
        let resp: Value =
            serde_json::from_str(&line).map_err(|e| format!("response is JSON: {e} in {line}"))?;
        resp.get("result")
            .cloned()
            .ok_or_else(|| format!("tools/call {name} must succeed, got: {resp}"))
    }

    fn result(&mut self, id: i64, name: &str, arguments: Value) -> Value {
        self.try_result(id, name, arguments)
            .unwrap_or_else(|e| panic!("{e}"))
    }

    /// First per-action result of a `do` burst, fallible for the same reason.
    fn try_do_first(&mut self, id: i64, arguments: Value) -> Result<Value, String> {
        let r = self.try_result(id, "do", arguments)?;
        r.get("structuredContent")
            .and_then(|sc| sc.get("results"))
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .cloned()
            .ok_or_else(|| format!("do must return per-action results, got: {r}"))
    }

    fn do_first(&mut self, id: i64, arguments: Value) -> Value {
        self.try_do_first(id, arguments)
            .unwrap_or_else(|e| panic!("{e}"))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The owner's clipboard is put back ONLY when the restoration is proven to
/// have landed: the permitted `clipboard_set` reported `ok:true` AND a
/// readback returned exactly the saved text. A reported-ok write that did
/// not land, a readback that cannot be read, or a readback with no `text`
/// field all fail — none of them may stand in for a confirmed restore. Pure,
/// so every one of those refusal paths is unit-tested without a live
/// clipboard.
fn confirm_restored(want: &str, set: &Value, read: &Value) -> Result<(), String> {
    if set.get("ok") != Some(&Value::from(true)) {
        return Err(format!("restore clipboard_set did not report ok: {set}"));
    }
    if read.get("ok") != Some(&Value::from(true)) {
        return Err(format!("restored clipboard could not be read back: {read}"));
    }
    let got = read
        .get("text")
        .and_then(|t| t.as_str())
        .ok_or_else(|| format!("restored clipboard readback has no text field: {read}"))?;
    if got != want {
        return Err(format!("restored clipboard holds {got:?}, want {want:?}"));
    }
    Ok(())
}

#[test]
fn clipboard_set_is_always_refused_and_touches_nothing() {
    // No live gate: the refusal happens before any clipboard API exists on
    // the path, so this is safe on a headless runner and it is the proof
    // that a refused call cannot have touched the clipboard.
    let mut s = Session::spawn();
    let refused = s.do_first(
        1,
        serde_json::json!({"actions": [{"type": "clipboard_set", "text": "SHOULD-NOT-LAND"}]}),
    );
    assert_eq!(
        refused.get("ok"),
        Some(&Value::from(false)),
        "clipboard_set must fail, got: {refused}"
    );
    assert_eq!(
        refused.get("code").and_then(|c| c.as_str()),
        Some("no_clipboard_policy"),
        "refusal must be typed no_clipboard_policy, got: {refused}"
    );
    assert!(
        refused
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("")
            .contains("background-only policy"),
        "refusal must name the rule, got: {refused}"
    );
    // Even the explicit flag buys nothing.
    let flagged = s.do_first(
        2,
        serde_json::json!({"actions": [{"type": "clipboard_set", "text": "SHOULD-NOT-LAND"}], "allow_clipboard": true}),
    );
    assert_eq!(
        flagged.get("code").and_then(|c| c.as_str()),
        Some("no_clipboard_policy"),
        "allow_clipboard:true must not buy a write, got: {flagged}"
    );
    // A refused write must not abort the burst: the next action still runs.
    let batch = s.result(
        3,
        "do",
        serde_json::json!({"actions": [
            {"type": "clipboard_set", "text": "SHOULD-NOT-LAND"},
            {"type": "wait", "ms": 1}
        ]}),
    );
    let results = batch["structuredContent"]["results"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(results.len(), 2, "both actions must report, got: {batch}");
    assert_eq!(
        results[1].get("ok"),
        Some(&Value::from(true)),
        "the action after a refused write must still run, got: {batch}"
    );
    // dry_run refuses identically (a dry run that says ok while the live
    // call would refuse is a lie) - and still touches nothing.
    let dry_unflagged = s.result(
        4,
        "do",
        serde_json::json!({"actions": [{"type": "clipboard_set", "text": "X"}], "dry_run": true}),
    );
    assert_eq!(
        dry_unflagged["structuredContent"]["results"][0]["code"].as_str(),
        Some("no_clipboard_policy"),
        "dry_run must refuse identically, got: {dry_unflagged}"
    );
    println!("CLIPBOARD_GATE_OK no_clipboard_policy before any clipboard access");
}

#[test]
fn clipboard_get_reads_and_set_is_always_refused_live() {
    if !live() {
        return;
    }
    let _guard = clip_guard();
    let mut s = Session::spawn();
    // Whatever the owner holds, read it twice around refused writes: hash
    // before, refused plain set, refused flagged set, refused over-cap set,
    // hash after. Nothing is ever written, so nothing needs restoring.
    let before = s.do_first(
        1,
        serde_json::json!({"actions": [{"type": "clipboard_get"}]}),
    );
    let before_text = before
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    let before_hash = clipboard_hash(&before_text);
    for (id, args) in [
        (
            2,
            serde_json::json!({"actions": [{"type": "clipboard_set", "text": "SHOULD-NOT-LAND"}]}),
        ),
        (
            3,
            serde_json::json!({"actions": [{"type": "clipboard_set", "text": "SHOULD-NOT-LAND"}], "allow_clipboard": true}),
        ),
        (
            4,
            serde_json::json!({"actions": [{"type": "clipboard_set", "text": "x".repeat(1_048_576 + 1)}], "allow_clipboard": true}),
        ),
    ] {
        let refused = s.do_first(id, args);
        assert_eq!(
            refused.get("ok"),
            Some(&Value::from(false)),
            "clipboard_set must refuse, got: {refused}"
        );
        assert_eq!(
            refused.get("code").and_then(|c| c.as_str()),
            Some("no_clipboard_policy"),
            "refusal must be typed, got: {refused}"
        );
    }
    let after = s.do_first(
        5,
        serde_json::json!({"actions": [{"type": "clipboard_get"}]}),
    );
    let after_text = after
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    assert_eq!(
        clipboard_hash(&after_text),
        before_hash,
        "refused writes must leave the clipboard byte-identical: before={before_text:?} after={after_text:?}"
    );
    assert_eq!(
        before_text.as_bytes(),
        after_text.as_bytes(),
        "clipboard bytes must be identical across refused writes"
    );
    println!("CLIPBOARD_OK get reads, every set refused, hash={before_hash:#x} unchanged");
}

/// Live: a second consecutive read must match the first across refused
/// writes, proving the refusal path never opens, empties or writes the
/// clipboard on its way out.
#[test]
fn refused_clipboard_set_leaves_the_clipboard_byte_identical() {
    if !live() {
        return;
    }
    let _lock = clip_guard();
    let mut s = Session::spawn();
    // Immediately before: read and hash.
    let before = s.do_first(
        1,
        serde_json::json!({"actions": [{"type": "clipboard_get"}]}),
    );
    let before_text = before
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    let before_hash = clipboard_hash(&before_text);
    // The refused write asks for a DIFFERENT value with no flag.
    let refused = s.do_first(
        2,
        serde_json::json!({"actions": [{"type": "clipboard_set", "text": "PUPPET-REFUSED-WRITE"}]}),
    );
    assert_eq!(
        refused.get("code").and_then(|c| c.as_str()),
        Some("no_clipboard_policy"),
        "unflagged write must be refused, got: {refused}"
    );
    // Immediately after: read and hash.
    let after = s.do_first(
        3,
        serde_json::json!({"actions": [{"type": "clipboard_get"}]}),
    );
    let after_text = after
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    let after_hash = clipboard_hash(&after_text);
    assert_eq!(
        before_hash, after_hash,
        "a refused clipboard_set must not change the clipboard: before={before_text:?} after={after_text:?}"
    );
    assert_eq!(
        before_text.as_bytes(),
        after_text.as_bytes(),
        "clipboard bytes must be identical across a refused write"
    );
    println!("CLIPBOARD_GATE_LIVE_OK hash={before_hash:#x} unchanged across a refused write");
}

/// The restore proof itself: nothing but a reported-ok write plus an exact
/// readback may count as a confirmed restoration. Touches no clipboard, so it
/// runs in the default (non-live) gate.
#[test]
fn restore_confirmation_rejects_every_unproven_restore() {
    let ok_set = serde_json::json!({"type": "clipboard_set", "ok": true});
    let saved = "owner text before the test";
    let ok_read = serde_json::json!({"type": "clipboard_get", "ok": true, "text": saved});
    assert_eq!(
        confirm_restored(saved, &ok_set, &ok_read),
        Ok(()),
        "an ok write plus an exact readback is the only confirmed restore"
    );
    // The write reported failure: nothing was restored.
    let failed_set =
        serde_json::json!({"type": "clipboard_set", "ok": false, "error": "OpenClipboard failed"});
    assert!(
        confirm_restored(saved, &failed_set, &ok_read).is_err(),
        "a restore whose clipboard_set did not report ok must not be confirmed"
    );
    // The write reported ok but the clipboard still holds the test seed.
    let stale_read =
        serde_json::json!({"type": "clipboard_get", "ok": true, "text": "puppet-clip-gate-1-2"});
    assert!(
        confirm_restored(saved, &ok_set, &stale_read).is_err(),
        "a readback that is not the saved text must not be confirmed"
    );
    // The readback could not read the clipboard at all.
    let unreadable =
        serde_json::json!({"type": "clipboard_get", "ok": false, "error": "OpenClipboard failed"});
    assert!(
        confirm_restored(saved, &ok_set, &unreadable).is_err(),
        "an unreadable clipboard must not be confirmed as restored"
    );
    // An ok readback with no text field proves nothing, not even emptiness.
    let no_text = serde_json::json!({"type": "clipboard_get", "ok": true});
    assert!(
        confirm_restored("", &ok_set, &no_text).is_err(),
        "a readback without a text field must not be confirmed"
    );
    // The empty-owner case is confirmed by an ok readback of "".
    let empty_read = serde_json::json!({"type": "clipboard_get", "ok": true, "text": ""});
    assert_eq!(
        confirm_restored("", &ok_set, &empty_read),
        Ok(()),
        "restoring an empty owner clipboard is confirmed by an empty readback"
    );
    println!("CLIPBOARD_RESTORE_PROOF_OK restore confirmed only by ok write + exact readback");
}

#[test]
fn clipboard_big_readback_truncates_to_cap() {
    // A foreign clipboard larger than the cap reads back truncated to
    // exactly MAX_CLIP_CHARS (seeded via PowerShell, cleared after).
    if !live() {
        return;
    }
    let _guard = clip_guard();
    let seed = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Set-Clipboard -Value ('Z' * 1100000)",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if !seed.map(|s| s.success()).unwrap_or(false) {
        println!("SKIP clipboard_big_readback: powershell seeding failed");
        return;
    }
    let mut s = Session::spawn();
    let get = s.do_first(
        1,
        serde_json::json!({"actions": [{"type": "clipboard_get"}]}),
    );
    let text_len = get
        .get("text")
        .and_then(|t| t.as_str())
        .map(|t| t.chars().count())
        .unwrap_or(0);
    // Clear before asserting so a failure never leaves a 1MB clipboard.
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", "Set-Clipboard -Value ''"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    assert_eq!(
        get.get("ok"),
        Some(&Value::from(true)),
        "big clipboard read must succeed, got: {get}"
    );
    assert_eq!(
        text_len, 1_048_576,
        "big clipboard must truncate to exactly MAX_CLIP_CHARS, got {text_len}"
    );
    println!("CLIPBOARD_BIG_OK truncated read green");
}
