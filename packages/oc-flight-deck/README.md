<p align="center">
  <img src="https://raw.githubusercontent.com/nathwn12/oc-collections/main/packages/oc-flight-deck/assets/icon.svg" width="120" height="120" alt="oc-flight-deck icon" />
</p>

<h1 align="center">oc-flight-deck</h1>

<p align="center"><strong>Live cost, token, cache and context telemetry for every OpenCode session in your sidebar.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/oc-flight-deck"><img src="https://img.shields.io/npm/v/oc-flight-deck" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="Windows and Linux" />
  <a href="https://github.com/nathwn12/oc-collections/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT licence" /></a>
</p>

## Install

Add the entry to the `plugins` array in your `opencode.jsonc`, then restart OpenCode:

```json
{ "plugins": ["oc-flight-deck"] }
```

## First use

Open a session and check that the telemetry panel appears beside it.

The rail draws up to 22 named fields in the order you choose; `MAX_LINES` (24) caps fixed lines plus live rows together. Among the fields:

- **Honest zeros** — every numeric row draws a real zero when there is no data, never a dash or a blank.
- **Money** — the current model's spend for this session, and a durable lifetime total for the subagent tree. The old `cost` and `total` row names still work as aliases.
- **Tokens and cache** — input and output tokens, and a cache hit rate with writes excluded.
- **Context gauge** — occupancy as a bar plus a percentage, marked `~` when estimated.
- **Speed** — a settled-turn average, a realtime estimate, or both plus time to first token.
- **Caution annunciator** — an opt-in watchdog that stays silent until a tool or a turn stops moving, and reports what it saw without killing anything.
- **Quota and session rows** — the Go usage dials, and a session id row that copies the full id on click.

A cache hit rate excludes writes from its denominator, because a write is not a lookup. Elapsed time is recomputed from the turn spans the host recorded, so it survives a restart and never steps backwards. Estimates carry a `~` and say so out loud.

### Configure it

All settings live in one global file; there are no per-project files. Start from the [example config](https://github.com/nathwn12/oc-collections/blob/main/packages/oc-flight-deck/flight-deck.example.jsonc) and check the [schema](https://github.com/nathwn12/oc-collections/blob/main/packages/oc-flight-deck/flight-deck.schema.json) for each key and its default.

## Requirements

- OpenCode 2.1.1 or newer.
- Node 22 or newer, or Bun 1.4 or newer.
- Any platform the host runs on.

## Status

**Unverified** — as-is, use at your own risk.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Guide](https://github.com/nathwn12/oc-collections/blob/main/packages/oc-flight-deck/docs/GUIDE.md)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)
