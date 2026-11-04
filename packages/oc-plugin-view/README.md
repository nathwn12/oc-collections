<h1 align="center">oc-plugin-view</h1>

<p align="center"><strong>See every loaded OpenCode server plugin in the sidebar, without opening a dialog.</strong></p>

## Install

```sh
opencode plugin add oc-plugin-view
```

Restart OpenCode. The plugin loads on the next start.

List this package before any other sidebar TUI plugin such as `oc-flight-deck` to keep its Plugins section above other sidebar rows:

```jsonc
{
  "plugins": ["oc-plugin-view", "oc-flight-deck@0.21.1"]
}
```

The package ships a no-op server entry next to the TUI export, so the TUI half is loaded from the server plugin list; that is what places it in the ordering above.

## Uninstall

```sh
opencode plugin remove oc-plugin-view
```

Restart OpenCode. To disable without uninstalling, remove the entry from the `plugins` array in `opencode.jsonc` and restart.

## Usage

The section appears in the sidebar when at least one package or local server plugin besides this one is installed. With no other package plugin installed the section is hidden: the plugin excludes its own entries. It lists the plugin label and its state:

- **Active** — the server loaded the plugin. The row carries a green bullet.
- **Error** — the server failed to load the plugin. The row carries a red bullet.

Click a row to open OpenCode's native plugin manager at `plugins.list`. When more than two plugins are listed, click the section header to collapse or expand it. The collapsed header reads `Plugins (N active)` when nothing failed and `Plugins (N active, M error)` or `Plugins (N active, M errors)` when entries failed, and the open/closed choice persists across restarts.

Builtin and SDK entries are not listed. Only plugins from a package source or a local file are shown, excluding any entry whose id, source target, or source path names `oc-plugin-view`.

## How it looks

```text
▼ Plugins
• @scope/good-plugin             Active
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

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
