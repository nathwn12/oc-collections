# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-10-15

### Removed

- No TUI surface: the plugin is a silent background helper and renders
  nothing - no sidebar slot, no rows, no render tick. The unified renderer,
  the shared drawer, and the composer module are gone with every row, tick
  set, trace style, frame clock, and config key they owned. A leftover
  `panel` block in the config file is unread and meaningless - never an
  error and never a render.

### Kept

- The three surviving features, running silently: **fleet** (the session
  watcher: event subscription, 1s sweep, status-file writer, escalation
  notes), **lifeline** (the tool-liveness daemon: heartbeat, `oc-lifeline`
  snapshot RPC, `lifeline` tool `status` / `repair`, wedge observation
  ledger, silent note channel), and **masthead** (session-title renaming in
  the configured `<status> <seat>: <work>` grammar, `oc-masthead` snapshot
  RPC).

## [0.3.0] - 2026-10-15

### Changed

- Generalized for any OpenCode V2 user: every harness-specific assumption moved
  into config with neutral defaults; a tree that configured nothing is now
  observe-only. Config file defaults to `oc-unified.jsonc` (XDG-aware) with an
  explicit path override (registration `config` option, then
  `OC_UNIFIED_CONFIG`); both plugin spec forms work (bare string and
  `{package, options}`, options merged over the file). Masthead ships empty
  status/seat vocabularies (new `legacySeats` key) plus an `isEnforcingConfig`
  observe-only gate. Fleet gains `recipient` (`nearest-ancestor` default |
  `"off"`), `terminalTokens` (host status preferred, title token fallback), and
  `autoWatchChildren` (default true, keeping historical behavior). Lifeline's
  per-tool table and global ceiling ship as `DEFAULT_TOOL_WATCH_MS` /
  `DEFAULT_CEILING_MS` with `caution.toolBoundsMs` / `caution.ceilingSeconds`
  overrides. Marker paths sit under a platform-generic state directory
  (`OC_UNIFIED_STATE` / `stateDir` option pins a historical path). README
  rewritten for a stranger (features, both install tracks, neutral-default
  options table, RPC ids, `lifeline` tool).

### Removed

- The advisory context-band nudger is gone (replaced by the DCP plugin): the band ladder, the dynamic nudge window, the projection and safety paths, the per-session cap, the burn-rate measurement, the band-driven auto-compact gate, and the `lifeline` tool's `reset` action (the tool keeps `status` / `repair`). The `context` config block is no longer read. Kept intact: the liveness sweep, the observation ledger, the silent `context` note channel, the `oc-lifeline` RPC, and the `lifeline` / `caution` policy blocks.

### Changed

- Masthead title vocabulary is now genuinely configurable: `parseCloseStatus` reads the configured status tokens (falling back to the defaults for existing 1-arg callers), the default seat set drops the retired `fleet`/`commander` tokens to `LEGACY_SEATS` (still accepted on read) with `orsted` as the fallback seat, and a new `titleRe(config)` builds the conforming-title shape from configuration (`TITLE_RE` keeps its name as the default instance).

- Cleared check-2 markers: renamed the fixture test-double helper to `fakeContext` and reworded marker-like prose in `fixtures/run.ts` and `README.md`. The three residual matches are base64 integrity hashes in `bun.lock`, recorded in `GATE-ALLOWLIST.md`.

## [0.1.0] - 2026-10-13

### Added

- Initial release: one OpenCode v2 plugin carrying the fleet watcher, the lifeline daemon, and the title renamer as internal features.
