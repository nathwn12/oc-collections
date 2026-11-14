# oc-dex

Runs one bounded headless Codex task from any OpenCode session: one `oc_dex` tool, one config file, nothing else required.

## Not published

This package is `private: true` and is loaded from this repository, by path. It is not on npm, it is not in the release allowlist (`scripts/release-target.mjs`), and nothing installs it but a path:

```json
{ "plugins": ["Q:\\PROJECTS\\PERSONAL\\oc-collections\\packages\\oc-dex"] }
```

This machine loads it as a junction in the local plugins directory pointing at that path instead. Either route registers the tool when a session starts; restart OpenCode after wiring it.

## It stands alone

Nothing outside this package is required to use it. The model list, the sandbox, and the timeouts all live in the config below, and the credential is resolved from the host's active connection on every call — it is never stored here. It does not import, read, or depend on another package, and it does not care which harness or agent definitions you run.

## Configuration

Per call beats operator default beats built-in. The operator default is `oc-dex.config.json` beside the plugin (ignored by git; a local copy stays local), and a `plugins` entry's `options` wins over that file. Every key is optional; each one falls back to the default shown below.

| Key | Default | What it decides |
| --- | --- | --- |
| `models` | `["deepseek-v4.1-flash", "muse-spark-1.3-contributor"]` | The allowlist. A per-call model outside it is refused before anything is spawned. |
| `defaultModel` | The first entry of `models` | The model a call runs on when it names none. |
| `allowWorkspaceWrite` | `false` | `true` admits the `workspace-write` sandbox mode; `false` leaves every run read-only. |
| `maxTimeoutSeconds` | `900` | The ceiling a per-call `timeoutSeconds` may not cross. |
| `codexHome` | `<local-app-data>/oc-dex/codex-home` | The `CODEX_HOME` the child runs with. |
| `reasoningEffort` | unset | The per-turn effort override (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`). Unset omits it and the server default applies. |
| `progress` | `"concise"` | How the running row renders (`concise`, `full`, or `off`). |
| `heartbeatSeconds` | `10` | How often the running row redraws while the child is quiet. |

A bad value fails at setup (operator default) or at call time (per-call argument), never mid-run. The exact rules live in `src/config.js`.

## What you get

| | |
| --- | --- |
| `oc_dex` | `prompt` (required) runs a bounded task and returns its text plus the thread id. `model` must be on the allowlist. `mode` is `read-only` unless `workspace-write` is enabled above. `timeoutSeconds` caps the run. `threadId` resumes a previous run. `reasoningEffort` overrides the operator default for one call. |

Every approval the child requests is declined, and its sandbox always denies network access. The credential travels in the child's environment only — never in its argv — and every line the tool returns has it redacted.

## Requirements

OpenCode V2, with Node 22 or newer, a `codex` CLI on PATH (`codex.exe` on Windows), and an active OpenCode Go API key connection in the host.
