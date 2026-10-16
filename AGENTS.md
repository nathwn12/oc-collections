# oc-collections

A curated index of the family's OpenCode plugins: one front door listing every plugin, installer, and bridge in the set, with its repo, its npm package, and its link. It is for OpenCode users discovering what to install, and for contributors keeping that list honest. Install the listed plugins, not this repo.

## Quick start

Use it: read the plugin table in `README.md` and follow a repo or npm link to the plugin you want.

Check it: run the repo's one check from the repo root:

```powershell
pwsh -NoProfile -File scripts/check-index.ps1
```

It exits `0` only when every link resolves and every pinned version is published.

## Layout

- `README.md` — the index table and the captured check-output block; the table is the source of truth.
- `CHANGELOG.md` — index history; earlier implementation history was removed with the implementation.
- `LICENSE` — license text.
- `scripts/check-index.ps1` — the one executable check; verifies every index link.
- `.github/workflows/check.yml` — verifies required files exist, the tree holds no implementation files, and no internal vocabulary leaks into the tracked tree.
- `.github/workflows/ci.yml` — verifies the index files are present.
- `assets/icon.svg` — repo icon.
- `assets/signature.svg` — shared footer signature.
- `.gitattributes` — line-ending and export settings.
- `.gitignore` — local ignore rules.

## Conventions

- Write conventional commit subjects (for example `docs: ...`, `chore: ...`).
- Branch as `<type>/<slug>` (for example `docs/repo-guide`).
- Land only through a pull request, squash-merge it, then delete the branch.
- Keep `CHANGELOG.md` and the docs current with every index change.
- A new index row keeps the existing column order: repo, one-line description, npm package and version, links.

## What the index guarantees

The table promises that every repo link reaches a live repository, every npm link names a package present on the registry, and every pinned version is actually published. `scripts/check-index.ps1` proves it: it reads each table row from `README.md`, checks the repo URL over HTTP, resolves the npm package through the registry API (the canonical source, since the storefront blocks non-browser clients), and confirms the pinned version appears in the published version list. The captured block in `README.md` is the output of that script rather than prose — regenerate it by running the script and pasting its real output.

## Release

This repo has no package and publishes nothing; a release is an annotated tag `v<version>` recording a state of the index. It marks which set of index rows was current, not a version of installable code.

## Guardrails

- Never hand-edit the captured check-output block — it must be the script's real output, so run `scripts/check-index.ps1` and paste what it printed; anything else silently falsifies the guarantee.
- Never leave an index row pointing at a version that is not published — the table promises every pin is installable, and the check fails otherwise.
- Never add an npm script named `install`, `postinstall`, `preinstall`, `build`, `prepare`, or `prepack` — lifecycle scripts would turn a read-only index into something that executes on install.
- Do not add a package manifest to this repo — it is an index by design, and a manifest would invite installs, builds, and publishes that must not exist here.
