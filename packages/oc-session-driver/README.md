<h1 align="center">oc-session-driver</h1>
<p align="center"><strong>Cross-session talk for any OpenCode harness: list sessions, send a message, read the reply.</strong></p>

An agent can only act inside its own session. This plugin gives it three tools to reach
the sessions next door: find a peer, hand it a message, and read what it answered.

## Install

Install the package where OpenCode can resolve it:

```powershell
npm install -g oc-session-driver
```

Add the entry to the `plugins` array in your `opencode.jsonc`, then restart OpenCode:

```json
{ "plugins": ["oc-session-driver"] }
```

The plugin registers its three tools on session start. Nothing else to configure: it uses
the same `opencode` binary that is running it.

## Tools

Every tool returns JSON in `content`. A failure is returned as
`{ "error": "…", "reason": "…", "candidates": [ … ] }`, never thrown, so a wrong name
is a readable answer rather than a crashed turn.

### `session_list`

No arguments. Returns every live session as `id`, `title`, `directory` and `updated`
(last-update time). Lists only — it never sends, reads, wakes or steers anything. Use it
to turn a title you remember into the `ses_…` id the other tools accept.

### `session_send`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `text` | yes | Message text, delivered verbatim |
| `resume` | no | Let the receiver's loop run; defaults to `true` |

Sends one message and returns `{ id, sessionID, created }`. It never reads history.

### `session_read`

| Argument | Required | Meaning |
| --- | --- | --- |
| `to` | yes | Session id (`ses_…`) or an unambiguous title substring |
| `limit` | no | Newest messages to return; default 20, clamped to 1–100 |

Returns an array of `{ id, type, created, text }`, newest first, text verbatim including
newlines. Reads only: it never sends, wakes or steers the other session.

### Titles are never guessed

`to` is matched as a case-sensitive substring of the session title.

- Exactly one match: the call proceeds.
- No match: `{ "error": "session_not_found", … "candidates": [ … ] }`, listing the closest
  titles so you can pick a real one.
- More than one match: `{ "error": "ambiguous_session", … "candidates": [ … ] }`, listing
  every match so you can pass the full id instead.

Any value beginning with `ses_` is taken as an id as-is.

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
assistant message.

## How it talks to the harness

This plugin shells out to the `opencode api` CLI it is running inside: `get /api/session`,
`post /api/session/{id}/prompt` and `get /api/session/{id}/message`. It spawns that binary
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
