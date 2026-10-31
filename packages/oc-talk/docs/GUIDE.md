<h1 align="center">oc-talk guide</h1>

This package is private and unpublished. It is not installable from a registry; the README carries the two local routes.

## How it works

The plugin registers nine tools on session start and shells out to the `opencode api` CLI it is running inside: `session.list`, `session.get`, `session.message.list`, `post /api/session`, `patch /api/session/{id}`, `post /api/session/{id}/prompt`, `post /api/session/{id}/compact` and `post /api/session/{id}/interrupt`. It spawns that binary with an argument vector — no shell, no interpolation — and a 20-second timeout per call.

That CLI already discovers and authenticates with the harness's own background server. **This package never handles credentials:** it opens no auth file, reads no environment secret, resolves no port, and never returns or logs anything of the kind. The only thing it sees from the child process is the JSON that child prints.

Every tool returns JSON in `content`. A failure is returned as `{ "error": "…", "reason": "…", "candidates": [ … ] }`, never thrown, so a wrong name is a readable answer rather than a crashed turn.

### The title prefix is the state

A session's state is its title prefix, and there are three:

- `active ` — live and working.
- `parked ` — live but marked idle. Park rewrites the title and nothing else, so work already running in that session keeps running until it finishes.
- `done ` — closed; the record stays, the session is out of play.

The prefix is **replaced, never stacked**. Every rename strips an existing lifecycle prefix first, so `parked active foo` collapses to `active foo` instead of piling up. A rename that would change nothing sends no request.

`done` is a **lock**. `session_send`, `session_kick`, `session_park`, `session_kill` and `session_await` refuse it with `{ "error": "session_closed", … }`. `session_open` is the only verb that may lift it, and the only way back in. The `done` lock is advisory: it is checked before an action and again inside the rename, but neither check is atomic with the write it guards, so a close that races an in-flight call can be overwritten.

`session_park` is graceful: the title only, no message, no compaction. `session_kill` is hard: the same rename, then an interrupt of the active execution. That interrupt covers only the target — `cascaded` is always `false`, and child session ids come back as a `children` id list, never claimed stopped.

There is no delete verb, by design. A session is the record of what was attempted.

### Titles are never guessed

`to` is matched as a case-sensitive substring of the session title, over a bounded paginated scan of the whole estate — 1000 sessions a page, at most 20 pages. Any value beginning with `ses_` is taken as an id and resolved directly, with no list and no ambiguity.

Resolution takes an id first, then a title substring. Ambiguous matches and capped scans refuse rather than guess.

## Configuration

There is nothing to configure. The plugin reads no config file, takes no options, and reads no environment variable: it uses the same `opencode` binary that is running it, and the harness's own server discovery and authentication.

| Setting | Default | Effect |
| --- | --- | --- |
| *(none)* | — | The package has no options and no environment variables. |
| per-call `timeoutMs` | `60000`, capped at `300000` | `session_await`'s wait budget after the send. |
| internal call timeout | `20000` ms | Per backend round trip, fixed in the source. |

## Tools

### `session_list`

| Argument | Required | Meaning |
| --- | --- | --- |
| `limit` | no | Page size; default is the server's own page (newest 50) |
| `cursor` | no | Opaque cursor from a previous `session_list` response |

Returns one page of live sessions as `id`, `title`, `directory`, `updated` (last-update time) and `parentID` (empty for a top-level session): a bare array when neither argument is given, and `{ sessions, cursor }` when either is, so paging is explicit rather than implied. It is not the whole estate — it is the page the server returns, newest first, 50 by default; pass `limit` and then the `cursor` from the response to walk further. Lists only: it never sends, reads, wakes or steers anything.

```json
session_list
→ [ { "id": "ses_1f2e…", "title": "api-smoke-tests", "directory": "…", "updated": 1793… } ]
```

### `session_send`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `text` | yes | Message text, delivered verbatim |
| `resume` | no | Let the receiver's loop run; defaults to `true` |

Sends one message and returns `{ id, sessionID, created }`. It never reads history, and it refuses a `done` session — that lock is lifted only by `session_open`.

```json
session_send { "to": "api-smoke-tests", "text": "Run the smoke suite and reply with the failing test names." }
→ { "id": "msg_8c11…", "sessionID": "ses_1f2e…", "created": 1793… }
```

### `session_read`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `limit` | no | Newest messages to return; default 20, clamped to 1–100 |

Returns an array of `{ id, type, created, text }`, newest first, text verbatim including newlines. Reads only: it never sends, wakes or steers the other session.

```json
session_read { "to": "ses_1f2e…", "limit": 2 }
→ [ { "id": "msg_9a02…", "type": "assistant", "created": 1793…, "text": "Two failures: auth.rejects_expired and auth.timeout_429." },
    { "id": "msg_8c11…", "type": "user",      "created": 1793…, "text": "Run the smoke suite and reply with the failing test names." } ]
```

The newest message is first, so the peer's answer is the first element.

### `session_await`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `text` | yes | Message text, delivered verbatim |
| `timeoutMs` | no | Wait budget in ms; default 60000, capped at 300000 |

Sends one message with `resume` forced to `true`, then polls the session's messages about once a second for an assistant message created after the send. On a reply it returns `{ sessionID, text, messageId, timeoutMs }`; on expiry `{ sessionID, timeout: true, lastSeen, timeoutMs }` with the newest text it saw, so a slow peer is a readable answer rather than a hung call. The budget bounds the wait **after** the send, not the whole call: each poll is one backend round trip with its own 20-second timeout, so a call can overrun its budget by up to one poll. It refuses a `done` session.

```json
session_await { "to": "api-smoke-tests", "text": "Run the smoke suite and reply with the failing test names.", "timeoutMs": 120000 }
→ { "sessionID": "ses_1f2e…", "text": "Two failures: auth.rejects_expired and auth.timeout_429.", "messageId": "msg_9a02…", "timeoutMs": 120000 }
```

### `session_close`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `title` | no | Explicit final title; defaults to `done <current title>` |

Closes a finished session in one call: renames it to `done <work>`, then compacts it. The order is fixed — rename, then compact, never the other way. An explicit `title` wins, but it is normalized to the same `done ` prefix, so a close can never leave a compacted session reading as live; a session that is already `done` is left byte-identical and reported `already-closed` rather than double-prefixed. Returns `{ sessionID, titleBefore, titleAfter, compacted, compactionId, alreadyClosed, status }`; if the compaction fails after a successful rename, the error names both titles so the state stays readable.

```json
session_close { "to": "ses_1f2e…" }
→ { "sessionID": "ses_1f2e…", "titleBefore": "api-smoke-tests", "titleAfter": "done api-smoke-tests", "compacted": true, "alreadyClosed": false, "status": "closed" }
```

### `session_open`

| Argument | Required | Meaning |
| --- | --- | --- |
| `work` | yes | Short work label; the new title becomes `active <work>` |
| `text` | no | Optional one-shot prompt delivered after the open |
| `resume` | no | Let the receiver's loop run after the prompt; defaults to `true` |

Creates a session titled `active <work>`, or revives one: when exactly one live session title contains `work`, that session is reopened to `active <work>` instead of a second one being made. Zero matches create; several fail `ambiguous_session` with candidates. A scan that hits its page cap never revives an existing session: if the capped scan found exactly one match, `session_open` creates a new session titled `active <work>`, and if it found more than one it returns `ambiguous_session` with the candidates. This is the only verb that lifts `done`. Returns `{ sessionID, titleBefore, titleAfter, reopened, resume, messageID }`.

```json
session_open { "work": "api-smoke-tests" }
→ { "sessionID": "ses_7c40…", "titleBefore": "", "titleAfter": "active api-smoke-tests", "reopened": false, "resume": true, "messageID": null }
```

### `session_kick`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `text` | yes | Message text, delivered verbatim |
| `resume` | no | Let the receiver's loop run; defaults to `true` |

Wakes a live session: renames it to `active <work>`, then delivers one message. Returns `{ sessionID, titleBefore, titleAfter, messageID, resumed }`. A `done` session is refused — reopen it with `session_open` first.

```json
session_kick { "to": "parked api-smoke-tests", "text": "One more run, please." }
→ { "sessionID": "ses_1f2e…", "titleBefore": "parked api-smoke-tests", "titleAfter": "active api-smoke-tests", "messageID": "msg_5f31…", "resumed": true }
```

### `session_park`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |

Rewrites the title to `parked <work>` and returns. Prefix only: no message is sent and no compaction runs, so anything already in flight is left alone. Returns `{ sessionID, titleBefore, titleAfter }`. A `done` session is refused.

```json
session_park { "to": "ses_1f2e…" }
→ { "sessionID": "ses_1f2e…", "titleBefore": "active api-smoke-tests", "titleAfter": "parked api-smoke-tests" }
```

### `session_kill`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |

Rewrites the title to `parked <work>`, then interrupts the session's active execution. Park is graceful, kill is hard. Returns `{ sessionID, titleBefore, titleAfter, interrupted, cascaded, children }`, with `cascaded` always `false`. `children` lists up to 1,000 child sessions in one page. It reports their ids; it does not report whether they are running. A `done` session is refused.

```json
session_kill { "to": "ses_1f2e…" }
→ { "sessionID": "ses_1f2e…", "titleBefore": "active api-smoke-tests", "titleAfter": "parked api-smoke-tests", "interrupted": true, "cascaded": false, "children": ["ses_9b02…"] }
```

## Worked example

You are the agent in a build session and the test session is running beside you.

1. Find the peer with `session_list`.
2. Hand it a job with `session_send`. `resume` is left off, so it defaults to `true` and the peer actually runs.
3. The peer replies into its own session, as a normal assistant message. Nothing is pushed to you — you read it with `session_read`, and the newest message is first. Poll once more if the peer is still working: a session that has not answered yet simply has no newer assistant message. When one call is cleaner than two, `session_await` does steps 2 and 3 together and returns the reply text itself, or `{ "timeout": true, "lastSeen": … }` if the budget runs out first.
4. Close it with `session_close` when it is finished, so the next reader sees a closed session rather than a live one.

## Troubleshooting

**A tool returns `session_closed`.** The target is `done`. Only `session_open` lifts that lock; reopen it, or pick a live session.

**A tool returns `ambiguous_session`.** The title substring matches more than one session. Pass the `ses_…` id from `session_list` instead — an id is resolved directly, with no scan and no ambiguity.

**`session_await` returns `timeout: true`.** The peer had not answered within the budget. `lastSeen` carries the newest text it saw, so you can tell "still working" from "answered before the send". Raise `timeoutMs`, up to 300000.

**A title looks like `parked active foo`.** It should not: every rename strips the previous lifecycle prefix first. If you see a stacked prefix, it was written by something other than this plugin.

**`session_open` created a new session instead of reviving one.** Either nothing matched, or the bounded scan hit its page cap — a capped scan never revives. Narrow the `work` label so exactly one live title matches.

**A close raced an in-flight call.** The `done` lock is advisory, not atomic. A close that overlaps another rename can be overwritten; re-read the title and close again.

**`session_kill` interrupted nothing.** It interrupts the target's active execution only. With nothing running there is nothing to interrupt, and `children` are reported, never claimed stopped.

**A backend call failed.** Each call has a 20-second timeout. The failure comes back as JSON in `content`, not as a thrown error, so the turn continues.

## Limitations

- Private and unpublished: no registry install, no version to pin, and no release lane.
- It drives sessions through the `opencode api` CLI it runs inside. It does not implement the protocol, and it does not talk to a remote harness.
- The `done` lock is advisory. It is checked before the action and again inside the rename, but neither check is atomic with the write it guards.
- `session_kill` covers the target session only: `cascaded` is always `false`, and children are listed by id with no running state.
- `session_park` is a title rewrite. It does not stop work already in flight.
- `session_list` returns one page, newest first, 50 by default. It is not the whole estate.
- Title resolution is a bounded scan: 1000 sessions a page, at most 20 pages. Beyond that it refuses rather than guessing.
- No delete verb, by design. A session is the record of what was attempted.
- No credentials handling of any kind: the CLI it spawns owns discovery and authentication.

## Links

- Source: <https://github.com/nathwn12/oc-collections/tree/main/packages/oc-talk>
- Issues: <https://github.com/nathwn12/oc-collections/issues>
- Changelog: [CHANGELOG.md](../CHANGELOG.md)
- Licence: MIT, see [LICENSE](../LICENSE)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="../assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
