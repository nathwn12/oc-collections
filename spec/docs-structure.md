# Documentation structure (oc-collections adoption)

This repository vendors the phase-1 docs gate from the local template repository
`docs-template` at source commit `cffb46a6c6f09ca452ffbf04e14c349fa65af814`. That template owns the general placement
rules; this page records only this repository's adoption and cites the template by
name and commit instead of restating or copying it.

## What this repository owns

- The root [README.md](../README.md) is the plugin index and the source of truth for its table.
- The root [AGENTS.md](../AGENTS.md) holds repository policy; package `AGENTS.md` files hold package-local deltas only.
- `docs/` holds migration and release history; each fact lives in one home there.
- Decisions live under `adr/`; the active plan is [.nstack/plan.yaml](../.nstack/plan.yaml).

## Vendored gate files

- [docs-check.mjs](../docs-check.mjs) — the zero-dependency Node checker, version 0.2.0.
- [docs-check.json](../docs-check.json) — this repository's config and checker pin.
- [checker.md](checker.md) — what the gate checks here and its expected report.
- [.github/workflows/docs-report.yml](../.github/workflows/docs-report.yml) — pull-request-only, report-only job using pinned offline lychee.

Phase 1 is report-only. The gate's `forbidden` findings on pre-existing policy files are
listed in [checker.md](checker.md); they are reported, not failed.
