# oc-flight-deck

Live cost, token, cache, and context telemetry for every OpenCode session, drawn in your sidebar.

## Install

Add the entry to the `plugins` array in your `opencode.jsonc`, then restart OpenCode:

```json
{ "plugins": ["oc-flight-deck"] }
```

## What you get

| Capability | What it does for you |
| --- | --- |
| Session rail | Draws up to 18 named rows beside the session, each one live, in the order you choose. |
| Money | Rolls up this conversation plus its subagent tree, with project-wide spend on its own row. |
| Tokens and cache | Shows input and output tokens, and a cache hit rate whose denominator excludes writes, because a write is not a lookup. |
| Context gauge | Draws occupancy as a bar plus a percentage, and says out loud with a `~` that it is an estimate. |
| Elapsed time | Counts active turn time, recomputed from the turn spans the host recorded, so it survives a restart and never steps backwards. |
| Speed | Reports a settled-turn average, a realtime estimate, or both plus time to first token. |
| Caution annunciator | An opt-in watchdog row that stays silent until a tool or a turn stops moving, then reports what it observed without killing anything. |
| Quota and session rows | Draws the Go usage dials, and a session id row that copies the full id on click. |
| One config file | Keeps every setting in one global file, and nothing per project. |

## Requirements

OpenCode 2.1.1 or newer, with Node 22 or Bun 1.4 or newer, on any platform the host runs on.

## Going deeper

The manual at <https://github.com/nathwn12/oc-collections/blob/main/packages/oc-flight-deck/docs/GUIDE.md> covers every row and what its number means, every setting with its default, the refresh behaviour, and worked config recipes.

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
