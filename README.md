<p align="center">
  <img src="assets/icon.svg" width="120" height="120" alt="oc-collections icon" />
</p>
<h1 align="center">oc-collections</h1>
<p align="center"><strong>Index the nathwn12 oc-* plugin family for OpenCode users.</strong></p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/nathwn12/oc-collections" alt="License" /></a>
  <img src="https://img.shields.io/github/languages/top/nathwn12/oc-collections" alt="Language" />
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="Platform" />
</p>

## Project name and description

**oc-collections** is the index of the nathwn12 `oc-*` family: one front door listing every OpenCode plugin, installer, and bridge in the set, with its repo, its npm package and version, and its link. It is for OpenCode users discovering what to install, and for contributors keeping that list honest. Install the listed plugins, not this repo.

| Repo | One line | npm | Link |
| --- | --- | --- | --- |
| oc-todo | Per-session todo lists for your OpenCode terminal. | `oc-todo@0.5.0` | [repo](https://github.com/nathwn12/oc-todo) · [npm](https://www.npmjs.com/package/oc-todo) |
| oc-bifrost | Run V1-era OpenCode plugin hooks on the OpenCode V2 runtime. | `@nathwn12/oc-bifrost@1.6.5` | [repo](https://github.com/nathwn12/oc-bifrost) · [npm](https://www.npmjs.com/package/@nathwn12%2Foc-bifrost) |
| oc-flight-deck | Live session telemetry in your OpenCode sidebar. | `oc-flight-deck@0.19.2` | [repo](https://github.com/nathwn12/oc-flight-deck) · [npm](https://www.npmjs.com/package/oc-flight-deck) |
| oc-harness-setup | Install and orchestrate the whole OpenCode harness in one command - PowerShell. | `oc-harness-setup@0.3.3` | [repo](https://github.com/nathwn12/oc-harness-setup) · [npm](https://www.npmjs.com/package/oc-harness-setup) |
| oc-collections | This index. | not on npm | [repo](https://github.com/nathwn12/oc-collections) |

Each plugin ships on its own version line, so one index keeps the set discoverable.

## Technology stack

- Markdown index (`README.md` table) as the source of truth — no package, no build.
- PowerShell (`scripts/check-index.ps1`) as the one executable check.
- GitHub Actions (`check.yml`, `ci.yml`) for index integrity on push and PR.
- npm registry API (`registry.npmjs.org`) as the canonical version source, since the npmjs.com storefront returns HTTP 403 to non-browser clients.

## Architecture

The repo is a pointer, not a program: the `README.md` table promises that every repo link reaches a live repository, every npm link names a package present on the registry, and every pinned version is actually published. `scripts/check-index.ps1` proves it — it reads each table row from `README.md`, checks the repo URL over HTTP, resolves the npm package through the registry API, and confirms the pinned version appears in the published version list.

> [!NOTE]
> This repo publishes nothing. A release is an annotated tag `v<version>` recording a state of the index, not a version of installable code.

## Getting started

Use it: read the plugin table above and follow a repo or npm link to the plugin you want.

Check it: run the repo's one check from the repo root:

```powershell
pwsh -NoProfile -File scripts/check-index.ps1
```

It exits `0` only when every link resolves and every pinned version is published.

## Project structure

- `README.md` — the index table and the captured check-output block; the table is the source of truth.
- `scripts/check-index.ps1` — the one executable check; verifies every index link.
- `.github/workflows/check.yml` — verifies required files exist, the tree holds no implementation files, and no internal vocabulary leaks into the tracked tree.
- `.github/workflows/ci.yml` — verifies the index files are present.
- `AGENTS.md` — contributor guide (commits, branches, PRs, guardrails).
- `CHANGELOG.md` — index history.
- `LICENSE` — license text.
- `assets/icon.svg` — repo icon. `assets/signature.svg` — shared footer signature.
- `.gitattributes` — line-ending and export settings. `.gitignore` — local ignore rules.

## Key features

- One table for the whole `oc-*` family: repo, one-line description, npm package and version, links.
- Every pin is installable: the check confirms each pinned version is actually published.
- No implementation to rot: no package manifest, no lifecycle scripts, no build.

## Development workflow

- Branch as `<type>/<slug>` (for example `docs/repo-guide`).
- Land only through a pull request, squash-merge it, then delete the branch.
- Keep `CHANGELOG.md` and the docs current with every index change.
- A new index row keeps the existing column order: repo, one-line description, npm package and version, links.

## Coding standards

- Write conventional commit subjects (for example `docs: ...`, `chore: ...`).
- The captured check-output block is the script's real output — regenerate it by running the script and pasting its output, never by hand-editing numbers.

> [!CAUTION]
> Never hand-edit the captured check-output block — anything else silently falsifies the guarantee. Never leave an index row pointing at a version that is not published.

## Testing

The index check is the test suite. Every repo and npm link in the table above is checked against the live GitHub repo and the npm registry by `scripts/check-index.ps1`, which also confirms each pinned version is actually published:

```
$ pwsh -NoProfile -File scripts/check-index.ps1
PASS oc-todo          repo HTTP 200  https://github.com/nathwn12/oc-todo
PASS oc-todo          npm  registry OK - 0.5.0 published  oc-todo
PASS oc-bifrost       repo HTTP 200  https://github.com/nathwn12/oc-bifrost
PASS oc-bifrost       npm  registry OK - 1.6.5 published  @nathwn12/oc-bifrost
PASS oc-flight-deck   repo HTTP 200  https://github.com/nathwn12/oc-flight-deck
PASS oc-flight-deck   npm  registry OK - 0.19.2 published  oc-flight-deck
PASS oc-harness-setup repo HTTP 200  https://github.com/nathwn12/oc-harness-setup
PASS oc-harness-setup npm  registry OK - 0.3.3 published  oc-harness-setup
PASS oc-collections   repo HTTP 200  https://github.com/nathwn12/oc-collections
checked=9 failed=0
$ echo $LASTEXITCODE
0
```

npm versions are read from `registry.npmjs.org` because npmjs.com returns HTTP 403 to non-browser clients.

## Contributing

See [AGENTS.md](AGENTS.md) for the contributor guide — branches, pull requests, and the index guardrails (no hand-edited output block, no unpublished pins, no package manifest, no install/build lifecycle scripts).

## License

MIT — see [LICENSE](LICENSE). History lives in [CHANGELOG.md](CHANGELOG.md).

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
