# oc-talk

Gives an agent nine tools to run the session lifecycle across the sessions next door: find a peer, hand it a message, read what it answered, park it, wake it, close it.

## Install

This package is private pending a trial. It is **not installable from a registry** — there is no `npx` command and no npm install, and nothing about it is published. There are two local routes, both from a checkout of this repo.

Link the package directory into the harness:

```powershell
cd packages/oc-talk
npm link
```

Then add the entry to the `plugins` array in your `opencode.jsonc`:

```json
{ "plugins": ["oc-talk"] }
```

Or skip the link and point the same array at the directory itself, as a local plugin path:

```json
{ "plugins": ["file:///C:/path/to/oc-collections/packages/oc-talk"] }
```

Restart OpenCode either way. The plugin registers its nine tools when the session starts, and uses the same `opencode` binary that is running it.

## What you get

| Tool | What it does for you |
| --- | --- |
| `session_list` | Turns a title you remember into the `ses_…` id every other tool accepts, one page at a time. |
| `session_send` | Delivers one message to a peer verbatim and lets its loop run, so the peer actually does the work. |
| `session_read` | Reads the peer's newest messages, verbatim, newest first — nothing is pushed to you. |
| `session_await` | Sends and then waits for the reply in one call, returning the reply text or a readable timeout instead of hanging. |
| `session_close` | Renames to `done <work>` and compacts, in that order, so a finished session stops reading as live. |
| `session_open` | Creates `active <work>`, or revives the one live session whose title matches, and is the only way back from `done`. |
| `session_kick` | Wakes a live session: marks it active, then delivers one message. |
| `session_park` | Marks a session idle by title only — no message, no compaction, nothing already running is touched. |
| `session_kill` | Parks the session and interrupts its active execution, covering that session alone. |

## Requirements

OpenCode V2, with Node 22 or newer.

## Going deeper

The manual at [docs/GUIDE.md](docs/GUIDE.md) covers every tool's arguments and return shape, the title-prefix state machine, how titles are resolved, the failure payloads, and what the plugin deliberately does not do.

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
