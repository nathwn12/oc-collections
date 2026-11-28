# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The card now renders `details: Coding with <model display name>` and `state: Reasoning <Level>` instead of a single combined line. `details` no longer repeats the header name; `state` is omitted entirely at `default` (any case) or with no variant.
- The model's human name comes from `ctx.model.list()` (matching `modelID` before `id` inside the session's `providerID`), with a deterministic prettifier fallback instead of the raw id. A catalogue name that arrives late replaces the fallback on the next send.
- Levels use display names (`Low`, `Medium`, `High`, `XHigh`, `Max`, `Minimal`) with first-letter capitalisation for anything else; no middle dot or parentheses remain on the text lines.
- `assets.large_text` carries `<providerID> · <version>` from `ctx.app.version`, omitted when neither part is known. `type` is explicitly `0` (`Playing`).
- The clock is unchanged: `timestamps.start` is when OpenCode opened, with no end timestamp, mode, persistence or command.

[Unreleased]: https://github.com/nathwn12/oc-collections/compare/oc-discord-rpc-v0.1.0...HEAD

## [0.1.0] - 2026-11-28

### Added

- The first release: a Discord IPC transport over the local discord-ipc-0 through discord-ipc-9 sockets, a presence model with the app name as details, the explicitly selected model with effort as state, and a clock from when OpenCode opened that keeps counting, plus the plugin wiring that registers it with OpenCode.

[0.1.0]: https://github.com/nathwn12/oc-collections/releases/tag/oc-discord-rpc-v0.1.0
