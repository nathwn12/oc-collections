<h1 align="center">oc-talk</h1>

<p align="center"><strong>Two-way cross-session messaging for OpenCode: send an addressed synthetic note to a live session and read the reply.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/oc-talk"><img src="https://img.shields.io/npm/v/oc-talk" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="platform">
  <img src="https://img.shields.io/badge/tools-2-brightgreen" alt="2 tools">
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

The message enters the peer as synthetic session input: it schedules the peer, is filed in its inbox as `type: synthetic`, and never renders as a user turn. The text carries an envelope with the sender id, sender title and reply target; the same fields ride in `metadata.ocTalk`. Metadata is not guaranteed to reach the model, so the envelope lives in the text.

## Tools

- `talk_send` — deliver one message into a session by id (`ses_...`) or unique title. It admits `POST /api/session/{id}/synthetic`, reports `{id, sessionID, title, from, replyTo, delivered, delivery, deliveryReason}`, and accepts an optional `wait` that returns only messages newer than the send. `delivery: "steer"` is accepted; `delivery: "queue"` is a typed `bad_request`. A leading `[steer]` or `STEER:` is stripped.
- `talk_inbox` — read any session's messages as `{id, role, text, tools, time}`, newest first, default 20, including synthetic peer mail. `session` defaults to the calling session; `since` keeps only newer messages, `type` filters, `cursor` pages, and `wait` blocks until the session idles again. Unknown or ambiguous titles return candidates, never a guess.

Both tools work across sessions, subagents and agents: a reply is a real synthetic message back to the sender.

## Requirements

- OpenCode V2.
- Node 22 or newer.
- The harness's own local service with a readable state file. No network, no telemetry.

## Development

From `packages/oc-talk`:

```text
node --test "test/**/*.test.js"
OC_TALK_LIVE=1 node --test "test/**/*.test.js"
```

```text
src/index.js           plugin and the two tools
src/transport.mjs      the only HTTP client
test/plugin.test.js    offline tool contracts
test/transport.test.js wire shape and credential redaction
test/live.test.js      opt-in service probe
package.json           manifest
README.md              this file
```

## Status

**Unverified** — as-is, use at your own risk.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Package source](https://github.com/nathwn12/oc-collections/tree/main/packages/oc-talk)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)

<p align="center"><sub>Built by nathwn12</sub></p>
