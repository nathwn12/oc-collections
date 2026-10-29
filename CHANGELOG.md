# Changelog

## [Unreleased]

- Removed the frozen in-repo MCP copies and the dead private package: `packages/gladius-mcp`, `packages/puppet-mcp`, `packages/oc-unified`, `crates/gladius`, and `crates/puppet`. The root workspace plan, lockfile, Cargo workspace, and index table no longer reference them; no retained package file was changed by this removal.
- Removed `packages/rea-shim`: the package now lives in its own `rea-shim` repository at 0.2.2. The root workspace plan, lockfile, release allowlist, dispatch choice list, index table, registry scope table, doc checker, and index self-test no longer reference it; the repo releases three packages. Historical migration and release records are unchanged.
- `rea-shim` left this repo with its own instructions: the `--bootstrap` work (upstream Ghidra policy, JDK minimum from the installed Ghidra, hardened extraction and version gates, offline contract suite) shipped from its own repository, where the package now lives at 0.2.2. Its changelog travels with it; this repo no longer carries a copy.

## [0.2.6] - 2026-10-22

- Converted the repo to an npm-workspaces monorepo: a private root `package.json` with fan-out `check`/`build`/`test` scripts, a root lockfile, and a workspace-wide check in `.github/workflows/check.yml`.
- Moved `@nathwn12/oc-bifrost@1.6.9` into `packages/oc-bifrost` (source branch `docs/1.6.9`, HEAD `9723533`); see [MIGRATIONS.md](MIGRATIONS.md).
- Rewrote the README to the monorepo truth: one index table with the in-repo package marked, the install line, and the publish rule.
- Adapted the check vocabulary guard's scope and the no-implementation-files assertion for the imported package tree; see [MIGRATIONS.md](MIGRATIONS.md).
- `scripts/check-index.ps1` now fails when it recognises no index rows; `scripts/check-index.selftest.ps1` proves both the failing and passing directions.
- Root `npm run pack:check` runs the workspace check (which rebuilds `dist/`) before packing, so the sanctioned pack path cannot ship a dist-less tarball.
- Moved `oc-flight-deck@0.20.1`, `oc-harness-setup@0.4.3`, `oc-unified@0.5.0`, and `rea-shim@0.1.1` into `packages/` (versions unchanged); archived `oc-todo@0.5.1` at `archive/oc-todo/`.
- Generalised the root fan-out (`scripts/workspace-run.mjs`) and the pack guard (`scripts/pack-check.mjs`); `npm run pack:check` now checks, builds, and verifies every workspace tarball.
- Narrowed the vocabulary guard to the index's own files and allowed package/archive sources in the implementation-file assertion; see [MIGRATIONS.md](MIGRATIONS.md).
- `scripts/pack-check.mjs` now fails closed on zero workspaces or a workspace missing from the shared plan (`scripts/workspace-plan.mjs`, also used by `workspace-run.mjs`).
- `.github/workflows/check.yml` now runs `npm run pack:check` after the workspace check, so tarball verification runs in CI.
- Corrected `MIGRATIONS.md`: oc-flight-deck's `dist/` is tracked by policy but is not yet committed.
- Imported `gladius@0.4.2` and `puppet@4.5.3` from their release tags: Rust crates under `crates/`, npx launchers under `packages/gladius-mcp` and `packages/puppet-mcp`, plus the root Cargo workspace.
- Added `scripts/check-launcher.mjs` (offline bin/manifest validation) and wired both launchers into the workspace plan; `pack:check` now covers seven packages.
- Engine binaries still come from the original repos' release assets; the launchers' manifests, install guards, and `os`/`cpu` gap are unchanged.
- Vocabulary guard now excludes `crates/` as well (imported Rust sources and docs use the guarded words as ordinary English).
- Added `.github/workflows/release.yml`: tag-driven per-package releases for the four releasable packages, with a dry-run dispatch (default), OIDC trusted publishing, and a registry guard; `gladius-mcp`/`puppet-mcp` are deferred, and `oc-unified`/`oc-todo` are excluded per the owner's deprecated/private ruling.
- Added `scripts/release-target.mjs` and its parser/guard tests; CI now runs the parser test.

- Bumped the four releasable packages for the monorepo release (bifrost 1.6.10, flight-deck 0.20.2, harness 0.4.4, rea-shim 0.1.2) and removed every git/local-clone install route; npm is the only install route.
- Split the index check into `--structural` (offline, PR) and `--registry` (post-publish); unpinned every consumer install command and moved registry verification into the release workflow after publish.

## [0.2.5] - 2026-10-21

- Re-pinned oc-bifrost to 1.6.9.
- Replaced the prose check count with the script's captured output block.
- No other pin changes.

## [0.2.4] - 2026-10-21

- Fix the oc-todo row so its EOL is a clickable link; no pin changes.

## [0.2.3] - 2026-10-21

- Re-pinned the index table to the live releases: oc-todo 0.5.1 (deprecated), oc-bifrost 1.6.8, oc-flight-deck 0.20.1, oc-harness-setup 0.4.3.
- Marked oc-todo end-of-life; see its [EOL.md](https://github.com/nathwn12/oc-todo/blob/main/EOL.md).

## Index

- This repo is an index of the nathwn12 oc-* plugin family; the plugin table in `README.md` is the source of truth. Install the listed plugins, not this repo.
- The bundled plugin implementation, its suite, its config schema and example, and the old install routes are removed from the tracked tree.
- Earlier entries describing the removed implementation are omitted from this file.
