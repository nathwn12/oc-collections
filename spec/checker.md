# Checker contract (oc-collections adoption)

This repository vendors the phase-1 checker from the local template repository
`docs-template` at source commit `cffb46a6c6f09ca452ffbf04e14c349fa65af814`. The implementation and the full contract
are [docs-check.mjs](../docs-check.mjs) and the template's own specification; this page
records this repository's configuration and its expected report.

## What runs

`node docs-check.mjs --report` is the phase-1 gate: it runs `forbidden`, `versions`,
`generated` and `checker`, and exits 0 even when it prints findings. `--strict` exits 1
when there is any finding and is not the phase-1 gate in this repository. Link checking
is a separate pinned offline `lychee` action in
[.github/workflows/docs-report.yml](../.github/workflows/docs-report.yml), not part of the Node tool.

Config: [docs-check.json](../docs-check.json) pins version 0.2.0 and checker SHA-256
`92f3f8bea1ff89497fb911ca57a6bf218ab3824ff34f8de3717f6a6a6d7a4546`;
`node docs-check.mjs --print-hash` prints the hash of the script actually running.

## Expected report-only findings

The real report prints six findings, all `forbidden` facts that predated adoption.
None fails the phase-1 report job:

- [AGENTS.md](../AGENTS.md):82 — published release-version strings in the release history.
- packages/oc-bifrost/AGENTS.md:31 and :81 — route-floor and peer-history versions sourced from that package's `INSTALL.md`.
- packages/oc-flight-deck/AGENTS.md:9, :44 and :46 — install-command phrasing and host-version facts.

These policy files are preserved byte-for-byte by this adoption. Relocating those facts was
not a straightforward docs-only move: the root file is this repository's active policy
surface, and the package files are package-owned policy with their own installation
sources. Changing them would exceed this seam; the findings stay report-only and are
recorded here rather than suppressed. See [docs-structure.md](docs-structure.md) for where
the gate's files live.
