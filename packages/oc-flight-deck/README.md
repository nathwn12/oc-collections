# oc-flight-deck

Live cost, token, cache, and context telemetry for every OpenCode session, drawn in your sidebar.

## Install

Add the entry to the `plugins` array in your `opencode.jsonc`, then restart OpenCode:

```json
{ "plugins": ["oc-flight-deck"] }
```

OpenCode resolves the plugin from the registry, so there is no separate install command. The panel renders beside your next open session with defaults and no config file. After the restart, open a session and check that the rail draws.

## What it does

- Shows cost and tokens for the open session plus its subagent tree, with project-wide spend alongside.
- Draws a context gauge that says out loud that it is an estimate.
- Survives a restart: elapsed time is recomputed from the turn spans the host recorded.
- Adds opt-in rows for branch, quota, session id, turn spark, and a watchdog that stays silent until something stops moving.
- Keeps every setting in one global file, and nothing per project.

## Requirements

Any platform OpenCode V2 runs on, with OpenCode 2.1.1 or newer, and Node 22 or Bun 1.4 or newer.

## Full documentation

- Guide: <https://github.com/nathwn12/oc-collections/blob/main/packages/oc-flight-deck/docs/GUIDE.md>
- Package: <https://www.npmjs.com/package/oc-flight-deck>

The guide covers every row, every setting and its default, config precedence, and worked recipes. It also links the example config, the JSON schema, the install notes, the changelog, and the licence.
