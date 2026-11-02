# janua

A terminal you can talk to, and a command runner that answers once. `janua` gives an agent both
halves of running a program: `run` executes a command once and returns its output and exit code in a
single call, and `pty_spawn` keeps a program alive in a real pseudo-terminal so it can be written to
and read across several calls. Both are available over MCP, and `run` is also a plain CLI command, so
any harness - or a shell script with no harness at all - can use it.

Half the programs an agent needs are not one-shot: a dev server you have to restart, an installer
that stops on a prompt, a REPL where the second command depends on the first. `janua` keeps the
process alive on the other end of a real pseudo-terminal, so the program behaves the way it does in a
terminal you are sitting at - prompts appear, progress bars update, and typing works.

## Install

```powershell
npx @nathwn12/janua
```

That is the whole install: no build step, no native compile (the PTY ships prebuilt binaries). Point
your MCP client at it:

```json
{
  "mcpServers": {
    "janua": {
      "command": "npx",
      "args": ["-y", "@nathwn12/janua"]
    }
  }
}
```

On Windows, if your client cannot launch `npx` directly, wrap it in the command shell:

```json
{
  "mcpServers": {
    "janua": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@nathwn12/janua"]
    }
  }
}
```

The same package is a normal command when no MCP client is involved:

```bash
npx -y @nathwn12/janua run -- node -v
```

## The seven tools

| Tool | What it does |
| --- | --- |
| `run` | Run `command` once in a fresh PTY and return when it exits, when `match` appears in the output, or when `timeoutMs` (default 120000, max 3600000) runs out. Returns `{data, exitCode, timedOut, matched, sessionId, name, cursor, dropped, bytes, truncated, durationMs}`. `stdin` (a string, no newline added) is written immediately; `maxBytes` (default and max 1 MiB) caps `data` while `bytes` reports everything produced, with `truncated: true` when data was cut. On match or timeout the process tree is killed unless `keep: true`; with `keep` the session stays addressable by id or name. `shell: true` takes one platform command line (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` elsewhere) and requires `args` to be empty. |
| `pty_spawn` | Start `command` with `args` in a new PTY. Takes an optional `cwd`, `env`, `cols`/`rows` (defaults 80x24), `title`, `description` (5-10 words is the useful length, at most 200 characters; defaults to the title), and `name` (1-64 characters: letter or digit first, then letters, digits, `.`, `_` or `-`). Returns `{sessionId, pid, title, name, reused}`. A spawn with the name of a live session returns that session with `reused: true` instead of starting a second copy; `reuse: false` makes that `invalid_args` with `name_taken`, and a name held by an exited session is free for the new one. No shell string: command and args are passed as given, there is no `shell: true`. On Windows a bare name is resolved through `PATH` x `PATHEXT` and a batch shim runs through `cmd /c` (see Windows notes). |
| `pty_write` | Send `data` to a session (id or name). `newline` (default true) appends a carriage return, which is what a prompt is waiting for. Returns `{ok}`. Add `waitMs` (and optionally `match`, `cursor`, `maxBytes`, `stripAnsi`, with the same meaning as in `pty_read`) to read the reply in the same call: the response then also carries `{data, cursor, exited, exitCode, dropped, matched, incomplete, truncated}`. |
| `pty_read` | Read output from `cursor` onward, up to `maxBytes` (default 8000). `waitMs` waits up to 10 s for new output; `stripAnsi` (default true) removes colour and cursor-control sequences; `match` (a regex of at most 200 characters) makes the read wait until the text from `cursor` matches it. Returns `{data, cursor, exited, exitCode, dropped, matched, incomplete, truncated}`. |
| `pty_resize` | Change the size of a running session's terminal. `cols` and `rows` are integers 1-1000: give both, or give one and the other keeps the size in force. The program itself is told (SIGWINCH on POSIX, a resize of the ConPTY on Windows), so a full-screen program redraws at the new size instead of staying at the geometry it was spawned with. Returns `{ok, cols, rows}` for the geometry now in force, which `pty_list` reports from then on. A call naming neither dimension is `invalid_args`; resizing a session whose program has already exited is `pty_resize_failed`. |
| `pty_kill` | Terminate the program and confirm it. Idempotent. Takes a session id or name. `signal` defaults to `SIGTERM` and is honoured on POSIX; Windows terminates the process tree. Returns `{ok, exited, exitCode, pid}`: `exited` is the state observed after the kill, so `ok: false` with an `error` naming the pid (and the fallback to use) means the process survived. |
| `pty_list` | Sessions newest last, one page at a time: `limit` (1-200, default 50) and `offset` (default 0). Returns `{sessions, total, nextOffset}`, where `total` counts every session known and `nextOffset` is null on the last page. Each session carries `sessionId`, `name` (or null), `pid`, `title`, `command`, `args`, `cwd`, `description`, `cols`, `rows`, `exited`, `exitCode`, `bytes` and `createdAt`. |

### One-shot commands

`run` is the command runner: one call, one command, its output and its exit code. It starts a fresh
PTY (so the program sees a terminal), writes `stdin` right away, reads in short slices, and returns
when the program exits, when `match` appears, or when `timeoutMs` runs out. Nothing is reused, so two
runs never share a session.

```jsonc
// run - npm test, with the first failure line as the stopping point
{
  "command": "npm",
  "args": ["test"],
  "cwd": "C:\\work\\site",
  "timeoutMs": 300000,
  "maxBytes": 40000,
  "match": "FAIL|failing"
}
// -> {"data":"...","exitCode":1,"timedOut":false,"matched":true,"sessionId":"...","name":null,
//     "cursor":8123,"dropped":0,"bytes":8123,"truncated":false,"durationMs":1840}
```

- `stdin` is sent exactly as given, with no newline added. A line-buffered program needs the newline
  yourself: `"stdin": "y\n"` (a Windows console wants `\r`; a POSIX terminal translates it).
- `maxBytes` caps `data`, not the run: the output is still drained so `bytes`, `exitCode` and
  `truncated` are honest.
- A match or a timeout ends the run and kills the process tree, because a one-shot call has nobody
  left to answer a prompt. `keep: true` leaves the session running and addressable by `sessionId` or
  `name`, which is how a run turns into a conversation.
- `shell: true` is for a real command line (`"echo $HOME"`, `"npm run build | tail -1"`): the whole
  string goes to `cmd.exe /d /s /c` or `/bin/sh -c`, so `args` must be empty and quoting is the
  shell's business.

### Named sessions

Every `sessionId` input also accepts a session name, so a caller can keep a handle it chose instead
of a UUID. Names are 1-64 characters, start with a letter or digit, and may contain letters, digits,
`.`, `_` and `-`. They are optional everywhere.

```jsonc
{"command":"node","args":["--interactive"],"name":"scratch-repl","title":"scratch-repl","description":"scratch REPL for quick checks"}
// -> {"sessionId":"c91d...","pid":3312,"title":"scratch-repl","name":"scratch-repl","reused":false}

{"sessionId":"scratch-repl","data":"const answer = 42"}      // pty_write by name
{"sessionId":"scratch-repl","cursor":0,"waitMs":1000}        // pty_read by name
{"sessionId":"scratch-repl"}                                  // pty_kill by name
```

- A `pty_spawn` whose name belongs to a live session returns that session with `reused: true` and the
  same id and pid, so a retry does not start a second program. `reuse: false` turns that into
  `invalid_args` with `name_taken` instead.
- A name is only held by a live session. Once the program exits the name is free, and the next spawn
  with it starts fresh (the old session stays readable under its id, and its `pty_list` entry shows
  `name: null`).
- `run` never reuses a live name: it reports `name_taken` rather than attach a second program to an
  id the caller believes it owns.

### Reading without duplicates

`cursor` is a byte offset into the session's whole output stream, not an index into a window. Pass
the cursor a read returns and the next read continues exactly where the last one stopped. Omit it to
start at the oldest byte still buffered. The buffer keeps the last 1 MiB per session; if a read asks
for a cursor that has since been discarded, the reply starts at the oldest retained byte and reports
how many bytes were lost in `dropped`.

A read never splits a character: when `maxBytes` would cut inside a multi-byte UTF-8 character, the
slice ends before it (or carries it whole, when the window is smaller than the character) and the
cursor stays on its first byte, so successive reads rebuild the exact bytes. An ANSI escape sequence
is held the same way: a half-received `ESC [` is not returned as text and the tail does not arrive as
literal characters, because the cursor stops at the sequence until the rest of it lands. If the
character or sequence is cut by the end of the stream, the reply says so: `incomplete: true` for a
live tail still waiting for bytes (read again from the same cursor), `truncated: true` once the child
has exited and the rest can never arrive.

`waitMs` makes a read block instead of polling: it returns as soon as new output arrives, or when
the session exits, or at the deadline. A ConPTY opens with escape-only chunks (mode set, focus
reporting), so a stripped read that finds nothing visible keeps waiting from the same cursor for the
text behind it; `stripAnsi: false` returns those first bytes as they arrive.

`match` turns that same wait into a wait for a prompt: the read returns once the text from `cursor`
matches the pattern, or the session exits, or `waitMs` runs out, and reports `matched: false` on
timeout while still returning whatever arrived — so give it a non-zero `waitMs`.

### Errors

Tool failures come back as an `isError` result carrying a typed code, never as a thrown exception:
`invalid_args`, `session_not_found`, `spawn_failed`, `pty_write_failed`, `pty_resize_failed`,
`too_many_sessions`, and a `pty_kill_failed` marker inside `pty_kill`'s `error` field.
Every tool also declares its success shape as an output schema, so a client validates
`structuredContent`; a failure carries its typed code in the text content only, because a payload
that contradicted the declared shape would be rejected by a validating client.

## Limits and defaults

- 32 concurrent sessions (`JANUA_MAX_SESSIONS` overrides it). Exited sessions are purged first when
  the cap is reached; if none can be purged the spawn fails with `too_many_sessions`.
- 1 MiB of retained output per session (`JANUA_MAX_BUFFER_BYTES` overrides it).
- `run` waits 120 s by default (`timeoutMs`, max 3600000) and returns at most 1 MiB of data
  (`maxBytes`); it keeps draining past the cap so `bytes` and `truncated` stay honest.
- `cwd` must exist and be a directory, and `command` must not be empty: both are refused with
  `invalid_args` before anything is spawned.
- Every session is killed when the server exits, and on `SIGINT`/`SIGTERM`.

## Standalone by design

janua is standalone. It does not require an orchestrator, a specific editor, another service, or a particular agent framework. Any MCP stdio client can mount it, and any shell can call it. Integrations are optional adapters, never dependencies.

## Use it from any harness

janua is one process with two faces. A barebones harness that can start a process and read its stdout can use either one.

**As an MCP server.** Any MCP client that speaks stdio can launch it; the config from
[Install](#install) is the whole setup. With no arguments (or with `janua mcp`) the process serves
JSON-RPC on stdout and nothing else, which is what the client expects. `run` is the tool for
one-shot commands, `pty_spawn` is the tool for long-lived ones.

**As a CLI.** The same package installs a `janua` binary, so a shell script, a Makefile, a CI step or
an agent with only a command tool can use it:

```bash
janua run -- node -v                      # stdout is the command's output, exit code is its own
janua run --json -- npm test              # the whole result as JSON, including timedOut and bytes
janua run --timeout 30000 -- node slow.js # 124 when the timeout wins
janua run --shell -- "npm run build | tail -5"
janua --version                           # the package version
janua --help                              # usage, including every run option
```

`run` writes `data` to stdout with no added newline and exits with the child's code, so it composes
with pipes and `$?`/`%ERRORLEVEL%` like any other command. `--json` is for a harness that wants the
structured result (`exitCode`, `timedOut`, `matched`, `truncated`, `sessionId`, ...) instead of text.
`--name` labels the session and reports it in the JSON; the CLI is one-shot, so the session ends with the process. The MCP server is the place where a session outlives one call and can be addressed by name again.

The CLI runs on Windows, Linux and macOS. On Windows, `npx` itself is a `.cmd` shim; if a script
cannot launch it directly, wrap it in `cmd /c` exactly as the MCP config above does.

## Windows notes

- **Command names are resolved the way a shell resolves them.** `CreateProcess` does not consult
  `PATHEXT`, so a bare `npm`, `npx`, `pnpm`, `yarn` or `tsc` - all of them `.cmd` batch shims -
  used to fail with "Cannot create process, error code: 2". A bare name is now looked up against
  `PATH` x `PATHEXT` (`.COM;.EXE;.BAT;.CMD` by default) and the first match wins. An `.exe`/`.com`
  runs directly by its absolute path; a `.cmd`/`.bat` runs through `cmd /d /s /c`, because batch
  files cannot be executed by `CreateProcess` at all. Nothing is run through a shell on POSIX, and
  a name that contains a path separator is never resolved through `PATH`.
- **Arguments are quoted for that `cmd /c` line.** An argument holding a space, a tab, a quote or a
  cmd metacharacter is wrapped in `"`, and an embedded `"` is doubled, so
  `['hello world', 'say "hi" now']` arrives as two arguments with their spaces and quotes intact.
  Two cmd behaviours cannot be escaped from outside: `%NAME%` inside an argument is expanded by
  cmd, and `^` is consumed even inside quotes - an argument containing `^` through a batch shim is
  refused with `invalid_args` rather than silently mangled. Drive either through a `cmd.exe`
  session instead.
- Terminals come from ConPTY, so programs see a real console: `cmd.exe`, PowerShell, `node`, Python
  and anything that uses colour or prompts all work. A first read right after spawn usually contains
  a screen-initialisation sequence; it is stripped by default.
- There are no POSIX signals. `signal` is accepted and ignored; `pty_kill` terminates the process
  tree instead.
- A child that prints a window title sequence (`ESC ] 0 ; ... BEL`) will show it in the raw stream
  when `stripAnsi: false`. With stripping on it is removed, including titles containing Windows paths.
- `pty_write` appends `\r`, not `\n`, because that is what a console line discipline expects.
- In ConPTY the exit event and the last chunk of output can arrive up to about a second after the
  program dies. `pty_read` with `waitMs` covers that: `exited: true` and the `exitCode` are reported
  on whichever read observes them.

PTY engine: @lydell/node-pty (MIT)

## Going deeper

`docs/GUIDE.md` has four worked examples: restarting a dev server, answering an interactive prompt,
driving a REPL, and one-shot commands with named sessions.

## Links

- Repository: https://github.com/nathwn12/oc-collections/tree/main/packages/janua
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- License: [LICENSE](LICENSE) (MIT)
