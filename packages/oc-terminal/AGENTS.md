# oc-terminal - package guardrails

Read the repo root AGENTS.md first; it binds this package too.

## What this package is

The Windows spawn guard. Two jobs, one package: resolve a real JavaScript
runtime instead of the compiled host's `opencode.exe`, and make `windowsHide`
the default for every child the host process can spawn.

## Rules the check enforces

- **`node:` imports only.** Zero dependencies, zero build step.
- **No shell shim.** Direct spawn only; never `cmd /c` to reach a program.
- **Hidden by default.** `windowsHide: true` on Windows unless
  `OC_TERMINAL_ALLOW_VISIBLE=1` is set for a deliberate diagnostic.
- **The guard never throws into the host.** Setup catches; a failed patch is a
  reported state, never a failed request.
- **Idempotent patch.** The wrapper functions carry a mark, so a hot reload
  cannot stack a second wrapper.
- **Private, source-only.** `private: true` and absent from the release
  allowlist; it is installed by junction.

## Commands

```sh
npm run check -w packages/oc-terminal
```
