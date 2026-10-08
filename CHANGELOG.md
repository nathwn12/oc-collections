# Changelog

## 0.2.0

- Hands-free defaults: every module now ships ON by default (the generated config writes `"enabled": true`); set `false` to disable one.
- Live-only rails: every rail value is derived from current state. A resolved
  error, block, or stall clears and the row returns to `idle`; nothing is a
  lifetime tally (terminal sessions age out of the live view).
- Per-module configuration: ***REMOVED*** gains `terminalTokens`, `staleSeconds`,
  `doneTtlSeconds`, `label`, `escalationPrefix`; ***REMOVED*** gains `pollSeconds`,
  `armSeconds`, `staleSeconds`, `label` plus the full `caution.*`/`context.*`
  tuning surface; ***REMOVED*** is fully configurable (`statuses`, `seats`,
  `fallbackSeat`, `template`, `lowercase`, `maxWork`, `snippetLength`,
  `armSeconds`, `label`).
- General-purpose de-harnessing: no hardcoded seats, agents, or model windows;
  ***REMOVED*** auto-watches workers, ***REMOVED*** bands scale to each session's own model.
- ***REMOVED*** lowercase + configurable template (default `"{status} {seat}:
  {work}"`, `lowercase` default true) with the seat as the session's LIVE agent.
- Agent-facing `***REMOVED***` tool (`status`: live counts plus one line per watched
  session) and live-first `***REMOVED***` tool (`status`/`repair`/`reset`).
- Bounded history: unseen sessions are evicted from the live maps and retained
  ledger keys are pruned to the newest entries.

## 0.1.0

- Consolidation: three plugins (***REMOVED***, ***REMOVED***, ***REMOVED***) become one extensible module host (`oc-collections`).
- Generated all-off config: first load writes `oc-collections.jsonc` with every module `"enabled": false`.
- Redesigned compact rail: one line per enabled module under the unified rail grammar (tone + `["-?"]` unavailable idiom).
