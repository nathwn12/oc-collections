# Changelog

## [Unreleased]

## [0.1.2] - 2026-11-01

### Added

- `pty_read` takes `match`, a regular expression it waits for, and returns `matched`: the read returns
  once the text from the cursor matches, or reports `matched: false` when `waitMs` runs out or the
  session exits, so a non-zero `waitMs` is what makes it useful.
- `pty_list` is paged with `limit`/`offset` and returns `{sessions, total, nextOffset}`, so a session
  list longer than one page is still walkable and a lost session id is recoverable.
- Every tool declares MCP `annotations` (read-only, mutating, destructive) and an `outputSchema`, so a
  client can validate a result and judge a call before making it.

### Changed

- Windows: `pty_spawn` resolves a bare `command` through `PATH` x `PATHEXT` and runs a `.cmd`/`.bat`
  shim (`npm`, `npx`, `pnpm`, `yarn`, `tsc`) through `cmd /c`, because `CreateProcess` consults
  neither.
- `pty_read` waits for visible text instead of returning an escape-only chunk: the cursor and title
  sequences ConPTY emits ahead of any output no longer end a read early.
- Migrated to MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0).

## [0.1.0] - 2026-10-31

### Added

- `janua`: a stdio MCP server exposing persistent interactive terminals. Five tools: `pty_spawn`,
  `pty_write`, `pty_read`, `pty_kill`, `pty_list`. A PTY outlives a single command, so a program can
  be talked to across several tool calls: prompts, REPLs, and dev servers that need a restart rather
  than a relaunch.
- Per-session output ring buffer with monotonic byte cursors: a read continues where the last one
  stopped, and a cursor older than the 1 MiB window reports the bytes it lost in `dropped`.
- `pty_read` blocks with `waitMs` instead of being polled, and strips ANSI escape sequences by
  default, including ConPTY window titles that contain Windows paths.
- Typed tool failures instead of exceptions across the MCP boundary: `invalid_args`,
  `session_not_found`, `spawn_failed`, `pty_write_failed`, `too_many_sessions`.
- Guards: `cwd` must exist, `command` must not be empty, a 5-10 word `description` is required per
  session, and 16 concurrent sessions is the default cap.
- Every session is killed on server exit, `SIGINT` and `SIGTERM`, and on stdin close.
- Windows: taskkill-based tree termination, dead-pid guard before kill, and disposal of node-pty's
  console worker after a child exits so the server (and its tests) can shut down cleanly.
- `test/` covers spawn/read/list/kill, writing to a stdin-reading child, typed `session_not_found`,
  cursor/`maxBytes` continuity, and an end-to-end MCP handshake over stdio.
