<h1 align="center">oc-discord-rpc</h1>

<p align="center"><strong>An OpenCode plugin that publishes a Discord Rich Presence card with the app name, the selected model's human name and a clock that runs from when OpenCode opened.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/oc-discord-rpc"><img src="https://img.shields.io/npm/v/oc-discord-rpc" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="platform">
  <a href="https://github.com/nathwn12/oc-collections/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

## Install

Add the plugin to `~/.config/opencode/opencode.jsonc` and restart OpenCode:

```json
{ "plugins": ["oc-discord-rpc"] }
```

The plugin needs a Discord **application id** and is inert without one. Create an application in the Discord Developer Portal and pass its id as `appId`, or set `OC_DISCORD_APP_ID`. There is no bundled id because there is no official one. With no id the plugin logs a single line and does nothing else.

```jsonc
{
  "plugins": [
    {
      "package": "oc-discord-rpc",
      "options": { "appId": "<your Discord application id>" }
    }
  ]
}
```

## What it shows

The header and the mark are drawn by Discord; three fields come from the payload:

```text
Playing OpenCode                             activity.name, from appName
[mark]  OpenCode                             drawn by Discord, not a second text line
        Coding with DeepSeek V4.1 Flash 1017 details: model display name
        Reasoning High                       state: reasoning level
        0:31                                 timestamps.start, from when OpenCode opened
```

`type` is `0` (`Playing`). `details` is `Coding with <model display name>` — no effort on that line, and no duplicate of the header. The model name is resolved from `ctx.model.list()` by matching `modelID` before `id` inside the session's `providerID`; when the catalogue has no match or is unavailable, a deterministic prettifier turns an id such as `deepseek-v4.1-flash` into `DeepSeek V4.1 Flash`. The model is whatever the session you are in is using: read from the session list when the plugin loads into a session that already exists, seeded on `session.created`, and overridden the moment you pick a different model. Both `details` and `state` are omitted when nothing is known. A catalogue name that arrives after the first card was built replaces the fallback on the next send.

`state` is `Reasoning <Level>` on its own line. Levels are `low` → `Low`, `medium` → `Medium`, `high` → `High`, `xhigh` → `XHigh`, `max` → `Max` and `minimal` → `Minimal`; any other value keeps its text with the first letter capitalised. When the variant is `default` (any case), missing or empty, the `state` field is omitted entirely — never `Reasoning Default`. There is no middle dot and no parentheses on either text line.

`assets.large_text` is `<providerID> \u00b7 <version>`, for example `opencode-go · 2.4.2`, where the version comes from `ctx.app.version`. It is omitted when neither part is known.

The clock is `timestamps.start`, set when OpenCode opens, and it counts up perpetually, idle or not. There is no end timestamp and no mode or option that moves the anchor: the timer is the length of time OpenCode has been open. That is the owner's choice: Discord advances the timer on its own from `timestamps.start`, so keeping it running costs no updates.

## Privacy

The card never carries the current tool name or a tool's input. A tool name alone says almost nothing, and a tool's input carries file paths. It never carries message text, prompts, or file contents either.

## Image

The chosen image is `https://raw.githubusercontent.com/anomalyco/opencode/2204311ec6e966db8d67988ab3638ad95a811a46/packages/ui/src/assets/favicon/apple-touch-icon-v3.png` — the official mark, pinned to an immutable commit so it cannot move. It is a third-party URL that Discord fetches through its media proxy; this package ships no image file. Set `largeImage` to that URL to use it, or to another full `https://` URL or an uploaded asset key to use a different image. Leave `largeImage` empty and no image is sent at all; Discord then shows your app's own icon.

The alternative is `https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-avatar/avatars/opencode.webp`: the same mark from the lobehub icon set, 1280×1280, on a moving branch.

## Limits

- The Discord desktop client must be running on the same machine. The plugin speaks Discord's local IPC socket (`discord-ipc-0` through `discord-ipc-9`) and does nothing when no client is up.
- Updates are coalesced at a minimum interval (`minIntervalMs`, default 15 seconds) because Discord rate-limits activity updates. The card is a status line, not a live log.
- Without an application id nothing is published. The plugin does not create the Discord application for you.
- The header line reads `activity.name` and is not taken from `details`. Discord's docs only say that the App Name is configured in the app's settings ("You can't set App Name when setting presence—it's always the name configured in your app's settings"), but the live card contradicts that: over the local IPC path `activity.name` is honoured, so a registered portal app named `OpenCode` is **not** required for the header. This was observed with the app id still naming a different program. The icon still comes from the application registered against your `appId`.

## Options

- `appId` — the Discord application id; also settable with `OC_DISCORD_APP_ID`. With no id the plugin is inert.
- `enabled` — default `true`; `false` disables the plugin without uninstalling it.
- `minIntervalMs` — minimum gap between presence updates, default `15000`; positive values under `1000` clamp up to `1000`.
- `largeImage` — a full `https://` URL or an uploaded asset key for `large_image`; empty sends no image.
- `buttons` — up to two `{label, url}` buttons; none by default.
- `appName` — the `activity.name` header; default `OpenCode`. `details` carries the model instead.

## Tracing

Set the environment variable `OC_DISCORD_RPC_TRACE=1` to print a trace of every decision the plugin makes. It is not a config key.

## Requirements

- OpenCode V2.
- Node 20 or newer, or Bun.
- The Discord desktop client, running locally on the same machine.

## Status

**Unverified** — as-is, use at your own risk.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Package source](https://github.com/nathwn12/oc-collections/tree/main/packages/oc-discord-rpc)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)
