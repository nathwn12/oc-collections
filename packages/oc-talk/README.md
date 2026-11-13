# oc-talk

Gives an agent two tools to talk across sessions: put a message into another session, and read what a session has said.

## Install

The package is published on npm as `oc-talk`, and OpenCode installs it from the registry: add it to the `plugins` array in your `opencode.jsonc`.

```json
{ "plugins": ["oc-talk@0.5.0"] }
```

Restart OpenCode. The plugin registers both tools when the session starts, and reaches the server OpenCode is already running over loopback HTTP.

### Development

Working on the package itself, from a checkout of this repo, has two local routes. Either one loads the checkout instead of the registry copy, so an edit is live after a restart.

Link the package directory into the harness:

```powershell
cd packages/oc-talk
bun link
```

Then add the entry to the `plugins` array in your `opencode.jsonc`:

```json
{ "plugins": ["oc-talk"] }
```

Or skip the link and point the same array at the directory itself, as a local plugin path:

```json
{ "plugins": ["file:///C:/path/to/oc-collections/packages/oc-talk"] }
```

Restart OpenCode either way.

## What you get

| Tool | What it does for you |
| --- | --- |
| `talk_send` | Delivers one message into a session by id or unique title. Every send steers into the target's current turn; returns the admission, the lane and the reason in milliseconds, and an optional `wait` polls afterwards for the next turn boundary. |
| `talk_inbox` | Reads one session's messages as `{id, role, text, tools, time}`; defaults to the calling session, pages with `cursor`, filters with `since` and `type`, and blocks with `wait`. |

Every failure is a typed JSON payload (`session_not_found`, `ambiguous_session`, `bad_request`, `backend_unavailable`, `timeout`, `backend_error`), never a throw. An unknown or ambiguous title comes back with the candidate list as data, so a caller never guesses.

## Delivery

Every send steers: the message is admitted into the target's current turn at its next step boundary. There is one lane and no field that chooses it.

A request that still names a lane fails instead of being reinterpreted. `delivery: "queue"` is a typed `bad_request` — `queue removed; oc-talk is steer-only` — because steering a caller who asked to queue would change the meaning of what they wrote; any other value, including the old `auto`, is refused the same way. `delivery: "steer"` is accepted and changes nothing.

A leading `[steer]` or `STEER:` is stripped before delivery: a model that writes the token means it as routing, not as content. It counts only when whitespace or the end of the message follows it, so `[steer](https://example.com)` stays a Markdown link and arrives untouched, and a message that is only a marker is a typed `bad_request` — there is nothing to deliver. `[queue]` and `QUEUE:` are ordinary text now: they are delivered as written.

`wait` is a poll, not a lane. It runs after the send — never instead of it — and takes seconds to block until the target reaches its next turn boundary, then returns the messages it produced with `timedOut` and `waitedMs`. It cannot change what was sent, so a steered message with `wait` is still steered, and a bounded wait that gives up reports `timedOut: true` rather than claiming a completion that never happened.

The reply reports both fields: `delivery` is always `steer`, and `deliveryReason` is `explicit` when the caller passed `delivery: "steer"`, `marker` when a `[steer]` token was stripped, and `default` otherwise.

## One session hands work to another

A dispatcher hands a build lane its next task, then reads what came back:

```json
talk_send { "session": "build lane", "text": "Run the test suite and report failures." }
→ { "id": "msg_0f3c…", "sessionID": "ses_9a1…", "title": "active build lane", "delivered": true,
    "delivery": "steer", "deliveryReason": "default" }
```

The call returns at once: the message is admitted, not answered. To poll until the lane reaches its next turn boundary, ask for a bounded wait — it returns the messages plus the outcome of the poll:

```json
talk_send { "session": "build lane", "text": "Summarize the failures.", "wait": 90 }
→ { "id": "msg_…", "sessionID": "ses_9a1…", "title": "active build lane", "delivered": true,
    "delivery": "steer", "deliveryReason": "default",
    "timedOut": false, "waitedMs": 41230, "messages": [ … ] }
```

Then read the conversation without sending anything. In the lane itself, no `session` argument is needed — the tool reads the calling session:

```json
talk_inbox { "limit": 20 }
→ { "sessionID": "ses_9a1…", "cursor": { "previous": null, "next": "eyJ…" },
    "messages": [
      { "id": "msg_a1", "role": "assistant", "text": "Three failures, all in the parser.",
        "tools": [{ "name": "bash", "status": "completed" }], "time": 1762900000000 },
      { "id": "msg_q1", "role": "user", "text": "Summarize the failures.", "tools": [], "time": 1762899950000 }
    ] }
```

`since` takes a message id and keeps only what is newer, or an opaque `cursor` from a previous call and returns the next page.

## How it talks

`src/transport.mjs` is the only file that touches the wire. It reads the running service's published state once, rewrites the wildcard bind to loopback, and dials the routes the host actually serves: `POST /api/session/{id}/prompt` to admit a message (with `steer` as the delivery, and a client id so a retry is idempotent), `GET /api/session/{id}/message` to read, and `GET /api/session?search=` to turn a title into an id. No `opencode` child process per call, no shell, no dependency beyond the plugin SDK.

## Requirements

OpenCode V2, with Node 22 or newer.

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
