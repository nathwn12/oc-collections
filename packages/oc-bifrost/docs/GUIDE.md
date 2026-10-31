<p align="center">
  <img src="../assets/icon.svg" width="120" height="120" alt="oc-bifrost icon" />
</p>
<h1 align="center">oc-bifrost guide</h1>

## How it works

The bridge loads as one V2 plugin. Everything else — your V1 plugins — is data it mounts, not code you install.

1. **Resolve.** Each entry in `plugins` becomes one specifier: `github:<owner>/<repo>[@<ref>][#<path>]`, a registry package name, a local path, or `preset:rtk`. A relative specifier resolves against the **session** directory, not against this plugin's own location.
2. **Fetch, if it is remote.** A `github:` specifier is cached under the shared OpenCode user cache and pinned by commit sha plus the entry file's sha256, verified again on every later load. A cold cache refuses until you consent. A registry package is installed into its own cache directory the same way.
3. **Classify by shape, not by name.** A V1 hook factory, a V1 module, and a V2 `{ id, setup }` definition are told apart by what they export. V2 definitions mount natively with the host context; V1 shapes go through the bridge.
4. **Bridge hook by hook.** Every hook the plugin declares is looked up in the compatibility matrix below. `full` and `partial` hooks are wired to their V2 destination. `unsupported` hooks are refused out loud.
5. **Report.** One line per hook, per plugin, on every load.

### The bridge contract

24 V1 hooks. `full` means the V1 semantics survive intact. `partial` means it bridges and the report names exactly what changed. `unsupported` means it is refused by design and the plugin keeps running without it.

| V1 hook | Level | Where it lands, or why it does not |
| --- | --- | --- |
| `tool.execute.before` | full | `ctx.tool.hook("execute.before")` — mutable `event.input` with write-back. |
| `shell.env` | full | `ctx.shell.hook("create.before")` — merges into `event.env`. |
| `chat.headers` | full | `ctx.session.hook("model.request")` — writes request headers. |
| `permission.ask` | full | `ctx.permission.hook("evaluate")` — writes the evaluate effect. |
| `dispose` | full | The setup cleanup return. |
| `tool.execute.after` | partial | `ctx.tool.hook("execute.after")`. `result.output`/`metadata` and `error.message` write back; V1 `output.title` is dropped on both branches because V2 has no title field. |
| `chat.params` | partial | Fans out to the `context`, `compaction`, `generate` and `title` session hooks. A non-numeric generation setting is warned about and never reaches the model request. |
| `chat.message` | partial | `ctx.session.hook("prompt")` — writes prompt files, agents and skills. |
| `tool.definition` | partial | Applied as a transform over a snapshot, because V2's editor is synchronous and the V1 hook is async. |
| `tool` | partial | `ctx.tool.transform` editor `add`. |
| `event` | partial | `ctx.event.subscribe()`. Terminal execution events are synthesised into the V1 `session.idle` envelope; other names and payloads pass through unchanged. |
| `client.session.messages` | partial | `ctx.session.context({ sessionID })` — the **active** context after compaction, not the full transcript. |
| `experimental.chat.system.transform` | partial | Fans out to the same four session hooks; untouched parts are preserved. |
| `experimental.chat.messages.transform` | partial | Same fan-out. Non-text V1 parts land verbatim in `content`, because the V2 prompt contract admits only text, files, agents and skills. |
| `experimental.session.compacting` | partial | `ctx.session.hook("compaction")` — `output.context` is appended to the system prompt; `output.prompt` is accepted and ignored, as the V2 result carries no prompt field. |
| `client.session.children` | unsupported | V2 exposes no plugin-scoped child-session listing, and the plugin context carries no server address to ask over HTTP. |
| `client.tui.showToast` | unsupported | A server plugin has no toast surface; `tui.toast.show` belongs to the TUI process. |
| `config` | unsupported | V2 replaced one config hook with per-domain transforms of different semantics. |
| `auth` | unsupported | V2 uses `ctx.integration.transform` plus the integration APIs. |
| `provider` | unsupported | V2 uses `ctx.provider.transform` / `ctx.model.transform`. |
| `command.execute.before` | unsupported | No one-to-one global V2 hook. |
| `experimental.provider.small_model` | unsupported | No V2 equivalent. |
| `experimental.compaction.autocontinue` | unsupported | No V2 equivalent. |
| `experimental.text.complete` | unsupported | No V2 equivalent. |

`strict: true` turns any `unsupported` row from a warning into a thrown error that aborts that plugin's setup. The default keeps mounting the rest.

### The mount report

Every load writes a report. Each line is `<level> <hook> — <note>` under a `[oc-bifrost] <specifier>` header:

```text
[oc-bifrost] github:acme/widget
  full        tool.execute.before — mutable event.input + event.tool write-back
  full        dispose — setup cleanup
  mounted     v1:Widget — V1 named export (WidgetPlugin)
  mounted     github:acme/widget — loaded from cache (commit 4f2a…, snapshot 2 files; entry sha256 765f… verified); executes with the host process's full user rights
  partial     chat.params — mapped onto session context/compaction/generate/title generation options
  unsupported client.session.children — no plugin-scoped child listing; skipped
```

Four levels appear: `full`, `partial`, `unsupported`, and `mounted` (a plugin shape that mounted, with no hook verdict of its own). Console output is not enough on its own — the host discards stdout when it runs as a background service or a stdio server — so every line is mirrored to a file:

```text
<XDG_CACHE_HOME>/opencode/oc-bifrost/report.log
```

The file appends across loads and rolls over at 256 KiB, so the newest report survives whole. Control characters are escaped before they land on disk. A sink failure is warned about once and never breaks a mount.

## Configuration

One file, `oc-bifrost.jsonc`, in the OpenCode config directory. The directory resolves as `$OPENCODE_CONFIG_DIR` when set, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` — the same root the host reports from `opencode debug paths`. An `options` key on the plugin entry wins key by key over the file.

```jsonc
{
  // ~/.config/opencode/oc-bifrost.jsonc
  "plugins": ["github:obra/superpowers"],
  "trustRemote": true,
  "provision": "npm"
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `plugins` | unset | The specifiers to mount, one per entry. Nothing mounts until you list something. |
| `trustRemote` | `false` | Consent for a cold `github:` cache to download and execute remote code. A warm, hash-verified cache needs no re-consent. |
| `strict` | `false` | An `unsupported` hook or a failed entry aborts that plugin's setup instead of warning and mounting the rest. |
| `verbose` | `true` | `false` silences the `partial` lines. `unsupported` lines and refusals still print. |
| `freshness` | `"off"` | `"online"` checks the bundled `preset:rtk` against its upstream release after it mounts. |
| `provision` | `"host"` | How a snapshot's dependencies are resolved: `"host"` uses the shared OpenCode npm cache, `"npm"` adds an `npm install --no-save` fallback for packages the host store lacks, `"off"` provisions nothing. An invalid value is a loud refusal naming the valid modes. |
| `wireTui` | `false` | `true` wires a mounted `github:` snapshot's TUI entry into your `cli.json`. A tree with no TUI entry is a clean skip, not a failure. |

Each key has an environment fallback, used only when the option and the file are both silent:

| Variable | Opts in when | Effect |
| --- | --- | --- |
| `OC_BIFROST_TRUST` | exactly `github` | Same as `trustRemote: true`. Any other value is off. |
| `OC_BIFROST_FRESHNESS` | exactly `online` | Same as `freshness: "online"`. |
| `OC_BIFROST_PROVISION` | `host`, `npm`, or `off` | Same as `provision`. |
| `OC_BIFROST_WIRE_TUI` | `1` or `true`, case-insensitive | Same as `wireTui: true`. |
| `OC_BIFROST_REPORT` | any path | Overrides the report file location. `off` disables the file. |

An explicit option always beats the environment, and an explicit `false` beats an opt-in variable.

## Commands

The bridge has no CLI of its own. These are the host commands that verify it, and they are read-only:

| Command | What it returns |
| --- | --- |
| `opencode plugin check` | Whether every configured plugin loads. Run it first: a specifier the host cannot resolve fails here, before the bridge sees it. |
| `opencode plugin list` | The loaded plugins, including `@nathwn12/oc-bifrost`. |
| `opencode debug paths` | The config, cache and state roots, which is how you find the file this guide names. |

After a restart, the check you care about is the mount report, not the exit status of either command:

```text
[oc-bifrost] preset:rtk
  full        tool.execute.before — mutable event.input + event.tool write-back
  mounted     v1:Rtk — V1 named export (RtkPlugin)
```

## Troubleshooting

**A `github:` plugin refuses with a consent error.** The cache is cold and `trustRemote` is not set. Set `"trustRemote": true` on that entry, or `OC_BIFROST_TRUST=github`. The refusal names the variable.

**A mounted plugin refuses with a missing package.** Its dependencies are not in the host store. Set `"provision": "npm"` on that entry: the host junction is still attempted first, and the npm fallback covers what it lacks.

**`preset:rtk` refuses.** It needs the `rtk` binary, at least `0.23.0`, on `PATH`. The report names the binary and the consequence.

**A local plugin path refuses.** Relative specifiers resolve against the session directory, not this plugin's location. For a global install use an absolute path or `~/…`. V1 files parked in `plugin/` or `plugins/` are rejected by the host before the bridge runs — park them in `legacy/` instead. The stranded-file scan warns when it finds one.

**A hook works on V1 and does nothing on V2.** Read its row above. If it is `partial`, the loss is named in the report line. If it is `unsupported`, there is no V2 destination to bridge to and no setting turns it on.

**The report is missing.** The host discards stdout in service and stdio modes by design. Read the file, or set `OC_BIFROST_REPORT` to a path you can reach.

**`strict: true` aborted the mount.** That is what it is for. Name the refused hook in the report, remove `strict`, and mount the rest — or drop the plugin.

## Limitations

- The matrix above is the whole contract: 24 hooks. A hook outside it is never bridged, and the report covers the 24, not whatever else a plugin exports.
- `client.session.messages` sees the active, post-compaction context only. The full transcript is not reachable from the V2 plugin facade.
- `client.session.children` and `client.tui.showToast` cannot be bridged at all: one needs a server address the plugin context does not carry, the other lives in the TUI process.
- Mounted remote plugins execute with the host process's full user rights. The pin proves the bytes did not change after the first fetch; it does not sandbox them.
- The bridge does not fix a plugin's logic. It maps hooks; a V1 plugin that depended on a refused hook is still missing that behaviour.
- The git ref install route for the bridge package itself fails host-side today. Use the npm route.
- Windows and macOS/Linux both work only as far as OpenCode V2 itself does; the bridge makes no platform claim of its own.

## Links

- Source: <https://github.com/nathwn12/oc-collections/tree/main/packages/oc-bifrost>
- Package: <https://www.npmjs.com/package/@nathwn12/oc-bifrost>
- Compatibility matrix: <https://github.com/nathwn12/oc-collections/blob/main/packages/oc-bifrost/src/compat-matrix.ts>
- Setup guide: [INSTALL.md](../INSTALL.md)
- Verification record: [PROOF.md](../PROOF.md)
- Issues: <https://github.com/nathwn12/oc-collections/issues>
- Releases: <https://github.com/nathwn12/oc-collections/releases>
- License: [LICENSE](../LICENSE)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="../assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
