# Contributing to oc-harness-setup

The shipped `AGENTS.md` is the starter contract. This file is pack
maintenance: how the installer, the shipped content, and the release
process fit together. Users never need this file; maintainers always do.

## Quick start

Work on this package (no build step; pure Node ESM, stdlib only). In the monorepo, from the repo root:

```bash
npm install
npm test -w oc-harness-setup
npm run check -w oc-harness-setup
```

## Layout

- `bin/` — the installer entry point (`cli.js`); the product's front door.
- `agents/` — the agent definitions the installer ships.
- `commands/` — the explicit rituals the installer ships.
- `skills/` — the reusable procedures the installer ships.
- `reference/` — the supporting material the installer ships.
- `scripts/` — the Node helpers the installer ships, ending in the harness doctor gate (`harness-doctor.mjs`).
- `state-seed/` — the starter state the installer lays down; live session state is never shipped.
- `.docs/` — supplementary notes installed into the host config (the doctor reads the unwired-routing record there).
- `AGENTS.md` — the shipped starter contract; edits here are consumer-facing documentation.
- `opencode.jsonc` — the base configuration merged into the user's config at install time.
- `package.json` — package manifest, `files` list, and the `test` / `check` scripts.
- `README.md` — the user-facing install story.
- `CHANGELOG.md` — the Keep a Changelog record.
- `.github/workflows/` — continuous checks and the tag-driven publish workflow.

## Conventions

- Write conventional commit subjects (e.g. `docs: ...`, `chore: ...`).
- Branch as `<type>/<slug>` (e.g. `docs/repo-guide-shape`).
- Land only through a pull request; squash-merge it, then delete the branch.
- Keep `CHANGELOG.md` and the docs current with every user-visible change.
- The installed agent, command, skill, and reference files are the product, so treat edits to them as content changes — review the words, not just the code.
- Commands stay 1:1 with skills: never ship one without the other.

## Host contract

- Targets the OpenCode host on Windows 10/11 only (macOS and Linux are not supported): the only host requirement is that the host CLI is runnable when `setup` runs (preflight refuses otherwise). Requires Node >= 22; the doctor gate is Node ESM like the rest of the package and adds no requirement of its own.
- `setup` lays down exactly the shipped content — `agents/`, `commands/`, `skills/`, `reference/`, `scripts/`, `.docs/`, plus `AGENTS.md` — into the host config location, lays `state-seed/` down as `state/`, and merges the base configuration into the user's config file. The destination is resolved through the host itself first, then an environment override, then platform fallbacks; it is never an invented path.
- The install is consent-first and idempotent: the full manifest prints before anything moves, and re-runs skip identical files. Existing settings and existing state survive the merge; runtime policy is owned by the pack. Every run ends on the harness doctor, and a SHA-256 journal records every touched file.
- Upgrading from 0.3.x retires unmodified 0.3.x files so the old roster, old skills, and old scripts never sit beside the new ones. Files the user modified after install are kept.
- `--dry-run` guarantees nothing is touched: it prints the manifest (or, with `--uninstall`, the removal preview) and exits before any write.
- `--uninstall` removes exactly the manifest-listed files, restores overwritten files from backup, keeps files the user modified after install, and never deletes the merged config file — it restores the user's original instead.

## Release

- Releases are cut by pushing a tag `<package>@<version>` (e.g. `oc-harness-setup@0.4.4`); the `release` workflow triggers on `**@*`, requires the tag version to equal `package.json` and be strictly newer than every published version, and publishes npm over OIDC. Only the four allowlisted packages are releasable; a `v<version>` tag does nothing.
- Keep ONE GitHub release per repo, pinned to the current version. Update that release entry (tag, title, notes, assets) in place on each release; do not accumulate a release per version.
- The tag history remains, and npm versions are immutable; `@latest` is the moving install pointer.
- The changelog lives in `CHANGELOG.md`.
- The documented install commands are deliberately version-free, so the README never needs a version bump.

## Guardrails

- Never add an npm script named `install`, `postinstall`, `preinstall`, `build`, `prepare`, or `prepack` — installation must never modify config by itself; setup is always an explicit command, never a side effect.
- Keep `package.json`'s `files` list and the installer's expectations in step, so a published package can never reference a file it does not ship.
- Never write outside the target OpenCode config location — the installer owns one destination and must not scatter files elsewhere.
- Keep `--dry-run` output truthful about what a real run would touch — the preview is the consent gate, so a lying preview voids consent.
