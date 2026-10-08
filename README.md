<div align="center">

# 🧩 oc-collections

**One plugin, three live sidekicks for your OpenCode terminal.**
*Install it and they're already working &mdash; every module is ON by default.*

[![npm version](https://img.shields.io/npm/v/oc-collections)](https://www.npmjs.com/package/oc-collections) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE) [![node >=22](https://img.shields.io/badge/node-%E2%89%A522-green)](https://nodejs.org) [![opencode v2](https://img.shields.io/badge/opencode-v2-blueviolet)](https://opencode.ai) [![npm weekly downloads](https://img.shields.io/npm/dm/oc-collections)](https://www.npmjs.com/package/oc-collections) [![CI](https://github.com/nathwn12/oc-collections/actions/workflows/check.yml/badge.svg)](https://github.com/nathwn12/oc-collections/actions/workflows/check.yml)

</div>

---

## &#9889; Quick start

```text
Install the oc-collections OpenCode plugin:
1. Add "oc-collections" to the "plugins" array in ~/.config/opencode/opencode.jsonc.
2. Restart OpenCode.
3. Verify: the rail rows appear beside an open session.
```

Add the plugin to your `opencode.jsonc`:

```jsonc
// opencode.jsonc
{ "plugins": ["oc-collections"] }
```

Restart OpenCode. **That's the whole setup** &mdash; no config file, no options. Every module is on from the first load, so the rail lights up immediately.

---

## 🧰 What it does

One package, three mini-plugins &mdash; each draws one compact rail row in `sidebar.content`:

| Module | What it does |
|---|---|
| `***REMOVED***` | Live ***REMOVED*** liveness + context daemon: wedge detection, context nudges, a `***REMOVED***` tool, one compact rail row. |
| `***REMOVED***` | Keeps top-level session titles as `<status> <agent>: <work>` (always lowercase); the agent is the session's live agent. |
| `***REMOVED***` | Out-of-band ***REMOVED*** watcher &mdash; agent-only (no UI): a live `***REMOVED***` tool plus escalation messages. Set `pulse: true` for a rail row. |

Every rail row follows one grammar &mdash; `<glyph> <label> <segments>` &mdash; with glyphs `●` ok &middot; `◐` warn &middot; `✕` error &middot; `○` idle &middot; `?` unknown. Every value is live: a resolved error, block, or stall clears and the row returns to idle &mdash; nothing is a lifetime tally.

---

## &#9881;&#65039; Configure

**You don't need any.** Installing it is the whole setup.

On first load the plugin writes `~/.config/opencode/oc-collections.jsonc` (all modules on; set `enabled: false` on any module to turn it off). `OPENCODE_CONFIG_DIR` overrides the directory. The full option list lives in `oc-collections.schema.json` &mdash; the file is optional, comments and trailing commas are fine.

---

## 🛡️ Safety

**It watches. It phones nothing home.**

- **No network.** Nothing is fetched, nothing is sent.
- **No telemetry.** Nothing is collected or phoned home.
- **One state location.** Daemon state lives under `~/.local/state/opencode/oc-collections` (honours `XDG_STATE_HOME`) &mdash; nowhere else.
- **Quiet by design.** The ***REMOVED*** module is invisible unless `pulse: true`.

Delete the plugin and the stock sidebar is back, exactly as it was.

---

## 🧹 Uninstall

Remove `"oc-collections"` from the `plugins` array in `opencode.jsonc` and restart OpenCode. Delete your `~/.config/opencode/oc-collections.jsonc` too if you made one.

---

## 🛠️ Development

```sh
bun install
bun run check      # typecheck + tests
```

Adding a module is a three-line recipe: one `MODULES` meta line in `src/core/meta.ts`, one `src/modules/<id>/` folder, one registry line per half (`SETUPS` + `MOUNTS`).

---

## 🧭 Compatibility

| | |
|---|---|
| Built against | `@opencode/plugin` `2.0.19` &mdash; pin a host version you've tested |
| Host | OpenCode V2 (`opencode2`) |
| Building from source | Node &ge; 22 or Bun &ge; 1.4 |

---

## &#128196; License

MIT © 2026 nathwn12 &mdash; see [LICENSE](./LICENSE).

---

<div align="center">

Built against `@opencode/plugin` 2.0.19 &middot; Node &ge; 22 / Bun &ge; 1.4 &middot; OpenCode V2

**MIT © 2026 nathwn12** &middot; For OpenCode. Free.

</div>
