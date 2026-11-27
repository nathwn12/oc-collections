<h1 align="center">janua</h1>

<p align="center"><strong>Persistent interactive terminals for agents: spawn once, then write and read across calls.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nathwn12/janua"><img src="https://img.shields.io/npm/v/@nathwn12%2Fjanua" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="Windows and Linux" />
  <img src="https://img.shields.io/badge/tools-6-brightgreen" alt="6 tools" />
  <a href="https://github.com/nathwn12/oc-collections/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT licence" /></a>
</p>

## Install

```sh
npm i @nathwn12/janua
```

### Wire it yourself

Point your MCP client at the package, then restart it:

```json
{ "mcpServers": { "janua": { "command": "npx", "args": ["-y", "@nathwn12/janua"] } } }
```

If the client cannot launch `npx` directly on Windows, use `"command": "cmd", "args": ["/c", "npx", "-y", "@nathwn12/janua"]`.

## First use

Start a session, write to it, and read the answer in later calls:

```jsonc
{"command":"node","args":["--interactive"],"name":"scratch-repl","title":"scratch-repl"}
// -> {"sessionId":"c91d...","pid":3312,"reused":false}
{"sessionId":"scratch-repl","data":"const answer = 42"}       // pty_write
{"sessionId":"scratch-repl","cursor":0,"waitMs":1000}         // pty_read
{"sessionId":"scratch-repl"}                                   // pty_kill
```

The six tools are `pty_spawn`, `pty_write`, `pty_read`, `pty_resize`, `pty_kill` and `pty_list`. Pass a session id or a chosen name to any of them. A spawn that reuses a live name returns that session with `reused: true` instead of starting a second copy.

For a one-shot command, use the CLI:

```bash
janua run -- node -v
janua run --json --match "FAIL|failing" -- npm test
janua run --timeout 30000 -- node slow.js
janua run --tty -- node --interactive
```

`run` writes stdout with no added newline and exits with the child's code. A match or timeout kills the process tree. `--tty` uses a real PTY; pipes are the default.

### Configure it

No config file. The MCP client block above is the whole setup. These environment variables change the defaults:

| Variable | Default | Effect |
| --- | --- | --- |
| `JANUA_HOME` | per-user data dir | Where installed versions and `current.json` live. |
| `JANUA_MAX_SESSIONS` | 32 | Concurrent session cap. |
| `JANUA_MAX_BUFFER_BYTES` | 1 MiB | Retained output per session. |

`janua upgrade` installs a new version beside the running one, verifies it, then moves the pointer. Pass a version to pin one.

## Requirements

- Node `^22.23.4 || ^24.22.1 || >=26.12.1`.
- Windows, Linux or macOS. Windows uses ConPTY; a bare command name is resolved through `PATH` x `PATHEXT`.
- An MCP client that speaks stdio, or a shell for the CLI.

## Status

**Unverified** — as-is, use at your own risk.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Guide](https://github.com/nathwn12/oc-collections/blob/main/packages/janua/docs/GUIDE.md)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)
