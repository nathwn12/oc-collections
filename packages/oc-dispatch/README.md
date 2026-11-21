# oc-dispatch

Routes each OpenCode request to the cheapest adequate model from the live catalog, and ships **dormant**: the default `routing.json` has `mode: "off"`, so the plugin loads, writes one log line and changes no model.

## Not published

This package is `private: true`. It is not on npm and has no release row. OpenCode fetches it from this repository by path. The install specifier is:

```text
github:nathwn12/oc-collections#main::path:packages/oc-dispatch
```

Add that string to the `plugins` array in `opencode.jsonc`:

```jsonc
{
  "plugins": ["github:nathwn12/oc-collections#main::path:packages/oc-dispatch"]
}
```

Restart OpenCode. On load you get one line: `loaded mode=off models=<n>`. No model changes until you edit `routing.json` yourself. A branch specifier self-updates on startup and every 24 hours; a commit hash pins instead.

## Modes

| `mode` | What happens |
| --- | --- |
| `off` | Default. Load, log once, register the commands and watcher, change nothing. |
| `shadow` | Log the decision on every request, leave the agent's model alone. |
| `enforce` | Substitute the model on the resolve event and write one receipt line. |

Edit the shipped `routing.json` to switch modes, or set `OC_DISPATCH_ROUTING` to a file of your own. A file watcher reloads the policy and the model catalog when that file changes. A bad or missing file never fails a session: the built-in defaults stand in.

## How a model is chosen

The catalog is the only source of model ids — none are written in this package. A candidate must be enabled, not deprecated, tool-capable when its tier needs tools, inside its tier's context floor and price caps, not banked, and inside the spend ceiling. Tiers are `fast`, `medium`, `verify` and `heavy`; the cheapest tier that fits the expected context wins, and a verify tier must use a different model family from the executor. If no candidate qualifies, or the catalog is empty, the hook returns nothing and the agent's own model stands.

Roles resolve as `roles.known[agent] ?? infer(agent config) ?? roles.bare[agent] ?? medium`. Title, summary and compaction requests always take the fast tier. Zero-cost candidates rank by grade, then time to first token, then context; priced candidates rank by cost per accepted task when sampled, else token price.

## Commands

- `dispatch-status` — mode, cache age, banked models, effective depth and its winning config source.
- `dispatch-doctor` — policy validity, model count and the merged depth with the source that set it.
- `dispatch-off` — stop substitutions for this running session.
- `dispatch-refresh` — reload `routing.json` and the catalog now.

The config view reads, in increasing precedence, the global config dir, the project config, the file named by `OPENCODE_CONFIG`, and the live host config. It never writes. A separate `applySetup` seam can add the plugin entry and `experimental.subagent_depth` to an explicit target file, preserving JSONC comments, with a backup and rollback; it runs only on an explicit call, never on load.

## The receipt

One tab-separated line per substitution, in `~/.local/share/opencode/log/oc-dispatch.log` (override with `OC_DISPATCH_LOG`):

```text
<timestamp>\t<model>\t<tier>\t<reason>\t<cache age>ms\t$<spend so far>
```

## Requirements

- OpenCode V2.
- Node 22 or newer.
- No build step: plain ESM `.js`/`.mjs`.

## Development

From `packages/oc-dispatch`:

```sh
node --check src/index.js
node --test "test/**/*.test.js"
```

## Status

**Unverified** — as-is, use at your own risk.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Package source](https://github.com/nathwn12/oc-collections/tree/main/packages/oc-dispatch)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)

<p align="center"><sub>Built by nathwn12</sub></p>
