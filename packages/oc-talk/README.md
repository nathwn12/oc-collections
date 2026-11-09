# oc-talk

Gives an agent thirteen tools to run the session lifecycle and hold a two-way conversation across the sessions next door: find a peer, hand it a message, read what it answered, park it, wake it, close it.

## Install

The package is published on npm as `oc-talk`, and OpenCode installs it from the registry: add it to the `plugins` array in your `opencode.jsonc`.

```json
{ "plugins": ["oc-talk@0.2.2"] }
```

Restart OpenCode. The plugin registers its thirteen tools when the session starts, and uses the same `opencode` binary that is running it.

### Development

Working on the package itself, from a checkout of this repo, has two local routes. Either one loads the checkout instead of the registry copy, so an edit is live after a restart.

Link the package directory into the harness:

```powershell
cd packages/oc-talk
npm link
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
| `session_list` | Finds peers by id or title, or one dispatcher's workers with `parentID`; lists only, never sends. |
| `session_send` | Delivers one message verbatim with optional `metadata`, steering the peer by default. |
| `session_read` | Reads the peer's newest messages newest-first, with `cursor`/`since` paging and `metadata` rows. |
| `session_close` | Renames to `done <work>` then compacts, leaving an already-closed session byte-identical. |
| `session_open` | Creates `active <work>` or revives the one live match; the only way back from `done`. |
| `session_kick` | Renames to `active` then delivers one message ahead of the peer's running turn. |
| `session_park` | Marks a session idle by title only — no message, no compaction. |
| `session_kill` | Parks the session then interrupts that session alone; `cascaded` is always `false`. |
| `session_ask` | Sends one question, waits until the peer idles, and returns only that question's answers. |
| `session_wait` | Blocks until the peer idles without sending, giving up with `timedOut:true` after `waitMs`. |
| `session_reply` | Answers the asker with `text` carrying `metadata.re` for the message id it answers. |
| `session_thread` | Reads one exchange both-sides from a message id, stopping before the next question. |
| `session_broadcast` | Asks many peers at once and returns one row per target, never a rejected batch. |

## Two sessions, one exchange

A asks B, B answers, then B asks back. Each answer is tied to its question id:

```json
session_ask { "to": "worker build", "text": "Status?" }
→ { "askedMessageID": "msg_q1", "answer": [{ "id": "msg_a1", "text": "Green." }], "timedOut": false }
session_reply { "to": "dispatcher", "text": "Green.", "re": "msg_q1" }
session_ask { "to": "dispatcher", "text": "Next?" }
→ { "askedMessageID": "msg_q2", "answer": [{ "id": "msg_a2", "text": "Ship it." }], "timedOut": false }
```

The reply is correlated by message id (`askedMessageID` / `re`), never by "whatever came last": `session_ask` returns only the assistant messages after its own accepted message up to the next user message, so a later unrelated exchange never leaks in.

## Requirements

OpenCode V2, with Node 22 or newer.

## Going deeper

The manual at [the oc-talk guide](https://github.com/nathwn12/oc-collections/blob/main/packages/oc-talk/docs/GUIDE.md) covers every tool's arguments and return shape, the title-prefix state machine, how titles are resolved, the failure payloads, and what the plugin deliberately does not do.

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
