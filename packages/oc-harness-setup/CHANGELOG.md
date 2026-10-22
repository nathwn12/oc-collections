# Changelog

## [0.4.4] - 2026-10-22

- Version bump for the monorepo release; no runtime change.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-10-20

### Changed

- README uses the house centered header, public “agents” wording, and Releases/Issues links; no shipped behavior change.

### Fixed

- Fresh installs from the registry no longer fail the doctor: npm renames a
  shipped root `.gitignore` to `.npmignore` on install, so the pack now ships
  `gitignore.template` and the installer writes it to `.gitignore`. A test now
  packs the tarball, installs it, and runs setup from the installed copy.

## [0.4.2] - 2026-10-20

### Fixed

- Doctor no longer crashes when `opencode.jsonc` has no `permissions` key; the
  dependent laws grade and name the missing block instead of throwing.
- Secret-name law fails only on a literal value: `{env:...}` / `{file:...}`
  pointers are accepted, so a normal provider `apiKey` no longer fails setup.
- Model-routing law accepts the catalog shape the reference documents and names
  both accepted shapes when it cannot derive one.
- Upgrading from an older version drops the retired `oc-flight-deck` plugin entry while keeping every adopter-owned plugin (a same-version re-run keeps one you deliberately re-added); the reference registry is pointed at the
  config dir setup actually resolved.
- Two agent files said "Read `*.env` ..." under Never; they now say "Never read".
- `state/template.md` is pack-owned again (adopter edits archived, not kept), so
  a stale template can never fail the key-order law.
- An edited `state/template.md` is archived before it is replaced, and the install manifest now says so.

### Changed

- Packaging test asserts the tarball ships every path the doctor requires,
  replacing a `npm run check` that could not fail.
- Docs: models catalog shape, close roles, scratch routing, the `.docs/` install
  claim, and eight missing glossary terms.

## [0.4.1] - 2026-10-20

### Fixed

- Explicit Node >=22 startup guard in `bin/cli.js`: older runtimes now
  fail with a clear message instead of a cryptic `import.meta.dirname`
  TypeError.
- Note: `engines` was already `>=22` in 0.4.0; the floor is unchanged
  and `>=18` was rejected because the CLI requires `import.meta.dirname`.

## [0.4.0] - 2026-10-20

### Added

- Starter roster: 9 agents with bounded reach, 6 skills
  with 1:1 commands (`close`, `evolve`, `fast`, `goal`, `search`,
  `swarm`), and 12 references — with no plugin dependency.
- Self-extension: `evolve` turns a repeated workflow, a user
  request, or an upstream feature into a bounded harness
  extension — a skill, command, reference, seat, or config change,
  never a niche one-off.
- Research canon (`reference/canon.md`) with the `search` procedure,
  so load-bearing claims arrive cited or marked `UNVERIFIED`.
- Memory ledger: `historian`-owned session state plus the memory
  rules; `state-seed/` starters seed a fresh install and user state
  survives upgrades.
- Auto-cleaner: `cleaner` with the hygiene rules sweeps scratch at
  pass close.
- `scripts/harness-doctor.ps1` with 18 install-shape laws; every
  setup run ends on the doctor gate.
- `GLOSSARY.md` (starter terms plus `doctor`, `evolve`, and `state-seed`)
  and `CONTRIBUTING.md` (pack maintenance, split out of `AGENTS.md`).
- Test suite runs on plain Node with zero runtime dependencies.

### Changed

- `AGENTS.md` is now the portable starter contract, sanitised of
  owner-local paths, names, and model pins.
- `README.md` rewritten for the 0.4.0 install story; the documented
  install commands stay version-free.
- Base config: `default_agent` orchestrator, the 6-skill allowlist, hard
  policies kept last, no plugin dependency, and no model pins.

### Removed

- 0.3.x orchestrator roster, 20-skill library, 14 commands, and the
  git-ceremony/testflight/logbook/pirep scripts; upgrading from
  0.3.x retires unmodified 0.3.x files.
- The plugin dependency and model pins: cost guidance is cheap-tier
  fan-out versus the expensive verdict seat, with no named models
  anywhere.

### Fixed

- Upgrades preserve the user's settings and state dir; only
  unmodified pack files are retired, and user-modified files are
  archived under `state/archive/legacy-0.3.x/` and reported.

## [0.3.3] - 2026-10-16

### Changed

- House brand shape pass: README header icon 120, CI template byte-exact
  to the kit.
- Base config ships with formatting off (object formatter value silently
  rewrites authored bytes; formatters stay manual).
- Removed dead CI badge from README (GitHub Actions stopped estate-wide).

## [0.3.2] - 2026-10-11

The published `0.3.1` tarball on npm is immutable and was built from a
revision whose history carried the author's local path (`bin/cli.js`).
This patch release re-ships from the purged history so the registry
carries a clean artifact, plus the fixes below.

### Added

- House `assets/icon.svg` and `assets/signature.svg`.
- `CHANGELOG.md` (Keep a Changelog) and the house `LICENSE` wording.

### Changed

- House CI shape on `.github/workflows/ci.yml`; the real gates
  (`bun test`, `npm run check`) are unchanged.
- Rebuilt `README.md` on the house skeleton; dropped a stale licence
  word from the house footer.

### Fixed

- Installer (`bin/cli.js`): validate every JSONC input before the first
  write; honour `--dry-run` / `--ci` print-only before preflight and in
  `setup --uninstall`; replace files atomically; sweep installer crash
  litter; resolve `OPENCODE_CONFIG_DIR` to an absolute path.
- Removed author machine details from lint comments in `bin/cli.js`.
