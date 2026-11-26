<h1 align="center">oc-talk</h1>

<p align="center"><strong>Two-way cross-session messaging for OpenCode: send an addressed synthetic note to a live session and read the reply.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/oc-talk"><img src="https://img.shields.io/npm/v/oc-talk" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="platform">
  <img src="https://img.shields.io/badge/tools-4-brightgreen" alt="4 tools">
  <a href="https://github.com/nathwn12/oc-collections/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

## Install

Add the plugin to `~/.config/opencode/opencode.jsonc` and restart OpenCode:

```json
{ "plugins": ["oc-talk"] }
```

The plugin reads the harness service state and needs no other config.

## Use it

Send a message, then read the session:

```text
talk_send { "session": "build lane", "text": "Run the tests and report failures." }
→ { "id": "msg_0f3c…", "sessionID": "ses_9a1…", "from": { "sessionID": "ses_caller", "title": "dispatcher" }, "replyTo": "ses_caller", "delivered": true }

talk_inbox { "session": "ses_caller" }
→ { "sessionID": "ses_caller", "messages": [ … ] }
```

Claim a seam without prose, then read the board:

```text
talk_claim { "seam": "parser", "ticket": "T-123" }
→ { "session": "ses_caller", "state": "active", "ticket": "T-123", "seam": "parser", "since": "2026-11-26T12:00:00.000Z" }

talk_board {}
→ { "rows": [ … ] }
```

The message enters the peer as synthetic session input: it schedules the peer, is filed in its inbox as `type: synthetic`, and never renders as a user turn. The text carries an envelope with the sender id, sender title and reply target; the same fields ride in `metadata.ocTalk`. Metadata is not guaranteed to reach the model, so the envelope lives in the text.

## Tools

- `talk_send` — deliver one message into a session by id (`ses_...`) or unique title. It admits `POST /api/session/{id}/synthetic`, reports `{id, sessionID, title, from, replyTo, delivered, delivery, deliveryReason}`, and accepts an optional `wait` that returns only messages newer than the send. `delivery: "steer"` is accepted; `delivery: "queue"` is a typed `bad_request`. A leading `[steer]` or `STEER:` is stripped.
- `talk_inbox` — read any session's messages as `{id, role, text, tools, time}`, newest first, default 20, including synthetic peer mail. `session` defaults to the calling session; `since` keeps only newer messages, `type` filters, `cursor` pages, and `wait` blocks until the session idles again. Unknown or ambiguous titles return candidates, never a guess.
- `talk_board` — read `<repo>/.nstack/board.yaml` and return `rows` of `{session, state, ticket, seam, since}`. A missing file returns an empty list and a clear message, never an error. Read-only.
- `talk_claim` — claim a `seam` for the calling session with optional `ticket` and `state` (default `active`), writing a row with an ISO-8601 `since`. A seam held by another session is refused with the holder named, a stale row is never silently stolen, and re-claiming your own seam updates its row instead of adding a duplicate. The file stays plain YAML and is readable without the plugin. A session's own closed rows are dropped on its next claim; other sessions' closed rows keep the newest 20 so history cannot grow into the row cap.

The messaging tools work across sessions, subagents and agents: a reply is a real synthetic message back to the sender. The board tools coordinate claims through the repo's `<repo>/.nstack/board.yaml` rather than through prose.

## Requirements

- OpenCode V2.
- Node 22 or newer.
- The harness's own local service with a readable state file. No network, no telemetry.

## Status

**Unverified** — as-is, use at your own risk.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Package source](https://github.com/nathwn12/oc-collections/tree/main/packages/oc-talk)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)
