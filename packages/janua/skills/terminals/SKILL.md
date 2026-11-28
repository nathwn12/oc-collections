---
name: terminals
description: "Persistent interactive terminals via janua: spawn once, then write and read across calls. Use for long-lived work you will talk to (dev servers, REPLs, prompts); one-shot commands belong to the shell or janua run."
---

# Persistent terminals (janua)

Use janua when a program stays alive and you will talk to it over several calls:
dev servers, REPLs, installers that prompt, anything with a TTY. For a command whose
output you want once, use the shell; in a script that needs a match pattern, a timeout,
or JSON, use the CLI `janua run` (not an MCP tool).

## Tools

- `pty_spawn` - start a program in a persistent PTY; returns `{sessionId, pid, title, name, reused}`.
- `pty_write` - send keystrokes; optional `waitMs`/ `match` reads the reply in the same call.
- `pty_read` - read output from a cursor; pass the previous cursor to get only new bytes.
- `pty_resize` - tell a full-screen program the new geometry.
- `pty_kill` - terminate and confirm gone; session stays listed with its exit code.
- `pty_list` - recover a lost id/name and recall what a session is for.

Every `sessionId` input also accepts a session `name`.

## Lifecycle

1. Spawn. Give a `name` when you will address the session again; a live name returns
   that session with `reused: true` instead of starting a second copy.
2. Write with `pty_write` (newline defaults to the carriage return a PTY prompt waits for).
3. Read with `pty_read`, advancing the cursor each time so output is never duplicated.
4. Resize with `pty_resize` for TUIs instead of respawning and losing state.
5. Kill with `pty_kill` when done; sessions remain listed so last output can still be read.

## Read before write

- Omit `cursor` to read from the oldest byte still buffered; pass the returned cursor
  next time to read only new output.
- `dropped > 0` means the ring buffer discarded that many bytes before this read.
- `incomplete: true` means the last character is still in flight; read again from the
  same cursor. `truncated: true` means the child exited mid-character/escape.
- `waitMs` waits for output or exit; `match` (regex) waits until the text matches.

## Ring buffer

Each session retains the last `JANUA_MAX_BUFFER_BYTES` (default 1 MiB); older bytes are
dropped and reported via `dropped`. `JANUA_MAX_SESSIONS` caps concurrent sessions (32).

## Cleanup

Kill sessions you no longer need; a killed session stays listed with its exit code so
its final output remains readable. For a restartable dev server, spawn a shell
(`cmd.exe /d /k` or your shell) so the session outlives its child and can be restarted
in place; a process spawned directly dies with its server. Resize, do not respawn, for
full-screen programs that find 80x24 too small.
