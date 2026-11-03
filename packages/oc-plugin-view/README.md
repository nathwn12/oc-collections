<h1 align="center">oc-plugin-view</h1>

<p align="center"><strong>See every loaded OpenCode server plugin in the sidebar, without opening a dialog.</strong></p>

## Install

Add the plugin to `plugins` in `~/.config/opencode/opencode.jsonc`, before any other sidebar TUI plugin such as `oc-flight-deck`:

```jsonc
{
  "plugins": ["oc-plugin-view", "oc-flight-deck@0.21.1"]
}
```

Order matters. OpenCode builds the TUI from builtins, then discovered plugins, then server plugins in `opencode.jsonc` order, and finally plugins listed in `cli.json`. A plugin loaded from `cli.json` always renders last, so a sidebar section declared there lands below sections from `opencode.jsonc`. Listing this package first keeps its Plugins section above other sidebar rows.

The package ships a no-op server entry next to the TUI export, so the TUI half is loaded from the server plugin list; that is what places it in the ordering above.

Reload the TUI with `/reload`, or restart it. OpenCode installs the package and loads it on the next start.

## Usage

The section appears in the sidebar when at least one package or local server plugin is installed. It lists the plugin label and its state:

- **Active** — the server loaded the plugin. The row carries a green bullet.
- **Error** — the server failed to load the plugin. The row carries a red bullet.

Click a row to open OpenCode's native plugin manager at `plugins.list`. When more than two plugins are listed, click the section header to collapse or expand it. The collapsed header reads `Plugins (N active, M errors)`, and the open/closed choice persists across restarts.

Builtin and SDK entries are not listed. Only plugins from a package source or a local file are shown.

## How it looks

```text
▼ Plugins
• oc-plugin-view                 Active
• @scope/broken-plugin           Error
• ./local-plugin.ts              Active
```

A collapsed section with three entries reads:

```text
▶ Plugins (2 active, 1 error)
```

## Compatibility

- OpenCode 2.2.5 V2 CLI and TUI (`@opencode/plugin/tui` 2.2.5).
- `@opentui/core` and `@opentui/solid` 0.8.0 or newer; `solid-js` 1.9.0 or newer.
- TUI plus a no-op server entrypoint; the server entry carries `features.tui` from the package root and renders nothing.
