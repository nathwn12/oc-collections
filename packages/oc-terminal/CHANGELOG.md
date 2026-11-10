# Changelog

All notable changes to this package are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Windows spawn guard: every reachable `node:child_process` spawn and
  `Bun.spawn`/`Bun.spawnSync` defaults to `windowsHide: true`; a real
  JavaScript runtime (`bun` or `node`) is resolved instead of the compiled
  host's `opencode.exe`; `terminal_status` reports whether the guard is live.
  It exists because `oc-graphify` spawned `process.execPath` for freshness,
  which launched a second OpenCode and left a dead Windows Terminal window.
  That root cause is fixed at the source in `packages/oc-graphify/lib.js`.
