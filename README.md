<p align="center">
  <img src="assets/icon.svg" width="120" height="120" alt="oc-collections icon" />
</p>
<h1 align="center">oc-collections</h1>
<p align="center"><strong>Index the nathwn12 oc-* plugin family for OpenCode users — TypeScript.</strong></p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/nathwn12/oc-collections" alt="License" /></a>
  <img src="https://img.shields.io/github/languages/top/nathwn12/oc-collections" alt="Language" />
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="Platform" />
  <a href="https://github.com/nathwn12/oc-collections/actions/workflows/ci.yml"><img src="https://github.com/nathwn12/oc-collections/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

## What it is

The index of the nathwn12 `oc-*` family: one front door listing every OpenCode plugin, installer, and bridge in the set, with its repo, its npm package and version, and its link. This repo originally shipped a module host — one plugin bundling three mini-plugins (`***REMOVED***`, `***REMOVED***`, `***REMOVED***`) — and that host is SUPERSEDED: its modules now live on as separately published plugins and as local plugins (`./plugins/***REMOVED***`, `./plugins/***REMOVED***`, `./plugins/***REMOVED***`), nothing mounts this repo anymore, and the `oc-collections` npm package was unpublished on 2026-10-08. Install the plugins below, not this repo.

| Repo | One line | npm | Link |
| --- | --- | --- | --- |
| oc-todo | Per-session todo lists for your OpenCode terminal. | `oc-todo@0.4.0` | [repo](https://github.com/nathwn12/oc-todo) · [npm](https://www.npmjs.com/package/oc-todo) |
| oc-bifrost | Run V1-era OpenCode plugin hooks on the OpenCode V2 runtime. | `@nathwn12/oc-bifrost@1.6.3` | [repo](https://github.com/nathwn12/oc-bifrost) · [npm](https://www.npmjs.com/package/@nathwn12%2Foc-bifrost) |
| oc-flight-deck | Live session telemetry in your OpenCode sidebar. | `oc-flight-deck@0.12.0` | [repo](https://github.com/nathwn12/oc-flight-deck) · [npm](https://www.npmjs.com/package/oc-flight-deck) |
| oc-harness-setup | Install and orchestrate the whole OpenCode harness in one command - PowerShell. | `oc-harness-setup@0.3.1` | [repo](https://github.com/nathwn12/oc-harness-setup) · [npm](https://www.npmjs.com/package/oc-harness-setup) |
| oc-collections | This index. The original module host; not a live plugin. | not published (unpublished 2026-10-08) | [repo](https://github.com/nathwn12/oc-collections) |

## Why

The family outgrew the bundle. Each module became its own plugin with its own version line, and the bundle itself stopped being installed anywhere — so the honest shape for this repo is a museum catalogue, not a plugin front page. One table stays current; five READMEs stop disagreeing.

## The module host

The history is kept, not pretended away. The original source still lives in the tree — `src/modules/***REMOVED***`, `src/modules/***REMOVED***`, `src/modules/***REMOVED***`, plus `index.ts`, `oc-collections.schema.json`, and `oc-collections.example.jsonc` — frozen as it was. Nothing here is presented as installable; for live code, use the plugins in the table above.

## Status

**Maintenance** — works, changes only on breakage.

## License

MIT — see [LICENSE](LICENSE).

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
