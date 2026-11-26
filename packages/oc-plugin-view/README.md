<h1 align="center">oc-plugin-view</h1>

<p align="center"><strong>See every loaded OpenCode server plugin in the sidebar, without opening a dialog.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/oc-plugin-view"><img src="https://img.shields.io/npm/v/oc-plugin-view" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="Windows and Linux" />
  <a href="https://github.com/nathwn12/oc-collections/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT licence" /></a>
</p>

## Install

```sh
opencode plugin add oc-plugin-view
```

You can also install the package directly with `npm i oc-plugin-view` before adding the plugin entry. Restart OpenCode. List this package before any other sidebar TUI plugin to keep its Plugins section above other rows:

```jsonc
{ "plugins": ["oc-plugin-view", "another-plugin"] }
```

## Use it

The plugin manager hides its list behind a dialog. `oc-plugin-view` puts the loaded plugins in a sidebar section with their state, so you can see at a glance which ones the server actually mounted. It ships a no-op server entry next to the TUI export; that is what places the section in the plugin order.

The section appears when at least one other package or local server plugin is installed. It excludes its own entries, so with no other plugin installed the section is hidden. Each row shows a state:

- **Active** — the server loaded the plugin; a green bullet.
- **Error** — the server failed to load it; a red bullet.

Click a row to open OpenCode's native plugin manager at `plugins.list`. With more than two rows, click the section header to collapse or expand it. The collapsed header reads `Plugins (N active)` or `Plugins (N active, M errors)`, and the choice persists across restarts.

Builtin and SDK entries are not listed; only package and local file sources are, excluding any id or path that names `oc-plugin-view`.

### Configure it

No config file. Order is set by where the entry sits in the `plugins` array. To disable, remove that entry and restart. To remove the package entirely, run `opencode plugin remove oc-plugin-view` and restart.

## Requirements

- OpenCode 2.2.6 V2 CLI and TUI.
- `@opentui/core` and `@opentui/solid` 0.8.0 or newer; `solid-js` 1.9.0 or newer.
- Node 22 or newer, or Bun 1.4 or newer.

## Status

**Unverified** — as-is, use at your own risk.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Package source](https://github.com/nathwn12/oc-collections/tree/main/packages/oc-plugin-view)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)
