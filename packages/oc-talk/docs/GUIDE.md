<h1 align="center">oc-talk guide</h1>

This package is published on npm as `oc-talk` and installable from the registry; this guide describes the shipped plugin. The README carries the registry route and, for working on the package itself, the two local checkout routes.

## How it works

The plugin registers thirteen tools on session start and shells out to the `opencode api` CLI it is running inside: `session.list`, `session.get`, `session.message.list`, `post /api/session`, `patch /api/session/{id}`, `post /api/session/{id}/prompt`, `post /api/session/{id}/compact`, `post /api/session/{id}/interrupt` and `post /api/experimental/session/{id}/wait`. It spawns that binary with an argument vector — no shell, no interpolation — and a 20-second timeout per call.

That CLI already discovers and authenticates with the harness's own background server. **This package never handles credentials:** it opens no auth file, reads no environment secret, resolves no port, and never returns or logs anything of the kind. The only thing it sees from the child process is the JSON that child prints.

Every tool returns JSON in `content`. A failure is returned as `{ "error": "…", "reason": "…" }` with `candidates` on a resolution miss and `truncated: true` on a capped scan, never thrown, so a wrong name is a readable answer rather than a crashed turn. There is no `structuredContent`: every result — success or failure — is a JSON string in `content`.

### The channel: what `session_ask` guarantees

`session_ask` is send-then-correlate in one call: it posts the prompt, blocks on `post /api/experimental/session/{id}/wait` until the peer idles, then reads that session's messages (100 a page, up to 5 pages) and returns only the assistant messages after its own accepted message id up to — not including — the next user message. An idle peer answers the wait with an empty body; a busy peer holds the call until the CLI timeout ends it, which counts as `timeout` and retries while the `waitMs` budget holds.

It guarantees three things: it waited until idle or the budget ran out, the wait was bounded by `waitMs` (default `120000`, a non-negative number floored to an integer), and `answer` holds only that question's assistant turns (`[{ id, text }]`) with `outcome` as the last `outcome`/`finish` seen there, or `""` when none. It does not guarantee the peer was free when asked: a peer doing unrelated work delays the answer because the wait only ends when that work idles, and `timedOut: true` is not success — it means the budget ran out and `answer` holds whatever existed (possibly `[]`).

```json
session_ask { "to": "ses_1f2e…", "text": "Status?", "waitMs": 5000 }
→ { "sessionID": "ses_1f2e…", "title": "active worker", "askedMessageID": "msg_q1", "answer": [{ "id": "msg_a1", "text": "Green." }], "outcome": "completed", "waitedMs": 812, "timedOut": false }
```

`session_wait` is the same wait with no send: it blocks on the same route with the same `waitMs` budget and returns `{ sessionID, waitedMs, timedOut, outcome }`, where `outcome` is the newest `outcome`/`finish` in the latest 5 messages, or `""` when none. `session_thread` replays one exchange both-sides from a `messageID`: `{ sessionID, messageID, messages }` in oldest-first order, stopping before the next user message, each row in the `session_read` shape.

### Who is talking to whom

`session_send` takes an optional `metadata` object carried verbatim in the prompt body; `session_ask` and `session_broadcast` take the same field and carry it on every prompt they post. `session_reply` requires `re` — the message id it answers — and sends `metadata` as `{ ...metadata, re }`, so a caller-supplied object merges instead of being replaced. The peer sees that object on the message row: `session_read`, `session_thread` and the ask answer path all surface `metadata` where the sender set it, and absent fields stay absent, never `null`.

That is how the peer identifies its caller: the sender puts itself in `metadata` (for example `{ "from": "ses_dispatcher" }`), the peer reads the row's `metadata`, and the reply carries `metadata.re` with the `askedMessageID` it answers. The code never invents an identity — without a caller-supplied `metadata` there is nothing to read — so a dispatcher that wants answers routed back names itself on every send.

```json
session_send { "to": "ses_1f2e…", "text": "hi", "metadata": { "from": "dispatcher" } }
session_reply { "to": "ses_…", "text": "done", "re": "msg_123" }
→ prompt body metadata { "re": "msg_123" }
session_reply { "to": "ses_…", "text": "done", "re": "msg_123", "metadata": { "from": "worker" } }
→ prompt body metadata { "from": "worker", "re": "msg_123" }
```

### The dispatcher pattern: one session steering N workers

One session fans out to many: `session_list` with `parentID` lists only the sessions spawned by one parent (`Only sessions spawned by this parent session id`), each row as `{ id, title, directory, updated, parentID }`, and `session_broadcast` asks them all at once. The broadcast runs every target through the same send-then-correlate flow via `Promise.allSettled`, so the result is always one row per target in input order — `{ ok: true, target, sessionID, title, askedMessageID, answer, outcome, waitedMs, timedOut }` on success, `{ ok: false, target, sessionID, error, reason }` on failure — never a rejected batch. One peer throwing is a row, not a rejection.

Each worker then replies with `metadata.re` pointing at the `askedMessageID` it was asked, so the dispatcher correlates by id rather than by arrival order. The worked loop:

1. Dispatch: `session_broadcast { "targets": ["ses_w1", "ses_w2"], "text": "Run the shard and reply with failures." }` → one row per worker with its `askedMessageID`.
2. Read answers: each row's `answer` is already that worker's assistant turns after its own question; use `session_read { "to": "ses_w1", "since": "<last seen id>" }` or `session_thread { "to": "ses_w1", "messageID": "<askedMessageID>" }` to re-check a worker without re-asking.
3. Follow up: `session_ask` (or `session_send` plus `session_wait`) to a slow worker with a longer `waitMs`; a `timedOut: true` row means "still busy", not "failed" — ask again rather than treating it as done.
4. Reconcile: match every worker row by `target`/`sessionID` and its `askedMessageID`/`metadata.re`, never by which row arrived first.
5. `session_close` each finished worker, so the next `session_list` reads them as `done`, not live.

### Lifecycle: the title-prefix state machine

A session's state is its title prefix, and there are three:

- `active ` — live and working.
- `parked ` — live but marked idle. Park rewrites the title and nothing else, so work already running in that session keeps running until it finishes.
- `done ` — closed; the record stays, the session is out of play. This is the only closed state: `parked` never closes, `active` never closes, and no verb deletes a session.

The prefix is **replaced, never stacked**. Every rename strips an existing lifecycle prefix first, so `parked active foo` collapses to `active foo` instead of piling up. A rename that would change nothing sends no request.

`done` is a **lock**. `session_send`, `session_kick`, `session_park` and `session_kill` refuse it with `{ "error": "session_closed", … }`, as do `session_ask`, `session_reply` and each `session_broadcast` row for a closed target. `session_close` rewrites to `done` and `session_open` is the only verb that may lift it, and the only way back in. The `done` lock is advisory: it is checked before an action and again inside the rename, but neither check is atomic with the write it guards, so a close that races an in-flight call can be overwritten.

Park when the session should stop reading as active but its work may finish: the title only, no message, no compaction. Kill when its active execution must stop now: the same `parked ` rename, then an interrupt of that execution. That interrupt covers only the target — `cascaded` is always `false`, and child session ids come back as a `children` id list (one `session.list` page, up to 1000), never claimed stopped.

There is no delete verb, by design. A session is the record of what was attempted.

### Titles are never guessed

`to` is matched as a case-sensitive substring of the session title, over a bounded paginated scan of the whole estate — 1000 sessions a page, at most 20 pages (20000 sessions). Any value beginning with `ses_` is taken as an id and resolved by a direct `session.get`, with no list and no ambiguity.

Resolution takes an id first, then a title substring. Zero hits fail `session_not_found` with near-misses, several hits fail `ambiguous_session` with `candidates`, and a scan that hit its page cap refuses even on a single hit (`ambiguous_scan` with `candidates` and `truncated: true`) — an unscanned session may match too, so uniqueness is unproven and nothing is authorized. `session_open` is the one exception that creates instead of refusing: zero matches create, several fail ambiguous, and a capped scan creates rather than reviving an unproven target.

### Failure payloads

Every failure is `{ "error", "reason" }` plus `candidates` on a resolution miss and `truncated: true` on a capped scan — never thrown, never a bare string. The timeout shape is a success-shaped row with a flag, not an error: `session_ask` returns `{ sessionID, title, askedMessageID, answer, outcome, waitedMs, timedOut: true }` with whatever existed (possibly `answer: []`), `session_wait` returns `{ sessionID, waitedMs, timedOut: true, outcome }`, and each `session_broadcast` row carries its own `timedOut`. A peer that never idles reports `timedOut: true`, never success.

## Configuration

There is nothing to configure. The plugin reads no config file, takes no options, and reads no environment variable: it uses the same `opencode` binary that is running it, and the harness's own server discovery and authentication.

| Setting | Default | Effect |
| --- | --- | --- |
| *(none)* | — | The package has no options and no environment variables. |
| per-call `delivery` | `steer` for `session_send`, `session_kick`, `session_ask`, `session_reply` and `session_broadcast`; `queue` for `session_open` | Whether a prompt preempts the peer's running turn (`steer`) or waits behind it (`queue`); an explicit value wins, anything else is a typed `bad_request`. `session_wait` sends nothing and takes no `delivery`. |
| per-call `waitMs` | `120000` ms on `session_ask`, `session_wait` and `session_broadcast` | How long the wait for the peer to idle may run before reporting `timedOut: true`; must be a non-negative number, floored. |
| internal call timeout | `20000` ms | Per backend round trip, fixed in the source. |
| ask read window | `100` messages a page, up to `5` pages | How far back an ask, thread or broadcast read looks for its question and answers. |

## Tools

### `session_list`

| Argument | Required | Meaning |
| --- | --- | --- |
| `limit` | no | Page size; default is the server's own page (newest 50) |
| `cursor` | no | Opaque cursor from a previous `session_list` response |
| `parentID` | no | Only sessions spawned by this parent session id |

Returns one page of live sessions as `id`, `title`, `directory`, `updated` (last-update time) and `parentID` (empty string for a top-level session): a bare array when no argument is given, and `{ sessions, cursor }` when `limit`, `cursor` or `parentID` is, so paging is explicit rather than implied. It is not the whole estate — it is the page the server returns, newest first, 50 by default; pass `limit` and then the `cursor` from the response to walk further. Lists only: it never sends, reads, wakes or steers anything.

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
| `delivery` | no | `steer` preempts the peer's current turn, `queue` waits for it; defaults to `steer` |
| `metadata` | no | Optional object carried in the prompt body so the peer can see who sent it |

Sends one message and returns `{ id, sessionID, created }`. The `metadata` object travels verbatim — read it back on the peer's message row. It never reads history, and it refuses a `done` session — that lock is lifted only by `session_open`.

```json
session_send { "to": "api-smoke-tests", "text": "Run the smoke suite and reply with the failing test names." }
→ { "id": "msg_8c11…", "sessionID": "ses_1f2e…", "created": 1793… }
```

### `session_read`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `limit` | no | Newest messages to return; default 20, clamped to 1–100 |
| `cursor` | no | Opaque cursor from a previous `session_read` response; pages forward, passed verbatim |
| `since` | no | Keep only newer messages: a message id, or a `created` timestamp |

Returns `{ id, type, created, text }` plus `metadata`, `outcome`, `finish` and `completed` (the completion stamp) where the peer sent them — absent fields stay absent, never `null` — newest first, text verbatim including newlines. A bare array when neither `cursor` nor `since` is given, and `{ messages, cursor }` when either is. A `since` id keeps only rows newer than that id; a `since` number keeps only rows with `created` above it. Reads only: it never sends, wakes or steers the other session.

```json
session_read { "to": "ses_1f2e…", "limit": 2 }
→ [ { "id": "msg_9a02…", "type": "assistant", "created": 1793…, "text": "Two failures: auth.rejects_expired and auth.timeout_429." },
    { "id": "msg_8c11…", "type": "user",      "created": 1793…, "text": "Run the smoke suite and reply with the failing test names." } ]
```

The newest message is first, so the peer's answer is the first element.

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
| `delivery` | no | `steer` preempts the peer's current turn, `queue` waits for it; defaults to `queue`, and applies only when `text` is given |

Creates a session titled `active <work>`, or revives one: when exactly one live session title contains `work`, that session is reopened to `active <work>` instead of a second one being made. Zero matches create; several fail `ambiguous_session` with candidates. A scan that hits its page cap never revives an existing session: if the capped scan found exactly one match, `session_open` creates a new session titled `active <work>`, and if it found more than one it returns `ambiguous_session` with the candidates. This is the only verb that lifts `done`. Returns `{ sessionID, titleBefore, titleAfter, reopened, resume, messageID }` with `messageID` as `""` when no `text` was given and `truncated: true` only on a capped scan.

```json
session_open { "work": "api-smoke-tests" }
→ { "sessionID": "ses_7c40…", "titleBefore": "", "titleAfter": "active api-smoke-tests", "reopened": false, "resume": true, "messageID": "" }
```

### `session_kick`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `text` | yes | Message text, delivered verbatim |
| `resume` | no | Let the receiver's loop run; defaults to `true` |
| `delivery` | no | `steer` preempts the peer's current turn, `queue` waits for it; defaults to `steer` |

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

### `session_ask`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `text` | yes | Message text, delivered verbatim |
| `resume` | no | Let the receiver's loop run; defaults to `true` |
| `delivery` | no | `steer` preempts the peer's current turn, `queue` waits for it; defaults to `steer` |
| `waitMs` | no | How long to wait for the peer to idle; default `120000` |
| `metadata` | no | Optional object carried in the prompt body so the peer can see who sent it |

Sends one question and waits until the peer idles, bounded by `waitMs`, then returns `{ sessionID, title, askedMessageID, answer, outcome, waitedMs, timedOut }`. `answer` holds only the assistant messages after the accepted `askedMessageID` up to the next user message (`[{ id, text }]`); `outcome` is the last `outcome`/`finish` there, or `""`. A peer that never idles returns `timedOut: true` with what exists, never success. Refuses a `done` session.

```json
session_ask { "to": "ses_1f2e…", "text": "Status?", "waitMs": 5000 }
→ { "sessionID": "ses_1f2e…", "title": "active worker", "askedMessageID": "msg_q1", "answer": [{ "id": "msg_a1", "text": "Green." }], "outcome": "completed", "waitedMs": 812, "timedOut": false }
```

### `session_wait`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `waitMs` | no | How long to wait for the peer to idle; default `120000` |

Blocks until the peer idles without sending anything, giving up after `waitMs` with `timedOut: true`. Returns `{ sessionID, waitedMs, timedOut, outcome }`, where `outcome` is the newest `outcome`/`finish` in the latest 5 messages, or `""` when none.

```json
session_wait { "to": "ses_1f2e…", "waitMs": 5000 }
→ { "sessionID": "ses_1f2e…", "waitedMs": 5001, "timedOut": true, "outcome": "" }
```

### `session_reply`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `text` | yes | Message text, delivered verbatim |
| `re` | yes | The message id this reply answers; carried as `metadata.re` |
| `resume` | no | Let the receiver's loop run; defaults to `true` |
| `delivery` | no | `steer` preempts the peer's current turn, `queue` waits for it; defaults to `steer` |
| `metadata` | no | Optional object merged with `{ re }` in the prompt body |

Answers the session that asked: sends one message carrying `metadata.re` with the message id it answers. Returns `{ id, sessionID, created }`. Refuses a `done` session with a typed error, like `session_send`.

```json
session_reply { "to": "ses_…", "text": "Green.", "re": "msg_q1" }
→ { "id": "msg_a1", "sessionID": "ses_…", "created": 1793… }
```

### `session_thread`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `messageID` | yes | The message id the exchange starts at |

Reads one exchange as an ordered both-sides view starting at `messageID`, stopping before the next user message. Returns `{ sessionID, messageID, messages }` oldest-first in the `session_read` row shape. A `messageID` not in that session fails `message_not_found`.

```json
session_thread { "to": "ses_1f2e…", "messageID": "msg_q1" }
→ { "sessionID": "ses_1f2e…", "messageID": "msg_q1", "messages": [{ "id": "msg_q1", "type": "user", "created": 1793…, "text": "Status?" }, { "id": "msg_a1", "type": "assistant", "created": 1793…, "text": "Green." }] }
```

### `session_broadcast`

| Argument | Required | Meaning |
| --- | --- | --- |
| `targets` | yes | Session ids or title substrings, one per worker; must be a non-empty array of non-empty strings |
| `text` | yes | Message text, delivered verbatim to every target |
| `resume` | no | Let each receiver loop run; defaults to `true` |
| `delivery` | no | `steer` preempts each peer's current turn, `queue` waits for it; defaults to `steer` |
| `waitMs` | no | How long to wait for each peer to idle; default `120000` |
| `metadata` | no | Optional object carried in every prompt body |

Asks one question of many peers at once and returns one row per target in input order via `Promise.allSettled`: success rows as `{ ok: true, target, sessionID, title, askedMessageID, answer, outcome, waitedMs, timedOut }`, failure rows as `{ ok: false, target, sessionID, error, reason }`. One peer's failure is a row, never a rejection.

```json
session_broadcast { "targets": ["ses_w1", "ses_w2"], "text": "Status?" }
→ [{ "ok": true, "target": "ses_w1", "sessionID": "ses_w1", "askedMessageID": "msg_q1", "answer": [{ "id": "msg_a1", "text": "Green." }], "timedOut": false },
   { "ok": false, "target": "ses_w2", "sessionID": "ses_w2", "error": "session_closed", "reason": "…" }]
```

## Worked example: dispatch, follow up, reconcile, close

You are the dispatcher and two workers run beside you.

1. Dispatch with `session_broadcast`. `resume` is left off, so it defaults to `true` and each peer actually runs; `delivery` is left off too, so the question preempts whatever each peer was already doing rather than waiting behind it.
2. Read answers off the rows: each success row already holds that worker's `answer` after its own `askedMessageID`. Nothing is pushed to you beyond the rows — re-check a worker with `session_read` plus `since`, or `session_thread` from its `askedMessageID`, and the newest message is first.
3. Follow up on a `timedOut: true` row with `session_ask` and a longer `waitMs`: it means "still busy", not "failed". A session that has not answered yet simply has no newer assistant message after your question.
4. Reconcile by `target`/`sessionID` and `askedMessageID`/`metadata.re`, never by arrival order: workers answer with `session_reply` carrying `re`, so each answer is tied to its question id.
5. Close each finished worker with `session_close`, so the next reader sees a closed session rather than a live one.

## Troubleshooting

**A tool returns `session_closed`.** The target is `done`. Only `session_open` lifts that lock; reopen it, or pick a live session.

**A tool returns `ambiguous_session`.** The title substring matches more than one session. Pass the `ses_…` id from `session_list` instead — an id is resolved directly, with no scan and no ambiguity.

**A tool returns `ambiguous_scan` with `truncated: true`.** The bounded scan hit its 20-page cap with matches still possible outside it. Pass the full id; uniqueness cannot be proven from the partial scan.

**A tool returns `message_not_found`.** The `messageID` is not in that session's last 500 messages (100 a page, up to 5 pages). Re-read the session to confirm the id.

**An ask returns `timedOut: true`.** The peer never idled inside `waitMs`. It is not success and not failure — the `answer` holds whatever existed. Ask again with a longer budget rather than treating a partial answer as final.

**A title looks like `parked active foo`.** It should not: every rename strips the previous lifecycle prefix first. If you see a stacked prefix, it was written by something other than this plugin.

**`session_open` created a new session instead of reviving one.** Either nothing matched, or the bounded scan hit its page cap — a capped scan never revives. Narrow the `work` label so exactly one live title matches.

**A close raced an in-flight call.** The `done` lock is advisory, not atomic. A close that overlaps another rename can be overwritten; re-read the title and close again.

**`session_kill` interrupted nothing.** It interrupts the target's active execution only. With nothing running there is nothing to interrupt, and `children` are reported, never claimed stopped.

**A backend call failed.** Each call has a 20-second timeout. The failure comes back as JSON in `content`, not as a thrown error, so the turn continues.

## Limitations: what it deliberately does not do

- No `structuredContent` on this host: every result is a JSON string in `content`, success or failure alike.
- No parent link on messages, hence positional correlation: a message carries no parent id, so `session_ask` and `session_thread` slice by position — the assistant turns after a message id up to the next user message — not by a thread pointer.
- No peer-to-peer channel: sessions talk only through the `opencode api` CLI this plugin shells out to. It does not implement the protocol, and it does not talk to a remote harness.
- No synchronous busy/idle query: the only idleness signal is the blocking `post /api/experimental/session/{id}/wait` behind `session_ask`, `session_wait` and `session_broadcast`, bounded by `waitMs`. There is no verb that reports "busy now" without waiting.
- No delete verb, by design. A session is the record of what was attempted.
- It does not handle credentials, and does not manage releases: publishing `oc-talk` is done outside the plugin.
- The `done` lock is advisory. It is checked before the action and again inside the rename, but neither check is atomic with the write it guards.
- `session_kill` covers the target session only: `cascaded` is always `false`, and children are listed by id with no running state.
- `session_park` is a title rewrite. It does not stop work already in flight.
- `session_list` returns one page, newest first, 50 by default. It is not the whole estate.
- Title resolution is a bounded scan: 1000 sessions a page, at most 20 pages. Beyond that it refuses rather than guessing.
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
