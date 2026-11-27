# Maintaining oc-collections

Start with the [root README](../README.md) for the public catalog and [RELEASE.md](RELEASE.md) for the canonical release lane. This file is only the maintainer map.

## Key paths

| Path | Job |
| --- | --- |
| [packages/](../packages/) | Workspace packages; read each package's `AGENTS.md` before manifest changes. |
| [scripts/workspace-plan.mjs](../scripts/workspace-plan.mjs) | Exact per-workspace check, build and test commands. |
| [scripts/index-table.mjs](../scripts/index-table.mjs) | Shared README grammar and inventory reader. |
| [scripts/check-index.ps1](../scripts/check-index.ps1) | Offline structural gate and post-publish registry gate. |
| [scripts/check-docs.mjs](../scripts/check-docs.mjs) | Path claims and package README front-door rules. |
| [scripts/derive-release.mjs](../scripts/derive-release.mjs) | Version derivation and runner-only version-cell writes. |
| [scripts/release-target.mjs](../scripts/release-target.mjs) | Releasable-package allowlist and registry guard. |
| [scripts/pack-check.mjs](../scripts/pack-check.mjs) | Tarball contents and entry-point checks. |
| [scripts/cleanroom.mjs](../scripts/cleanroom.mjs) | Empty-project install probe. |
| [.github/workflows/ci.yml](../.github/workflows/ci.yml) | Pull-request checks. |
| [.github/workflows/release.yml](../.github/workflows/release.yml) | Merge-to-main release and manual dry run. |

## Index grammar

- Keep one root README table: `Package | Kind | Version | What it does | Install`.
- Every data row starts with `|`; cell one is the bare unscoped label, not a link.
- Cell three's first backticked token is the exact source `package.json` version, not npm's latest; the root repo row has no pin.
- Keep five columns. Group by row order and prose, never heading rows or a second table; put README, npm and artifact links in later cells.
- Inventory is the root manifest plus `packages/*/package.json` and any `archive/*/package.json`. Package changes also update the workspace plan and release/registry inventories.

## Common commands

Run from the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run pack:check
node scripts/workspace-run.mjs check --package <dir>
pwsh -NoProfile -File scripts/check-index.ps1 --structural
node --test scripts/check-version-cell.test.mjs scripts/set-version.test.mjs
node scripts/check-docs.mjs --file docs/MAINTAINING.md
git diff --check
```

Direct workspace-runner checks use `--no-cache`; through a package manager set `OC_CHECK_CACHE=0`. Release rehearsal and registry verification commands live in [RELEASE.md](RELEASE.md).

## Check status

`bun run check` is the maintainer gate. `node docs-check.mjs --strict` is the separate phase-1 report-only check: its README version-literal findings conflict with required manifest pins, so record them rather than weakening the index contract. [ADR 0001](../adr/0001-vendor-docs-gate.yaml) owns that decision.

[ARCHITECTURE.md](ARCHITECTURE.md) is a dated generated reference, not the live inventory. [MIGRATIONS.md](MIGRATIONS.md) records package history.
