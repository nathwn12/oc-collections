# oc-collections

**Find every nathwn12 oc-* plugin in one index.**

You want an OpenCode plugin from the nathwn12 family. You read this index, you pick a row, you follow its link.

## Install

You install the listed plugins, not this index. To keep a local copy of the index, paste:

```sh
git clone https://github.com/nathwn12/oc-collections.git
```

Cloning tracks `main`, so you always read the latest table. You need Git before you paste it.

### Offline or pinned

To freeze the index at the `v0.2.2` tag instead of tracking `main`, paste:

```sh
git clone --branch v0.2.2 https://github.com/nathwn12/oc-collections.git
```

## Use it

Pick a row in the table below and follow its repo or npm link to the plugin you want.

To confirm every link still resolves and every pin is still published, run from the repo root:

```powershell
pwsh -NoProfile -File scripts/check-index.ps1
```

It exits `0` only when every check passes. The current table passes with `checked=9 failed=0`.

## What you get

One table for the whole family. You read the row, you install that plugin:

| Repo | What it does for you | Pin | Links |
| --- | --- | --- | --- |
| oc-todo | You track per-session todo lists in your OpenCode terminal. | `oc-todo@0.5.0` | [repo](https://github.com/nathwn12/oc-todo) · [npm](https://www.npmjs.com/package/oc-todo) |
| oc-bifrost | You run V1-era plugin hooks on the OpenCode V2 runtime. | `@nathwn12/oc-bifrost@1.6.5` | [repo](https://github.com/nathwn12/oc-bifrost) · [npm](https://www.npmjs.com/package/@nathwn12%2Foc-bifrost) |
| oc-flight-deck | You see live session telemetry in your OpenCode sidebar. | `oc-flight-deck@0.19.2` | [repo](https://github.com/nathwn12/oc-flight-deck) · [npm](https://www.npmjs.com/package/oc-flight-deck) |
| oc-harness-setup | You install and orchestrate the whole harness in one PowerShell command. | `oc-harness-setup@0.3.3` | [repo](https://github.com/nathwn12/oc-harness-setup) · [npm](https://www.npmjs.com/package/oc-harness-setup) |
| oc-collections | You read this index. | not on npm | [repo](https://github.com/nathwn12/oc-collections) |

This repo publishes nothing to npm. A release tag records the state of the index, not installable code.

## Requirements

You need Git to clone the index.

You need PowerShell 7 to run `scripts/check-index.ps1`.

You need OpenCode to run the listed plugins.

## Links

- Source: [nathwn12/oc-collections](https://github.com/nathwn12/oc-collections)
- License: [LICENSE](LICENSE)
- Index history: [CHANGELOG.md](CHANGELOG.md)
- npm: [oc-todo](https://www.npmjs.com/package/oc-todo) · [@nathwn12/oc-bifrost](https://www.npmjs.com/package/@nathwn12%2Foc-bifrost) · [oc-flight-deck](https://www.npmjs.com/package/oc-flight-deck) · [oc-harness-setup](https://www.npmjs.com/package/oc-harness-setup)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
