# oc-talk

Gives an agent two tools to talk across sessions: put a message into another session, and read what a session has said.

## Install

The package is published on npm as `oc-talk`, and OpenCode installs it from the registry: add it to the `plugins` array in your `opencode.jsonc`.

```json
{ "plugins": ["oc-talk@0.3.0"] }
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
| `talk_send` | Delivers one message into a session by id or unique title. Queued behind the target's current turn, acted on at its next one; returns the admission in milliseconds. |
| `talk_inbox` | Reads one session's messages as `{id, role, text, tools, time}`; defaults to the calling session, pages with `cursor`, filters with `since` and `type`, and blocks with `wait`. |

Every failure is a typed JSON payload (`session_not_found`, `ambiguous_session`, `bad_request`, `backend_unavailable`, `timeout`, `backend_error`), never a throw. An unknown or ambiguous title comes back with the candidate list as data, so a caller never guesses.

## One session hands work to another

A dispatcher hands a build lane its next task, then reads what came back:

```json
talk_send { "session": "build lane", "text": "Run the test suite and report failures." }
→ { "id": "msg_0f3c…", "sessionID": "ses_9a1…", "title": "active build lane", "delivered": true }
```

The call returns at once: the message is admitted, not answered. To wait for the lane to finish the turn it was already in, ask for a bounded block — it returns the messages plus the outcome of the wait:

```json
talk_send { "session": "build lane", "text": "Summarize the failures.", "wait": 90 }
→ { "id": "msg_…", "sessionID": "ses_9a1…", "title": "active build lane", "delivered": true,
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

`src/transport.mjs` is the only file that touches the wire. It reads the running service's published state once, rewrites the wildcard bind to loopback, and dials the routes the host actually serves: `POST /api/session/{id}/prompt` to admit a message (queued, with a client id so a retry is idempotent), `GET /api/session/{id}/message` to read, and `GET /api/session?search=` to turn a title into an id. No `opencode` child process per call, no shell, no dependency beyond the plugin SDK.

## Requirements

OpenCode V2, with Node 22 or newer.

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
