# Changelog

## [Unreleased]

## [0.2.1] - 2026-11-01

### Fixed

- `pty_read` ignored a small `maxBytes` on the first read of every session. A ConPTY opens with
  escape-only chunks, so the window began inside an unfinished escape sequence and the read widened to
  the rest of the buffer to decode it: `maxBytes: 7` could return the whole ring and move the cursor to
  its end. The widen now stops at the end of the one straddling sequence, and if that sequence does not
  finish within `maxBytes` + 65536 bytes the read flushes what it has and advances rather than widening
  further; a fragment frozen by a child's exit is flushed the same way. A read never returns more than
  `maxBytes` plus the bytes needed for one straddling character or sequence.

## [0.2.0] - 2026-11-01

### Added

- `pty_write` takes `waitMs`, `match`, `cursor`, `maxBytes` and `stripAnsi`, the same read options
  `pty_read` has. With `waitMs` above zero the reply is read in the same call and the payload grows
  the read fields (`data`, `cursor`, `exited`, `exitCode`, `dropped`, `matched`), so a prompt that
  answers a write no longer costs a second call. Without it the tool is unchanged.
- `pty_list` returns `description`, `args`, `cwd`, `cols` and `rows`, so a session can be recalled
  from the list alone. The spawn-time description existed only to make a later list readable and was
  not returned earlier.
- `pty_kill` returns `exited`, `exitCode` and `pid`, the exit state it confirmed after the request.
  A process that survives the attempt comes back as `ok: false` with a `pty_kill_failed` error naming
  the pid and the fallback to run, instead of an unconditional `ok: true`.

### Fixed

- A read that ended inside a multi-byte UTF-8 character returned U+FFFD and advanced the cursor into
  the character, so the rest of it decoded as garbage. Slices now end on a character boundary (a
  character wider than `maxBytes` is returned whole), and successive reads rebuild the exact bytes.
- A read that ended inside an ANSI escape sequence returned the raw head as text and the tail as
  literal characters on the next read. The unfinished sequence is now held back (the cursor stays on
  its first byte) until it arrives whole, widening the window rather than stalling when the sequence
  is longer than `maxBytes`; at end of output the tail is flushed instead of being stranded.
- `pty_spawn` refused a description that was not 5-10 words, which turned a memory aid into a hard
  gate. It is now optional, defaults to the title, and only a 200-character bound is enforced.

### Changed

- `pty_spawn`'s `description` is optional, and `pty_list` reads better because of it.

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
