# oc-collections

A curated index of the family's OpenCode plugins — one front door listing every plugin, installer, and bridge in the set, with its repo, its npm package, and its link. The same repo is the npm-workspaces monorepo where the family's packages are developed, one package per `packages/` directory. It is for OpenCode users discovering what to install, and for contributors keeping that list honest. Install the listed plugins, not this repo.

## Quick start

Use it: read the plugin table in `README.md` and follow a repo or npm link to the plugin you want.

Check the index from the repo root:

```powershell
pwsh -NoProfile -File scripts/check-index.ps1 --structural
```

The structural half is offline: it exits `0` only when every table name is well-formed and matches a package in this repo. It runs on every pull request.

To prove it can still go red, run the self-test:

```powershell
pwsh -NoProfile -File scripts/check-index.selftest.ps1
```

It asserts a zero-row fixture and a phantom-package fixture exit non-zero, and the real README exits `0` — all offline.

The registry half is the post-publish check (`--registry`): it verifies every listed package resolves and every claimed version is published. The four packages released from this repo must also name this monorepo in their registry metadata; `gladius-mcp` and `puppet-mcp` are existence/version-only by design (the table and its reasons live in `scripts/index-registry.ps1`). It cannot pass before a release.

Check the packages from the repo root:

```sh
npm install
npm run check
```

`npm run check` runs every package's own check (typecheck, compile, tests) and exits `0` only when every package is green.

## Layout

- `README.md` — the index table; the table is the source of truth.
- `CHANGELOG.md` — index and monorepo history; earlier implementation history was removed with the implementation.
- `MIGRATIONS.md` — what moved into `packages/` and `crates/`, from where, and which owner calls remain open.
- `LICENSE` — license text.
- `package.json` — the private root manifest: the workspaces list and the fan-out scripts.
- `scripts/check-index.ps1` — `--structural` (offline, PR) checks table names against the repo; `--registry` (post-publish) checks the published world.
- `scripts/index-registry.ps1` — the released/external package scope table (one reason per entry) and the repository-metadata assertion.
- `scripts/check-index.selftest.ps1` — proves the structural red path and both repository-assertion directions, offline.
- `scripts/workspace-run.mjs` — root fan-out that executes the shared plan.
- `scripts/workspace-plan.mjs` — the shared plan both runners import: which packages exist and each package's exact check/build/test commands.
- `scripts/pack-check.mjs` — packs and verifies every workspace tarball; fails closed on zero or unplanned workspaces.
- `scripts/check-launcher.mjs` — offline validation for the npx launcher packages (bin, files, manifest consistency).
- `Cargo.toml` — the root Cargo workspace for the Rust MCP crates.
- `packages/<name>/` — one family package per directory; each keeps its own manifest, tests, and version line.
- `crates/<name>/` — one Rust MCP server per crate; each keeps its own manifest and toolchain file.
- `.github/workflows/check.yml` — index integrity, the offline doc check, the vocabulary guard, and the workspace-wide check.
- `assets/signature.svg` — shared footer signature.
- `.gitattributes` — line-ending and export settings.
- `.gitignore` — local ignore rules.

## Conventions

- Write conventional commit subjects (for example `docs: ...`, `chore: ...`).
- Branch as `<type>/<slug>` (for example `docs/repo-guide`).
- Land only through a pull request, squash-merge it, then delete the branch.
- Keep `CHANGELOG.md` and the docs current with every index change.
- A new index row keeps the existing column order: repo, one-line description, npm package and version, links.
- A package that moves in keeps its published npm name and its own version line; record the move in `MIGRATIONS.md`.

## What the index guarantees

The table promises that every repo link reaches a live repository, every npm link names a package present on the registry, and every pinned version is actually published. `scripts/check-index.ps1 --structural` checks the table names against the repo's package inventory offline on every PR; `--registry` (post-publish) checks the repo and npm links and confirms each claimed version is published. There is no captured output block in `README.md` — run the script and read its output directly.

## Release

The root manifest is `private: true` and is never published. The repo's own release is an annotated tag `v<version>` recording a state of the index — this is not a package release tag; package releases use `<package>@<version>` below.

Package releases are tag-driven per package: push `<package>@<version>` (the scoped package is `@nathwn12/oc-bifrost@<version>`), or dispatch the `release` workflow with `dry_run` left on. `.github/workflows/release.yml` has run four times, one package per run: `@nathwn12/oc-bifrost@1.6.10`, `oc-flight-deck@0.20.2`, `oc-harness-setup@0.4.4`, and `rea-shim@0.1.2`, each released through OIDC trusted publishing with provenance, each carrying two attestations, and `latest` correct on all four. Every publish step succeeded, and every run still concluded `failure` at one step: `Verify the released package on the registry` ran about 1.6 s after publish and lost npm's propagation race. That step now retries only the not-published shape (17 attempts, about 7m15s), which no real release has exercised yet; the `dry_run` dispatch path has never run either. `gladius-mcp` and `puppet-mcp` stay on their original release lanes until their engine-manifest placeholders are handled here. `oc-unified` (private) is source-only and not releasable until the owner revisits that ruling. See `MIGRATIONS.md`.

## Guardrails

- Never paste check output the script did not print — run the script and paste its real output.
- A claimed version is a promise: the registry half checks it after publish, so a bumped pin is not installable until its release run completes.
- Never rename a published package when it moves in — `@nathwn12/oc-bifrost` stays `@nathwn12/oc-bifrost`.
- Never publish the root — it stays `private: true`.
- Never add an install-time lifecycle script (`install`, `postinstall`, `preinstall`, `prepare`, `prepack`) to the root manifest: the root is never installed, and the index should not execute on install.
- Package guardrails travel with the package; read `packages/<name>/AGENTS.md` before changing its manifest.
