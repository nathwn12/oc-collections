# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-13

Queue delivery is removed. Every send steers, and the lane is no longer decided
for the caller.

### Removed

- `delivery: "queue"` and `delivery: "auto"`. `steer` is the only lane: a request naming either removed value is a typed `bad_request` — `queue removed; oc-talk is steer-only` — rather than a silent steer, because changing a caller's lane changes the meaning of what they wrote.
- The urgency classifier, with its halt, correction and deferring phrase tables and the length guard that existed only to keep a long brief from being steered. No wording routes a message any more.
- The `[queue]` and `QUEUE:` delivery markers. They are ordinary text now and are delivered as written.

### Changed

- `wait` is a post-send idle poll, not a lane. It runs after the message was admitted, reads the target's next turn boundary, and cannot change what was sent: a steered message with `wait` is still steered, and a bounded wait that gives up still reports `timedOut: true`.
- `deliveryReason` is one of `explicit`, `marker` or `default`.
- The transport's fallback lane is `steer`, so the wire never carries `queue`.

## [0.4.1] - 2026-11-13

The registry's `0.4.0` is the build before the correction; this release carries the correction.

### Fixed

- `0.4.0` shipped the delivery classifier with a trigger set that fired on bare words, so ordinary handoffs — "don't forget the changelog", "use pnpm instead of npm here" — were steered into a peer's running turn. That trigger set is replaced by two tight tiers and a veto list that beats both: a short message that opens with a halt command, or one that carries an unambiguous correction phrase anywhere, steers; deferring, temporal and substitutional phrasing vetoes both tiers and always queues.
- Marker stripping is correct on a Markdown link: `[queue](https://example.com)` is delivered byte for byte, because a marker is routing only when it is followed by whitespace or the end of the text.
- A body that is only a marker is a typed `bad_request` naming the real problem — there is nothing to deliver — instead of admitting an empty message into the peer.
- A positive `wait` always queues, even with an explicit `delivery: "steer"` or a `[steer]` marker, so the wait reads the boundary after the queued message rather than a boundary reached before a steered message was ever processed.

## [0.4.0] - 2026-11-13

The lane is chosen, not fixed: a correction reaches the peer inside its turn, and a handoff still waits for the next one.

### Added

- `talk_send` takes `delivery`: `auto` (default), `steer` or `queue`. `steer` is admitted into the target's current turn at its next step boundary; `queue` waits for the next turn. Any other value is a typed `bad_request`, and nothing is sent.
- Under `auto` the lane is resolved in this order: a positive `wait`, which always queues; an explicit `delivery`; a leading `[steer]`, `[queue]`, `STEER:` or `QUEUE:` marker, stripped from the delivered text; then two tight correction tiers — a message of 400 characters or fewer that opens with a halt command (`stop`, `halt`, `abort`, `cancel that`, `revert`, `undo`, `roll back`, `hold off`, `don't`, `do not`, `never mind`, `leave it`, `discard`, after at most one leading interjection or the peer's name), or that carries an unambiguous correction phrase anywhere (`that's wrong`, `not what i asked`, `wrong branch`, `wrong file`, `revert that`, `undo it`, `emergency`, `asap`, `urgent`, `immediately`, `credentials are exposed`, `stop the deploy`, …); everything else queues.
- Deferring, temporal and substitutional phrasing vetoes both tiers and always queues, because a false steer interrupts a peer mid-task while a false queue only costs latency: `don't forget`, `do not forget`, `wait for`, `when you are done`, `when you finish`, `instead of`, `no longer needed`, `no longer used`, `if you have time`.
- The reply carries `delivery` and `deliveryReason` (`explicit`, `marker`, `wait`, `urgent`, `handoff`) beside `{id, sessionID, title, delivered}`.

### Changed

- `talk_send` no longer hardcodes `queue`: a short "Stop — the migration is wrong, revert it." reaches the peer's current turn instead of waiting a full turn to be read. A long brief still queues, however many stop words it contains.

### Fixed

- The lane classifier steers only on a real correction. A single context-free token (`wrong`, `failed`, `red`, `critical`, `blocker`, `wait`, `instead`) no longer interrupts a peer: "don't forget to update the changelog", "wait for the build to finish", "the failed test is in the auth file", "cancel the pending release note draft" and "tests are red on main" all queue.
- A marker is routing only when `[steer]`, `[queue]`, `STEER:` or `QUEUE:` is followed by whitespace or the end of the text, so a Markdown link such as `[queue](https://example.com)` arrives byte for byte instead of being delivered mangled.
- A message that is only a marker is a typed `bad_request` naming the real problem — there is nothing to deliver — instead of admitting an empty body into the peer.
- A positive `wait` always queues, even with an explicit `delivery: "steer"` or a `[steer]` marker. The wait then always reads the boundary after the queued message, rather than a boundary reached before a steered message was ever processed.
- The tool description states the rule a calling model needs: `delivery` defaults to `auto`, a short correction or stop steers, a handoff queues, `wait` always queues, and `delivery` or an inline marker overrides `auto` but never `wait`.

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

- The thirteen lifecycle and conversation tools (`session_list`, `session_send`, `session_read`, `session_close`, `session_open`, `session_kick`, `session_park`, `session_kill`, `session_ask`, `session_wait`, `session_reply`, `session_thread`, `session_broadcast`), the `done` title lock and its prefix state machine, and `docs/GUIDE.md`, which documented that surface.

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
