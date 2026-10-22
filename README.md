<h1 align="center">oc-collections</h1>
<p align="center"><strong>Find every nathwn12 oc-* plugin in one index — the npm-workspaces monorepo where the family's packages are developed.</strong></p>

You want an OpenCode plugin from the nathwn12 family. You read this index, you pick a row, you follow its link. Packages that live in this repo are listed with their npm name, their current version, and their install line.

## Install

Install the package you want, not this index. The OpenCode plugins are fetched by the host from your config; the installer and MCP launchers run through npx.

- `@nathwn12/oc-bifrost` — add one entry to the `plugins` array in your `opencode.jsonc` and restart OpenCode; the host fetches the package, so you run no install command. Its [INSTALL.md](packages/oc-bifrost/INSTALL.md) is the agent-first setup page.
- `oc-flight-deck` — add it to the `plugins` array and restart OpenCode; its [README](packages/oc-flight-deck/README.md) has the exact entry.
- `oc-harness-setup` — run `npx --yes oc-harness-setup setup`; its [README](packages/oc-harness-setup/README.md) is the setup guide.
- `rea-shim` — run `npx -y rea-shim --doctor`, then wire it as an MCP stdio server; see its [README](packages/rea-shim/README.md).
- `gladius-mcp` — run `npx -y gladius-mcp`; it downloads its pinned browser and runtime from the `nathwn12/gladius` release assets on first run.
- `puppet-mcp` — run `npx -y puppet-mcp`; it downloads its pinned server from the `nathwn12/puppet` release assets on first run.

To keep a local copy of the index, paste:

```sh
git clone https://github.com/nathwn12/oc-collections.git
```

Cloning tracks `main`, so you always read the latest table. You need Git before you paste it.

### Offline or pinned

The release tag is created at release time; until then, clone the default branch:

```sh
git clone https://github.com/nathwn12/oc-collections.git
```

## Use it

Pick a row in the table below and follow its repo or npm link to the plugin you want.

To check the index structure without network (this runs on every pull request), run from the repo root:

```powershell
pwsh -NoProfile -File scripts/check-index.ps1 --structural
```

It exits `0` only when every table name is well-formed and matches a package in this repo, with no extras or omissions.

To verify the published world after a release, run:

```powershell
pwsh -NoProfile -File scripts/check-index.ps1 --registry
```

It resolves every listed package on the npm registry and checks each claimed version is published. For the four packages released from this repository it also confirms the registry metadata names this monorepo; `oc-todo` (EOL), `gladius-mcp`, and `puppet-mcp` (their original release lanes) are checked for existence and claimed version only, because their published metadata names those original repositories by design. It is a post-publish check: it cannot pass in the window between a version bump and its publish.

## What you get

One table for the whole family. You read the row, you install that plugin:

| Repo | What it does for you | Pin | Links |
| --- | --- | --- | --- |
| oc-bifrost | Lives in this repo at [`packages/oc-bifrost`](packages/oc-bifrost) — you run V1-era plugin hooks on the OpenCode V2 runtime. | `@nathwn12/oc-bifrost@1.6.10` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/@nathwn12%2Foc-bifrost) |
| gladius-mcp | Lives in this repo at [`packages/gladius-mcp`](packages/gladius-mcp) — an MCP browser-use server (npx launcher); engine binaries come from the gladius repo's release assets. | `gladius-mcp@0.4.2` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/gladius-mcp) |
| puppet-mcp | Lives in this repo at [`packages/puppet-mcp`](packages/puppet-mcp) — a Windows desktop-control MCP server (npx launcher); engine binaries come from the puppet repo's release assets. | `puppet-mcp@4.5.3` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/puppet-mcp) |
| oc-flight-deck | Lives in this repo at [`packages/oc-flight-deck`](packages/oc-flight-deck) — you see live session telemetry in your OpenCode sidebar. | `oc-flight-deck@0.20.2` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/oc-flight-deck) |
| oc-harness-setup | Lives in this repo at [`packages/oc-harness-setup`](packages/oc-harness-setup) — you install and orchestrate the whole harness in one PowerShell command. | `oc-harness-setup@0.4.4` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/oc-harness-setup) |
| oc-unified | Lives in this repo at [`packages/oc-unified`](packages/oc-unified) — one background plugin for session watching, tool liveness, and title renaming. Not published. | not on npm | [repo](https://github.com/nathwn12/oc-collections) |
| rea-shim | Lives in this repo at [`packages/rea-shim`](packages/rea-shim) — a one-line MCP launcher for rea. | `rea-shim@0.1.2` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/rea-shim) |
| oc-todo | Archived at [`archive/oc-todo`](archive/oc-todo) — deprecated end-of-life; OpenCode 2.1 restored the built-in `todowrite`; [see EOL](https://github.com/nathwn12/oc-todo/blob/main/EOL.md). | `oc-todo@0.5.1` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/oc-todo) |
| oc-collections | You read this index; the monorepo root is private and never published. | not on npm | [repo](https://github.com/nathwn12/oc-collections) |

Packages that move into `packages/` keep their npm name and their own version line — `@nathwn12/oc-bifrost` stays `@nathwn12/oc-bifrost`. The root manifest is `private: true`: the root is never published, and only the packages under `packages/` publish, from their own directories. `oc-unified` is `private: true` and not on npm; `oc-todo` is archived, not a workspace. [MIGRATIONS.md](MIGRATIONS.md) records what has moved in, and which owner calls are still open.

The monorepo is the source for every package here. The two MCP launchers still fetch their engine binaries from the original repos' immutable GitHub Release assets (`gladius`, `puppet`); only the launcher, its manifest, and the Rust crate live in this repo.

## Requirements

You need Git to clone the index, and Node 22 or later plus Bun (for the packages whose own checks use it) to build or test the packages. The Rust crates need a Cargo toolchain, and their servers are Windows-only.

You need PowerShell 7 to run `scripts/check-index.ps1`.

You need OpenCode to run the listed plugins.

## Development

The repo is an npm-workspaces monorepo; the root lockfile is the only lockfile. From the repo root:

```sh
npm install   # resolve the workspace and install every package's dependencies
npm run check # every package's own check (each package's exact commands)
npm run build # every package's build step (packages without one are skipped)
npm test      # every package's test suite
npm run pack:check # check + build, then pack and verify every package
```

The Rust crates are a separate Cargo workspace: `cargo metadata --no-deps` lists them, and `cargo build` builds both (the servers are Windows-only).

## Release

Releases are tag-driven per package; there is no Changesets step (npm 12 breaks its registry parsing, and the packages version independently). Push a tag named `<package>@<version>` — for the scoped package, `@nathwn12/oc-bifrost@<version>` — whose version equals that package's own `package.json`. The release guard refuses an unknown package, a version mismatch, an already-published version, or a target older than the newest published one.

To rehearse without publishing, run the `release` workflow manually, choose the package, and leave `dry_run` on (the default). The dry run runs the full gate and `npm publish --dry-run`.

Four packages are releasable: `@nathwn12/oc-bifrost`, `oc-flight-deck`, `oc-harness-setup`, and `rea-shim`. `gladius-mcp` and `puppet-mcp` are not released from this repo yet: their engine manifests carry placeholders filled by their own Rust release pipelines, so they stay on their original repos' release lanes. `oc-unified` (private) and `oc-todo` (EOL: OpenCode ships an official todo feature) are carried as source only and are excluded from the release lane until the owner revisits that ruling.

## Links

- Source: [nathwn12/oc-collections](https://github.com/nathwn12/oc-collections)
- Index history: [CHANGELOG.md](CHANGELOG.md)
- Migrations: [MIGRATIONS.md](MIGRATIONS.md)
- npm: [oc-todo](https://www.npmjs.com/package/oc-todo) · [@nathwn12/oc-bifrost](https://www.npmjs.com/package/@nathwn12%2Foc-bifrost) · [oc-flight-deck](https://www.npmjs.com/package/oc-flight-deck) · [oc-harness-setup](https://www.npmjs.com/package/oc-harness-setup) · [rea-shim](https://www.npmjs.com/package/rea-shim) · [gladius-mcp](https://www.npmjs.com/package/gladius-mcp) · [puppet-mcp](https://www.npmjs.com/package/puppet-mcp)
- Releases: https://github.com/nathwn12/oc-collections/releases
- Issues: https://github.com/nathwn12/oc-collections/issues
- License: [LICENSE](LICENSE)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
