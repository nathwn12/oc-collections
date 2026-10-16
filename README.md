<p align="center">
  <img src="assets/icon.svg" width="120" height="120" alt="oc-collections icon" />
</p>
<h1 align="center">oc-collections</h1>
<p align="center"><strong>Index the nathwn12 oc-* plugin family for OpenCode users.</strong></p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/nathwn12/oc-collections" alt="License" /></a>
  <img src="https://img.shields.io/github/languages/top/nathwn12/oc-collections" alt="Language" />
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="Platform" />
  <a href="https://github.com/nathwn12/oc-collections/actions/workflows/ci.yml"><img src="https://github.com/nathwn12/oc-collections/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

## What it is

The index of the nathwn12 `oc-*` family: one front door listing every OpenCode plugin, installer, and bridge in the set, with its repo, its npm package and version, and its link. Install the plugins below, not this repo.

| Repo | One line | npm | Link |
| --- | --- | --- | --- |
| oc-todo | Per-session todo lists for your OpenCode terminal. | `oc-todo@0.4.0` | [repo](https://github.com/nathwn12/oc-todo) · [npm](https://www.npmjs.com/package/oc-todo) |
| oc-bifrost | Run V1-era OpenCode plugin hooks on the OpenCode V2 runtime. | `@nathwn12/oc-bifrost@1.6.4` | [repo](https://github.com/nathwn12/oc-bifrost) · [npm](https://www.npmjs.com/package/@nathwn12%2Foc-bifrost) |
| oc-flight-deck | Live session telemetry in your OpenCode sidebar. | `oc-flight-deck@0.12.0` | [repo](https://github.com/nathwn12/oc-flight-deck) · [npm](https://www.npmjs.com/package/oc-flight-deck) |
| oc-harness-setup | Install and orchestrate the whole OpenCode harness in one command - PowerShell. | `oc-harness-setup@0.3.1` | [repo](https://github.com/nathwn12/oc-harness-setup) · [npm](https://www.npmjs.com/package/oc-harness-setup) |
| oc-collections | This index. | not on npm | [repo](https://github.com/nathwn12/oc-collections) |

## Why

Each plugin ships on its own version line, so one index keeps the set discoverable.

## Status

**Maintenance** — works, changes only on breakage.

Every repo and npm link in the table above is checked against the live GitHub repo and the npm registry by `scripts/check-index.ps1`, which also confirms each pinned version is actually published:

```
$ pwsh -NoProfile -File scripts/check-index.ps1
PASS oc-todo          repo HTTP 200  https://github.com/nathwn12/oc-todo
PASS oc-todo          npm  registry OK - 0.4.0 published  oc-todo
PASS oc-bifrost       repo HTTP 200  https://github.com/nathwn12/oc-bifrost
PASS oc-bifrost       npm  registry OK - 1.6.4 published  @nathwn12/oc-bifrost
PASS oc-flight-deck   repo HTTP 200  https://github.com/nathwn12/oc-flight-deck
PASS oc-flight-deck   npm  registry OK - 0.12.0 published  oc-flight-deck
PASS oc-harness-setup repo HTTP 200  https://github.com/nathwn12/oc-harness-setup
PASS oc-harness-setup npm  registry OK - 0.3.1 published  oc-harness-setup
PASS oc-collections   repo HTTP 200  https://github.com/nathwn12/oc-collections
checked=9 failed=0
$ echo $LASTEXITCODE
0
```

npm versions are read from `registry.npmjs.org` because npmjs.com returns HTTP 403 to non-browser clients.

## License

MIT — see [LICENSE](LICENSE).

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
