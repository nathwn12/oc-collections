<h1 align="center">oc-talk</h1>

<p align="center"><strong>Cross-session messaging for OpenCode: send one message into any live session and read what it said back.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/oc-talk"><img src="https://img.shields.io/npm/v/oc-talk" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="platform">
</p>

## Why

A dispatcher often needs to hand a task to a lane that is already running, then read what came back. `oc-talk` gives the agent two tools for that without a child process, a shell, or a second dependency: one to deliver the message, one to read the session.

Every send steers into the target's current turn. A request that names another lane fails instead of being reinterpreted, so the meaning of what you wrote cannot change in transit. Failures are typed JSON payloads, never throws.

## Install

The package is published on npm. Add it to the `plugins` array in your `opencode.jsonc` and restart OpenCode:

```json
{ "plugins": ["oc-talk@0.6.1"] }
```

The plugin registers both tools when the session starts and reaches the server OpenCode already runs over loopback HTTP.

## Use

Deliver a message, then read the session:

```text
talk_send { "session": "build lane", "text": "Run the tests and report failures." }
→ { "id": "msg_0f3c…", "sessionID": "ses_9a1…", "delivered": true,
    "delivery": "steer", "deliveryReason": "default" }

talk_inbox { "session": "build lane", "limit": 20 }
→ { "sessionID": "ses_9a1…", "messages": [ … ] }
```

`talk_send` returns as soon as the message is admitted; it does not wait for an answer. Add a bounded `wait` to poll until the target reaches its next turn boundary. The reply reports `timedOut` and `waitedMs` rather than claiming a completion that never happened.

`talk_inbox` reads `{id, role, text, tools, time}` messages. It defaults to the calling session, pages with `cursor`, filters with `since` and `type`, and blocks with `wait`. An unknown or ambiguous title returns the candidate list as data.

## Configure

No config file. The `plugins` entry above is the whole setup.

`delivery: "steer"` is accepted and changes nothing. `delivery: "queue"` is a typed `bad_request` — `queue removed; oc-talk is steer-only`. A leading `[steer]` or `STEER:` is stripped before delivery; `[queue]` and `QUEUE:` are delivered as written.

## Requirements

- OpenCode V2.
- Node 22 or newer.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Package source](https://github.com/nathwn12/oc-collections/tree/main/packages/oc-talk)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)

<p align="center"><sub>Built by nathwn12</sub></p>
