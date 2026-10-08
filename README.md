<div align="center">

# oc-collections

**One plugin, many mini-plugins - a module host for OpenCode V2.**

</div>

---

## What it is

`oc-collections` consolidates three standalone plugins into one extensible
module host. One package to install, one generated config file, one compact
rail - and each mini-plugin (module) ships **off** until you enable it.

## Quick start

```jsonc
// opencode.jsonc
{ "plugins": ["oc-collections"] }
```

Restart OpenCode. On first load the plugin writes `oc-collections.jsonc` into your
opencode config directory (`OPENCODE_CONFIG_DIR`, or `~/.config/opencode`).
Every module ships **off** - set `"enabled": true` on the ones you want.

## Config

The server half owns the file: `~/.config/opencode/oc-collections.jsonc`
(`OPENCODE_CONFIG_DIR` overrides the directory). It is created from a template
on first load and never overwritten. EVERY module ships `"enabled": false`;
only `enabled` is a real key in the template - each module line carries a
trailing comment listing its option keys. Comments and trailing commas are fine
(JSONC). Host `options.modules` (plugin config) merges over the file key-by-key
per module.

## Modules

| Module | Summary |
|---|---|
| `***REMOVED***` | Out-of-band ***REMOVED*** watcher: one rail line, chat only on escalation. |
| `***REMOVED***` | ***REMOVED*** liveness + context daemon: wedge detection, context nudges, status/repair/reset. |
| `***REMOVED***` | Title-grammar enforcer: keeps top-level sessions as `<status> <seat>: <work>`. |

### ***REMOVED*** options

***REMOVED*** is **agent-only by default** - it renders nothing in any user-facing
window. The agent sees it through the `***REMOVED***` tool and its escalation steer
messages. Set `pulse: true` to opt into the one rail row.

| Key | Type | Default | Notes |
|---|---|---|---|
| `push` | boolean | `false` | Also steer ordinary (non-escalation) updates to the target. |
| `target` | string \| null | `null` | Escalation recipient; `null` = escalated session's nearest ancestor. |
| `watch` | string[] | `[]` | Extra session ids to watch besides auto-watched workers. |
| `sweepSeconds` | number | `5` | Sweep cadence in seconds. |
| `stallSeconds` | number | `600` | No-activity window while executing before a stall escalation. |
| `everyTerminal` | boolean | `true` | Escalate once when every watched session is terminal. |
| `terminalTokens` | string[] | `["done", "closed"]` | First-word title tokens that mean a session is finished (case-insensitive). |
| `staleSeconds` | number | `90` | Row staleness window in seconds. |
| `doneTtlSeconds` | number | `60` | How long a terminal session stays in the live view before ageing out. |
| `label` | string | `"***REMOVED***"` | Rail label override; only applies when `pulse: true`. |
| `pulse` | boolean | `false` | `true` = claim one `sidebar.content` slot and draw the rail row. |
| `escalationPrefix` | string | `"***REMOVED***"` | Leading token of every escalation text line. |

### ***REMOVED*** options

| Key | Type | Default | Notes |
|---|---|---|---|
| `repair` | boolean | `false` | `true` = interrupt with resume on a live wedge; `false` = record only. |
| `pulse` | boolean | `true` | `false` = the TUI claims no slot and shows nothing. |
| `pollSeconds` | number | `0.5` | Poll cadence in seconds. |
| `armSeconds` | number | `2.5` | Freshness window in seconds for the live indicator. |
| `staleSeconds` | number | `10` | Reader-freshness bound in seconds. |
| `label` | string | `"***REMOVED***"` | Rail label override. |
| `caution.exemptTools` | string[] | question, task, subagent, agent, delegate, delegate_many, delegate_task, tools.delegate, tools.delegate_many, tools.subagent, tools.task | Tools never treated as wedges. |
| `caution.toolCautionSeconds` | number | `420` | Legacy spelling of `fallbackSeconds`; still honoured when `fallbackSeconds` is absent. |
| `caution.fallbackSeconds` | number | `420` | Fallback per-tool bound in seconds. |
| `caution.ceilingSeconds` | number | `600` | Hard global ceiling; a non-exempt call older than this is wedged whatever its per-tool bound says. |
| `caution.perToolSeconds` | object | built-in table | Per-tool watch bounds in seconds, keyed by tool name. |
| `context.watch` | number | `30` | Percent of the session's own model window. |
| `context.nudge` | number | `45` | Percent of the session's own model window. |
| `context.critical` | number | `60` | Percent of the session's own model window. |
| `context.urgent` | number \| null | `null` | Optional fourth rung; absent = the rung does not exist. |
| `context.autoCompact` | boolean | `false` | Legacy boolean gate (stays `false`). |
| `context.autoCompactAt` | string \| null | `null` | Opt-in auto-compact gate band name; `null` = OFF. |
| `context.projection.turns` | number | `3` | Fire critical early when the window is projected to empty within this many turns; `<= 0` disables. |
| `context.maxPerSession` | integer | `3` | Hard per-session nudge cap. |
| `context.nudgeText` | string | `Context is at {pct}% ...` | Nudge template; `{pct}`, `{used}`, `{limit}` and `{band}` are substituted at fire time. |
| `context.safetyNudgeTokens` | number | `600000` | Token floor that can only raise idle/watch to nudge. |
| `context.perModel` | object | `{}` | Per-model overrides for `watch`/`nudge`/`critical`/`urgent`/`safetyNudgeTokens`, keyed by model id. |

### ***REMOVED*** options

| Key | Type | Default | Notes |
|---|---|---|---|
| `statuses` | string[] | `planned, active, done, blocked, inactive, closed` | Status vocabulary; first entry is the staged status, second the running one. |
| `seats` | string[] | twelve built-in seats | Known seat tokens; unknown agents fall back to `fallbackSeat`. |
| `fallbackSeat` | string | `"***REMOVED***"` | Seat used when the live agent is unknown, empty, or not a known seat. |
| `template` | string | `"{status} {seat}: {work}"` | Title template; `{status}`, `{seat}` and `{work}` are substituted. |
| `lowercase` | boolean | `true` | Titles are always lowercase when `true`. |
| `maxWork` | number | `0` | Cap on the work-tail length; `0` = uncapped. |
| `snippetLength` | number | `60` | Cap on the first-prompt snippet used when the title yields no work words. |
| `armSeconds` | number | `2.5` | Freshness window in seconds for the live renaming indicator. |
| `label` | string | `"***REMOVED***"` | Rail label override. |

***REMOVED*** renames top-level sessions only (child/subagent sessions are never
touched) into `<status> <seat>: <work>` - or your `template`. The seat is the
session's LIVE agent: every prompt event re-reads the session, so an agent
switch is reflected in the title. Renames are loop-safe (a conforming title is
a byte-equal no-op, and ***REMOVED*** never reacts to its own renames).

## Live values

The 0.2.0 contract: **every rail value is derived from current state.**

- A resolved error, block, or stall clears, and the row returns to `idle`.
- Nothing is a lifetime tally - counts describe the live view only, and
  terminal sessions age out of it (`doneTtlSeconds`).
- History is bounded (sessions unseen within the eviction window drop out of
  the live maps; retained ledger keys are pruned to the newest entries).

## Agent-facing tools

- `***REMOVED***` - `status`: live watched-session counts plus one line per watched
  session (`sid`, title, `executing`/`blocked`/`idle`, age since last
  activity). Read-only; live values only, no history.
- `***REMOVED***` - `status` (live-first: freshness, wedge state, context bands),
  `repair` (interrupt with resume on a live wedge), `reset` (clear live maps).
  Live values only; a drop lowers the reading - nothing is max-latched.

## Rail grammar

Every enabled module draws exactly one compact rail line in `sidebar.content`:

```
<glyph> <label> <segments joined by middle dot `\u00B7`>
```

| Tone | Glyph | Meaning |
|---|---|---|
| `ok` | `●` | healthy |
| `warn` | `◐` | degraded / needs attention |
| `error` | `✕` | wedged / failed |
| `idle` | `○` | quiet, mounted, nothing to report |
| `unknown` | `?` | unavailable |

- The label gutter is width **8** (padded/truncated to `LABEL_WIDTH`), so values never glue to labels.
- The unavailable state (no reading yet / host gone / latched / file absent-or-unreadable) always renders tone `unknown` with segments `["-?"]`.
- Rows are packed by enabled index: the first enabled row uses `marginTop 0`, later enabled rows use `marginTop -1` (the `index` passed to each mount is the position among ENABLED modules, 0-based).

## How to add a new module

1. Add one `MODULES` meta line in `src/core/meta.ts` (`id`, `title`, `summary`, `defaultEnabled: false`).
2. Add one `src/modules/<id>/` folder with the module halves (`server.ts` default-export setup, `tui.tsx` default-export mount, plus pure drawers).
3. Add one registry line per half (`src/server-registry.ts` `SETUPS` entry, `src/tui-registry.tsx` `MOUNTS` entry).

The host picks up the rest: config template, schema key, enable gating, and rail slot.

## Development

```sh
bun install
bun run check      # typecheck + tests
```

## Publishing

```sh
# one-time, on npmjs.com as the package owner:
npm trust github oc-collections --file release.yml --repo nathwn12/oc-collections --allow-publish

# then each release:
npm version patch        # or minor/major - bumps package.json, commits, tags
git push --follow-tags   # release.yml publishes to npm with provenance
```

Local alternative: `npm login` then `npm publish --public`.
