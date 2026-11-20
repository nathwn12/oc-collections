<h1 align="center">janua</h1>

<p align="center"><strong>Persistent interactive terminals for agents: spawn a program once, then write to it and read it across calls.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nathwn12/janua"><img src="https://img.shields.io/npm/v/@nathwn12/janua" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="platform">
  <img src="https://img.shields.io/badge/tools-6-brightgreen" alt="6 tools">
  <a href="https://github.com/nathwn12/oc-collections/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

## Why

Half the programs an agent needs are not one-shot: a dev server you restart, an installer that stops on a prompt, a REPL whose second command depends on the first. `janua` keeps the program alive on the other end of a real pseudo-terminal, so it behaves as it does in a terminal you sit at — prompts appear, progress bars update, typing works.

The MCP surface is six tools for long-lived sessions. One-shot commands stay in the shell; the same package also ships a `janua run` CLI when a script needs a matcher, a timeout, or a JSON result.

`janua` is standalone. It needs no orchestrator, editor, service, or agent framework.

## Install

```powershell
npx -y @nathwn12/janua@0.5.2
```

Point your MCP client at the same package:

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

If the client cannot launch `npx` directly on Windows, wrap it in the command shell:

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

## Use

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

## Configure

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

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Guide](https://github.com/nathwn12/oc-collections/blob/main/packages/janua/docs/GUIDE.md)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)

<p align="center"><sub>Built by nathwn12</sub></p>
