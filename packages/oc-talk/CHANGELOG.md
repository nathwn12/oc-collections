# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-11-01

### Added

- `delivery` argument on `session_send`, `session_kick`, `session_open` and `session_await`: `steer` preempts the peer's running turn, `queue` waits for it to finish.
- Defaults follow the caller's intent — `session_await` defaults to `steer` (the caller is blocked on the answer), `session_send`, `session_kick` and `session_open` default to `queue` (they must not derail the peer); an explicit value always wins.
- Any other value is a typed `bad_request`, never a silent fallback.

### Changed

- Tool descriptions are at most three sentences each: the when-to-use sentence and the refusal rule stay, the rest is gone.

## [0.1.2] - 2026-11-01

### Changed

- Docs only: the package is published on npm, so the README now gives the registry install route first and keeps the two local checkout routes as the development alternative.

## [0.1.1] - 2026-10-31

### Changed

- Plugin id is `oc-talk` (was `session-talk`); tool names are unchanged.

## [0.1.0] - 2026-10-31

### Added

- `session_list`: every live session as id, title, directory and last-update time.
- `session_send`: one text message to a peer session by id or unambiguous title substring, `resume` defaulting to true so the peer's loop runs.
- `session_read`: a peer's newest messages, newest first, default 20, text verbatim.
- Title resolution is exact-substring and case-sensitive; a missing title returns a typed error with near-misses and an ambiguous title returns a typed error with candidates, never a guess.
- The backend is the `opencode api` CLI spawned with argv and a 20 s timeout, so this package never reads, returns or logs the harness's credentials.

[0.1.0]: https://github.com/nathwn12/oc-collections/releases/tag/oc-talk-v0.1.0
