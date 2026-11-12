# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `session_ask`: send one question and wait until the peer idles, bounded by `waitMs`, returning only the assistant messages after the accepted `askedMessageID` up to the next user message.
- `session_wait`: block until a peer idles without sending anything, giving up after `waitMs` with `timedOut: true`.
- `session_reply`: answer the asker with `text` carrying `re` as `metadata.re`, merged with an optional caller-supplied `metadata` object.
- `session_thread`: read one exchange as an ordered both-sides view from a `messageID`, stopping before the next user message.
- `session_broadcast`: ask one question of many peers at once and return one row per target with its answer or its error, never a rejected batch.
- `parentID` on `session_list`: list only one dispatcher's workers; rows carry `parentID`, empty for a top-level session.
- `metadata` on `session_send` (and on `session_ask`, `session_reply` and `session_broadcast`): an optional object carried in the prompt body so the peer can see who sent it and which message it answers.
- `cursor` and `since` on `session_read`: page forward with an opaque cursor or keep only newer messages by id or `created` timestamp; rows now carry `metadata`, `outcome`, `finish` and `completed` where sent, and return `{ messages, cursor }` when either is given.

## [0.3.0] - 2026-11-13

The surface is two tools. Everything else is gone, and the backend is the local
service over HTTP instead of one CLI child per call.

### Added

- `talk_send`: deliver one message into a session by id or unique title, queued behind the target's current turn, returning the admission (`{id, sessionID, title, delivered}`) in milliseconds; an optional `wait` blocks until the target reaches a turn boundary and returns `{timedOut, waitedMs, messages}`.
- `talk_inbox`: read a session's messages as `{id, role, text, tools, time}`, newest first, default 20; `session` defaults to the calling session, `since` keeps only what is newer, `cursor` pages, and `wait` blocks until a turn boundary first.
- `src/transport.mjs`: the only HTTP client in the package — endpoint resolution from the running service's state, loopback rewrite, one keep-alive agent, and the same four error codes the CLI seam returned.

### Changed

- The transport is HTTP to the running service: `POST /api/session/{id}/prompt` with a client-generated `msg_` id (idempotent retry), `GET /api/session/{id}/message` for reads, and `GET /api/session?search=` for title resolution.
- A turn boundary is read from the message stream (`type: "idle"`) instead of the experimental wait route.

### Removed

- The eleven lifecycle and conversation tools (`session_list`, `session_send`, `session_read`, `session_close`, `session_open`, `session_kick`, `session_park`, `session_kill`, `session_ask`, `session_wait`, `session_reply`, `session_thread`, `session_broadcast`), the `done` title lock and its prefix state machine, and `docs/GUIDE.md`, which documented that surface.

## [0.1.8] - 2026-11-02

### Changed

- Removed the `session_await` tool (send-then-poll queued messages behind long turns); `session_send` and `session_kick` now default to `steer`.

### Removed

- The `timeoutMs` argument, which only `session_await` took.

## [0.1.7] - 2026-11-01

### Fixed

- Keep one tool registration per host location; a single module-level registration let the second location dispose the first location's tools, so the live service exposed zero oc-talk tools.

## [0.1.6] - 2026-11-01

### Fixed

- `@opencode/plugin` is a runtime dependency; as a peer it was absent from the published install, so the import failed and no tools registered.

## [0.1.5] - 2026-11-01

### Fixed

- Ported to the V2 plugin definition (`Plugin.define`); the previous object export was loaded but never executed, so no tools registered.

## [0.1.4] - 2026-11-01

### Fixed

- Registering tools is idempotent across a plugin reload: `setup` disposes the previous tool-transform registration before creating a new one, so a reload leaves exactly one live registration instead of zero tools until a full restart. The cleanup `setup` returns disposes that registration on unload.

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
