<h1 align="center">oc-session-driver</h1>
<p align="center"><strong>Cross-session talk for any OpenCode harness: list sessions, send a message, read the reply.</strong></p>

An agent can only act inside its own session. This plugin gives it nine tools to run the
whole session lifecycle across the sessions next door: find a peer, hand it a message, read
what it answered, park it, wake it, close it.

## Install

This package is private pending a trial and is not installable from the registry.

To try it locally, link this directory into the harness from `packages/oc-session-driver`:

```powershell
npm link
```

Then add the entry to the `plugins` array in your `opencode.jsonc`:

```json
{ "plugins": ["oc-session-driver"] }
```

Or point that `plugins` array at this directory directly, as a local plugin path, and restart
OpenCode.

The plugin registers its nine tools when the session starts. Nothing else to configure: it uses
the same `opencode` binary that is running it.

## Tools

Every tool returns JSON in `content`. A failure is returned as
`{ "error": "…", "reason": "…", "candidates": [ … ] }`, never thrown, so a wrong name
is a readable answer rather than a crashed turn.

### The title prefix is the state

A session's state is its title prefix, and there are three:

- `active ` — live and working.
- `parked ` — live but marked idle. Park rewrites the title and nothing else, so work already
  running in that session keeps running until it finishes.
- `done ` — closed; the record stays, the session is out of play.

The prefix is **replaced, never stacked**. Every rename strips an existing lifecycle prefix
first, so `parked active foo` collapses to `active foo` instead of piling up. A rename that
would change nothing sends no request.

`done` is a **lock**. `session_send`, `session_kick`, `session_park`, `session_kill` and
`session_await` refuse it with `{ "error": "session_closed", … }`. `session_open` is the only
verb that may lift it, and the only way back in. The lock is checked twice: once in the verb, and
again on the freshly read title inside the shared rename, so a close that lands mid-call is
refused rather than renamed away.

`session_park` is graceful: the title only, no message, no compaction. `session_kill` is hard:
the same rename, then an interrupt of the active execution. That interrupt covers only the
target — `cascaded` is always `false`, and live child sessions come back as a `children` id
list, never claimed stopped.

There is no delete verb, by design. A session is the record of what was attempted.

### `session_list`

| Argument | Required | Meaning |
| --- | --- | --- |
| `limit` | no | Page size; default is the server's own page (newest 50) |
| `cursor` | no | Opaque cursor from a previous `session_list` response |

Returns one page of live sessions as `id`, `title`, `directory`, `updated` (last-update time) and
`parentID` (empty for a top-level session): a bare array when neither argument is given, and
`{ sessions, cursor }` when either is, so paging is explicit rather than implied. It is not the
whole estate — it is the page the server returns, newest first, 50 by default; pass `limit` and
then the `cursor` from the response to walk further. Lists only — it never sends, reads, wakes or
steers anything. Use it to turn a title you remember into the `ses_…` id the other tools accept.

### `session_send`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `text` | yes | Message text, delivered verbatim |
| `resume` | no | Let the receiver's loop run; defaults to `true` |

Sends one message and returns `{ id, sessionID, created }`. It never reads history, and it
refuses a `done` session — that lock is lifted only by `session_open`.

### `session_read`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `limit` | no | Newest messages to return; default 20, clamped to 1–100 |

Returns an array of `{ id, type, created, text }`, newest first, text verbatim including
newlines. Reads only: it never sends, wakes or steers the other session.

### `session_await`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `text` | yes | Message text, delivered verbatim |
| `timeoutMs` | no | Wait budget in ms; default 60000, capped at 300000 |

Sends one message with `resume` forced to `true`, then polls the session's messages about once
a second for an assistant message created after the send. On a reply it returns
`{ sessionID, text, messageId, timeoutMs }`; on expiry
`{ sessionID, timeout: true, lastSeen, timeoutMs }` with the newest text it saw, so a slow peer
is a readable answer rather than a hung call. The budget bounds the wait **after** the send, not
the whole call: each poll is one backend round trip with its own 20-second timeout, so a call can
overrun its budget by up to one poll. It refuses a `done` session.

### `session_close`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `title` | no | Explicit final title; defaults to `done <current title>` |

Closes a finished session in one call: renames it to `done <work>`, then compacts it. The order
is fixed — rename, then compact, never the other way. An explicit `title` wins, but it is
normalized to the same `done ` prefix, so a close can never leave a compacted session reading as
live; a session that is already `done` is left byte-identical and reported `already-closed`
rather than double-prefixed. Returns
`{ sessionID, titleBefore, titleAfter, compacted, compactionId, alreadyClosed, status }`; if the
compaction fails after a successful rename, the error names both titles so the state stays
readable.

### `session_open`

| Argument | Required | Meaning |
| --- | --- | --- |
| `work` | yes | Short work label; the new title becomes `active <work>` |
| `text` | no | Optional one-shot prompt delivered after the open |
| `resume` | no | Let the receiver's loop run after the prompt; defaults to `true` |

Creates a session titled `active <work>`, or revives one: when exactly one live session title
contains `work`, that session is reopened to `active <work>` instead of a second one being made.
Zero matches create; several fail `ambiguous_session` with candidates. A scan that hits its page
cap never revives — an unscanned session may be the one meant, so it creates instead and reports
`"truncated": true`, which is visible in the response. This is the only verb that lifts `done`.
Returns `{ sessionID, titleBefore, titleAfter, reopened, resume, messageID }`.

### `session_kick`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `text` | yes | Message text, delivered verbatim |
| `resume` | no | Let the receiver's loop run; defaults to `true` |

Wakes a live session: renames it to `active <work>`, then delivers one message. Returns
`{ sessionID, titleBefore, titleAfter, messageID, resumed }`. A `done` session is refused —
reopen it with `session_open` first.

### `session_park`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |

Rewrites the title to `parked <work>` and returns. Prefix only: no message is sent and no
compaction runs, so anything already in flight is left alone. Returns
`{ sessionID, titleBefore, titleAfter }`. A `done` session is refused.

### `session_kill`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |

Rewrites the title to `parked <work>`, then interrupts the session's active execution. Park is
graceful, kill is hard. Returns
`{ sessionID, titleBefore, titleAfter, interrupted, cascaded, children }`, with `cascaded`
always `false` and `children` naming the live child sessions it saw running — one page of up to
1,000, so it is a listing of what the lookup returned, not a proof that no other child exists.
A `done` session is refused.

### Titles are never guessed

`to` is matched as a case-sensitive substring of the session title, over a bounded paginated
scan of the whole estate — 1000 sessions a page, at most 20 pages. Any value beginning with
`ses_` is taken as an id and resolved directly, with no list and no ambiguity.

- Exactly one match: the call proceeds.
- No match: `{ "error": "session_not_found", … "candidates": [ … ] }`, listing up to five
  near-miss titles so you can pick a real one.
- More than one match: `{ "error": "ambiguous_session", … "candidates": [ … ] }`, listing every
  match so you can pass the full id instead.
- The scan hit its page cap: a substring never resolves to a target, not even on a single
  match, because an unscanned session may match too. That is
  `{ "error": "ambiguous_scan", "truncated": true, "candidates": [ … ] }` listing the matches it
  did see; pass the full id. A capped scan that found nothing is still reported as
  `session_not_found`, carrying `"truncated": true`, so a large estate is never mistaken for a
  complete answer.

## Worked example

You are the agent in a build session and the test session is running beside you.

1. Find the peer.

```json
session_list
→ [ { "id": "ses_1f2e…", "title": "api-smoke-tests", "directory": "…", "updated": 1793… } ]
```

2. Hand it a job. `resume` is left off, so it defaults to `true` and the peer actually runs.

```json
session_send { "to": "api-smoke-tests", "text": "Run the smoke suite and reply with the failing test names." }
→ { "id": "msg_8c11…", "sessionID": "ses_1f2e…", "created": 1793… }
```

3. The peer replies into its own session, as a normal assistant message. Nothing is pushed
   to you — you read it.

```json
session_read { "to": "ses_1f2e…", "limit": 2 }
→ [ { "id": "msg_9a02…", "type": "assistant", "created": 1793…, "text": "Two failures: auth.rejects_expired and auth.timeout_429." },
    { "id": "msg_8c11…", "type": "user",      "created": 1793…, "text": "Run the smoke suite and reply with the failing test names." } ]
```

The newest message is first, so the peer's answer is the first element. Poll it once more
if the peer is still working: a session that has not answered yet simply has no newer
assistant message. When one call is cleaner than two, `session_await` does steps 2 and 3
together and returns the reply text itself, or `{ "timeout": true, "lastSeen": … }` if the
budget runs out first.

4. Close it when it is finished, so the next reader sees a closed session rather than a live one.

```json
session_close { "to": "ses_1f2e…" }
→ { "sessionID": "ses_1f2e…", "titleBefore": "api-smoke-tests", "titleAfter": "done api-smoke-tests", "compacted": true, "alreadyClosed": false, "status": "closed" }
```

## How it talks to the harness

This plugin shells out to the `opencode api` CLI it is running inside: `session.list`,
`session.get`, `session.message.list`, `post /api/session`,
`patch /api/session/{id}`, `post /api/session/{id}/prompt`,
`post /api/session/{id}/compact` and `post /api/session/{id}/interrupt`. It spawns that binary
with an argument vector — no shell, no interpolation — and a 20-second timeout per call.

That CLI already discovers and authenticates with the harness's own background server.
**This package never handles credentials:** it opens no auth file, reads no environment
secret, resolves no port, and never returns or logs anything of the kind. The only thing
it sees from the child process is the JSON that child prints.

## Requirements

- OpenCode V2, which resolves this plugin by name.
- Node `>=22`.

## Links

- Package: <https://www.npmjs.com/package/oc-session-driver>
- Releases: <https://github.com/nathwn12/oc-collections/releases>
- Issues: <https://github.com/nathwn12/oc-collections/issues>
- Licence: <https://github.com/nathwn12/oc-collections/blob/main/LICENSE>

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
