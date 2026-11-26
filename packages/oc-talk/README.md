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

The plugin reads the harness service state and needs no other config. A default install registers exactly two tools: `talk_send` and `talk_inbox`.

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
The messaging tools work across sessions, subagents and agents: a reply is a real synthetic message back to the sender. The optional board pair is documented below; it is not part of the default surface.

## Replies, ACKs and terminal rows

`talk_send` is fire-and-forget unless the caller passes `wait`. A reply is a
choice, not an obligation, and these are prose conventions between peers — the
plugin adds no runtime trick and sends nothing on your behalf:

- A message that needs an answer says what answer it wants. Only then does the
  sender call `talk_send` with `wait`, and `wait` reports `timedOut:true` if the
  peer never reaches a turn boundary.
- A peer that is finished and needs no reply ends with a line of `ACK` or
  `no reply needed`. The sender treats that as terminal and does not wait.
- A peer that is handing a task on names the new owner and the seam, then stops.
  Silence after an ACK is expected, not a failure to be polled forever.

## Board coordination (opt-in)

The board pair is **not** part of a default install. A host that already keeps
its own coordination board enables it with the `boardFile` option (or an
explicit `board: true`) in its own config:

```json
{
  "plugins": [
    {
      "package": "oc-talk",
      "options": { "boardFile": "<path to the host's board file>" }
    }
  ]
}
```

The board file and the seam/state convention belong to the **host harness**,
not to oc-talk. This package neither creates nor requires that file: a stranger
who installs it sees only the two messaging tools above. When opted in:

- `talk_board` — read the host's board file and return `rows` of `{session, state, ticket, seam, since}`. A missing file returns an empty list and a clear message, never an error. Read-only.
- `talk_claim` — claim a `seam` for the calling session with optional `ticket` and `state` (default `active`), writing a row with an ISO-8601 `since`. A seam held by another session is refused with the holder named, a stale row is never silently stolen, and re-claiming your own seam updates its row instead of adding a duplicate. The file stays plain YAML and is readable without the plugin. A session's own closed rows are dropped on its next claim; other sessions' closed rows keep the newest 20 so history cannot grow into the row cap.
- `active` means live work, `parked` means deliberately waiting, and `closed` means finished history. `closed` is the terminal row: a new claim on that seam takes it over without asking.

### Board leases and safe takeover

Each claimed row carries an internal lease (a heartbeat and an expiry). Re-claiming
your own seam is the heartbeat: it refreshes the lease without another tool call.
The five public fields never change, so hand-edited YAML and the `{rows}` tool
contract stay compatible with older boards.

Another session may take a held seam only with an explicit
`talk_claim { "seam": "...", "takeover": true, "reason": "..." }` **and** all four
of these hold: the liveness check names that holder, the service answered
`session_not_found` for it (a `backend_unavailable`, `timeout` or `backend_error`
answer is not proof the holder is gone), the lease has expired, and a reason is
recorded on the row. A live lessor is never stolen, a row with no lease is never
stolen, and a takeover without a reason is refused. `takeover: false` is a
harmless no-op boolean. Claims take a sidecar lock for the whole read-modify-write and compare
the file before renaming it, so a hand edit landing mid-claim is reported as
`board_changed` instead of silently losing a row. Retry the claim after reading
the board again.

### Reading a large board

`talk_board` defaults to every row, unchanged. Pass `state`, `seam` or
`session` to filter, and `limit` plus the returned `cursor.next` to page. The
`rows` shape stays `{session, state, ticket, seam, since}`; a filtered read
also reports `total` and `cursor`.

`broadcastPlan(sessions, text)` is a read-only helper: it deduplicates targets
and returns the `talk_send` calls to make. It adds no tool and sends nothing;
`talk_send` typing is unchanged.

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
