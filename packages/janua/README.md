# janua

A terminal you can talk to. `janua` is an MCP server that gives an agent persistent interactive
terminals (PTYs): start a program, write to it, read what it answers, kill it when you are done.

A command runner answers once and is gone. Half the programs an agent needs are not like that: a dev
server you have to restart, an installer that stops on a prompt, a REPL where the second command
depends on the first. `janua` keeps the process alive on the other end of a real pseudo-terminal, so
the program behaves the way it does in a terminal you are sitting at - prompts appear, progress bars
update, and typing works.

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

## The five tools

| Tool | What it does |
| --- | --- |
| `pty_spawn` | Start `command` with `args` in a new PTY. Takes an optional `cwd`, `env`, `cols`/`rows` (defaults 80x24), `title`, and a required 5-10 word `description`. Returns `{sessionId, pid, title}`. No shell string: command and args are passed as given, there is no `shell: true`. |
| `pty_write` | Send `data` to a session. `newline` (default true) appends a carriage return, which is what a prompt is waiting for. Returns `{ok}`. |
| `pty_read` | Read output from `cursor` onward, up to `maxBytes` (default 8000). `waitMs` waits up to 10 s for new output; `stripAnsi` (default true) removes colour and cursor-control sequences. Returns `{data, cursor, exited, exitCode, dropped}`. |
| `pty_kill` | Terminate the program. Idempotent. `signal` defaults to `SIGTERM` and is honoured on POSIX; Windows terminates the process tree. Returns `{ok}`. |
| `pty_list` | Every session with `sessionId`, `pid`, `title`, `command`, `exited`, `exitCode`, `bytes` and `createdAt`. |

### Reading without duplicates

`cursor` is a byte offset into the session's whole output stream, not an index into a window. Pass
the cursor a read returns and the next read continues exactly where the last one stopped. Omit it to
start at the oldest byte still buffered. The buffer keeps the last 1 MiB per session; if a read asks
for a cursor that has since been discarded, the reply starts at the oldest retained byte and reports
how many bytes were lost in `dropped`.

`waitMs` makes a read block instead of polling: it returns as soon as new output arrives, or when
the session exits, or at the deadline.

### Errors

Tool failures come back as an `isError` result carrying a typed code, never as a thrown exception:
`invalid_args`, `session_not_found`, `spawn_failed`, `pty_write_failed`, `too_many_sessions`.

## Limits and defaults

- 16 concurrent sessions (`JANUA_MAX_SESSIONS` overrides it). Exited sessions are purged first when
  the cap is reached; if none can be purged the spawn fails with `too_many_sessions`.
- 1 MiB of retained output per session (`JANUA_MAX_BUFFER_BYTES` overrides it).
- `cwd` must exist and be a directory, and `command` must not be empty: both are refused with
  `invalid_args` before anything is spawned.
- Every session is killed when the server exits, and on `SIGINT`/`SIGTERM`.

## Windows notes

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

`docs/GUIDE.md` has three worked examples: restarting a dev server, answering an interactive prompt,
and driving a REPL.
