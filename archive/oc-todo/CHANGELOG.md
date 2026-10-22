# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

2026-10-21 — End of life: no 0.5.2 will be published. OpenCode 2.1.0 restored the built-in `todowrite` tool — see `EOL.md`. npm keeps 0.5.1 and is deprecated; repository archived.

## [0.5.1] - 2026-10-20

- Packaging/docs patch: README and npm page refresh; no code change.

## [0.5.0] - 2026-10-16

New user-facing feature: the `/show-todos` inspector panel, plus the house
brand shape pass and host dependency pins.

- Added: `/show-todos` inspector panel (`session.panel`, contributed by
  `knightb8` in PR #2) - a read-only inspector for the current session with
  a selectable list, bounded metadata, and the selected item's full content
  plus notes. Specified in `docs/specs/v0.5.0.md` with unit tests for the
  pure renderers (tests: 98 -> 133).
- Change: house brand shape pass (README skeleton, icon and signature
  assets, verbatim house LICENSE).
- Pins: host `@opencode/plugin` `2.0.30`, `@opentui/*` peers `>=0.5.17`.

## [0.4.0] - 2026-10-09

Direct-tool registration plus the V1-style sidebar rework and defect fixes.

- Change: `todo` is registered as a DIRECT tool (`codemode: false`), so the
  model sees it without the `execute` detour.
- Change: trigger-first tool description plus an `action` hint, so the first
  touchpoint names the trigger before the parameters.
- Sidebar: V1-style glyphs - header `\u25BC`/`\u25B6` toggle and item marks
  `\u25CB` pending / `\u25D0` in_progress / `\u25CF` completed / `\u2297`
  cancelled (written here as `\u` escapes, never literals).
- Sidebar: an empty-state hint row, so an empty list explains itself instead
  of rendering blank.
- Fix: width-aware clipping, so a wide-character value cannot wrap the row.
- Fix: refresh holds last-good rows on error, so a failed refresh never blanks
  the list.
- Fix: blank-id drop, `update` trim/blank guard, and `add` id-uniqueness, so
  malformed or colliding ids cannot corrupt identity/`createdAt`.
- Fix: `scanSessionRows` follows `next`, so paged session scans reach every
  row.

## [0.3.1] - 2026-10-07

Packaging-toolchain and documentation corrections. No behaviour change in
`index.ts` and no change to the tool surface.

- Dev: declare `typescript` in `devDependencies`. `check` runs `tsc --noEmit`,
  but `typescript` reached `node_modules/.bin` only transitively (a peer of
  `bun-ffi-structs` under `@opentui/core`), so a lock refresh or a peer-chain
  change could silently remove `tsc` and break `check.yml` and the release.
- Docs: the README action table now lists `move` (shipped in 0.2.0) and the
  `[notes]` argument on `add` / `update` (also shipped in 0.2.0).
- Docs: `docs/specs/v0.2.0.md` stated the `move` `position` clamps to
  `[0, length-1]`; the code clamps to `[0, length]`, so a position at or past
  the end appends to the end. The spec now matches the code and the test.
- Tests: unchanged at 87.

## [0.3.0] - 2026-10-06

Tool-contract tightening plus the TUI-native sidebar rework.

- Change: `write` now requires `todos`. A `write` with no `todos` is refused with
  `write requires todos` and changes nothing (previously it cleared the list).
- Change: `update` refuses an out-of-vocabulary `status` or `priority` with
  `update: status must be one of pending, in_progress, completed, cancelled` /
  `update: priority must be one of high, medium, low` and changes nothing.
  `add` and `write` still default an unknown value to `pending`/`medium`.
- Change: `open` orders by priority (`high` → `medium` → `low`) then `updatedAt`
  descending, so the order is deterministic for a given set of rows; exact
  (priority, `updatedAt`) ties keep their input order.
- Sidebar: single-cell status marks — `-` pending, `~` in_progress, `x`
  completed, `/` cancelled — replacing the shared `-` (pending/cancelled) and the
  three-cell `[x]` tokens. Every row is a one-cell label column plus its
  guaranteed separator, then a value clipped to a 28-cell budget; the header
  uses an ASCII `v`/`>` toggle and no longer renders `✓`. The marks, the toggle,
  and the ellipsis are single-cell and narrow; a wide-character content value is
  clipped at render time, so the row cannot wrap.
- Tests: 70 -> 87 (cell-width assertions for the pure `sidebarLines` renderer).

## [0.2.3] - 2026-10-05

Certification hardening. No feature or contract change.

- Fix: `coerce` now repairs non-finite timestamps (`NaN`, `Infinity`,
  `-Infinity`) on a stored row to `0`, instead of letting them through. Such
  values are `typeof "number"` but JSON-serialize to `null`, which violated the
  `list` output contract (`{type:"number"}`) and `open`'s required `updatedAt`.
  Reachable only via a hand-edited or partially-written stored row — the exact
  surface `coerce` exists to defend.
- Tests: 69 -> 70.

## [0.2.2] - 2026-10-05

Post-release review fixes for the 0.2.1 hardening. No feature or contract
change; correctness and enforcement only.

- Fix: the tool schema's move-selector guard is scoped to `action: "move"` (via
  `if`/`then`) instead of a root `oneOf`. Previously the global guard rejected
  ANY call carrying two of `before`/`after`/`position`, including non-move
  actions that never read them. Runtime `applyMutation` stays authoritative for
  the zero/one/many cases and their exact summaries.
- Build: `check` now runs `bun test && tsc --noEmit`, so `tsc` is enforced by
  CI (`.github/workflows/check.yml` runs `bun run check`) and by
  `prepublishOnly`, closing the gap where type regressions went unchecked.
- Test: the move-bumps-`updatedAt` assertion pins and advances `Date.now`, so
  the strict `toBeGreaterThan` is deterministic rather than depending on the
  move landing in a later millisecond (the no-op test's `toBe(before)` still
  holds).
- Docs: `docs/specs/v0.2.0.md` records the `>1` selector refusal and its exact
  summary string `move: give exactly one of before, after, or position`, matching
  the code and CHANGELOG.
- Tests: 65 -> 69.

## [0.2.1] - 2026-10-05

Post-release review fixes. No feature change; hardening only. Behaviour change:
`move` now refuses more than one selector instead of silently preferring `before`.

- Fix: `move` enforces exactly one of `before` / `after` / `position`. A call with
  more than one is refused with `move: give exactly one of before, after, or
  position` and changes nothing (previously `before` won and the others were
  silently ignored). Mirrored in the tool schema wording (and a `oneOf` guard).
- Fix: `update` with a non-array `notes` is ignored like `add`/`write`, never a
  delete of existing notes.
- Fix: `write` re-checks a regenerated id until it is unique against both ids used
  in the same write and ids owned by the previous list (bounded), so a collision
  can no longer make one item inherit another's identity/`createdAt`.
- Test: the "real move bumps `updatedAt`" assertion now compares the moved item
  against its OWN prior `updatedAt` (strict), not a different item.
- Tests: 61 -> 65.

## [0.2.0] - 2026-10-05

Tier 1 slice. Contract change: item shape, tool schema, and RPC.

- **#1 Cross-session list** — new `todo.open` RPC returns every unfinished todo
  across all stored sessions, each tagged with its `sessionID`; a new `open` tool
  action renders it. `todo.list` stays per-session.
- **#2 Move / reorder** — new `move` action with `before` / `after` / `position`
  (id resolved by exact/prefix). Position is clamped after removal; a no-op move
  does not bump `updatedAt`.
- **#3 Notes on an item** — optional `notes: string[]` on `add`, `update`
  (replace; empty clears), and `write`; malformed stored notes are repaired by
  `coerce`; `format` indents them under their item line.
- **#4 Counts summary line** — `format` ends with `3 open · 1 in progress · 2 done`;
  `cancelled` is counted in none of the three.
- Sidebar: each item shows a compact note count when it has notes.
- Tests: 32 -> 61.

## [0.1.2] - 2026-10-05

- A no-op `update` is now correctly reported. Re-supplying a todo's current
  content, status, or priority is reported as `nothing to change` and no longer
  bumps `updatedAt`; a field that genuinely differs still updates.
- Tests: 28 -> 32.

## [0.1.1] - 2026-10-05

- Post-release review pass. No behaviour change for normal use.
- An ambiguous id prefix is refused with a reason instead of silently editing
  the first match; an exact id now always wins over a prefix match.
- Per-session serial queue around read → mutate → write, so concurrent
  code-mode calls cannot drop a mutation.
- Sidebar: a stale failed refresh can no longer blank the session you moved to.
- `package.json` declares `@opencode/plugin` and the OpenTUI/solid-js peers.
- Hardening: malformed stored rows are repaired instead of rejecting the list;
  non-string content can no longer throw or corrupt state; `write` de-duplicates
  a repeated id; no-op mutations no longer rewrite storage or emit `changed`.
- Tests: 15 → 28.

## [0.1.0] - 2026-10-05

- Initial release.
- `todo` tool: `list`, `write` (V1 `todowrite` parity), `add`, `update`,
  `complete`, `clear`.
- Per-session storage under `todos/session/<sessionID>`; survives turns and
  server restarts.
- `todo.list` RPC contract (plain JSON Schema) read by the TUI.
- Sidebar checklist (`tui.tsx`): hides when empty, full list while work
  remains, collapses to `✓ Todos n/n` when every item is closed.
- Dependency-free entrypoints (the stock server runtime does not inject
  `@opencode/plugin` for local directory plugins).
