# Changelog

## [Unreleased]

## [0.6.0] - 2026-10-29

### Added

- The custom end-to-end looper ships as `/loop` (`commands/loop.md` +
  `skills/loop/SKILL.md`) instead of `/goal`. OpenCode 2.2.1 ships a
  first-party `/goal` session-continuation command
  (`Usage: /goal <objective> | pause | resume | clear`), so a custom
  `commands/goal.md` collided with it. A fresh install writes no `/goal` —
  the pack ships neither file — and its `skill` allow names `loop`. The
  command and skill bodies name the native built-in so the distinction is
  explicit.

### Changed

Upgrades decide per prior-manifest entry, not per file name (`bin/cli.js`
`retireStale`; the allow prune lives in `mergeJsonc`):

| Prior-manifest entry | Path kind | Hash vs disk | Action | Adds a skill ID |
| --- | --- | --- | --- | --- |
| absent — fresh install, no `/goal` on disk | any | — | nothing selected; nothing removed | no |
| absent — installed tree with no prior manifest | any | — | nothing selected; any `/goal` file on disk is untouched | no |
| present; this version still ships the same path | any | — | not stale; the sweep ignores it | no |
| present with `action: merged` | `opencode.jsonc` | — | ignored | no |
| present, already `retired`/`archived` by an earlier run | `skills/<id>/...` | — | not re-examined; the earlier outcome stands | yes — `<id>` |
| present, already `retired`/`archived` by an earlier run | other | — | not re-examined | no |
| present, path absent from disk | `skills/<id>/...` | — | nothing to retire | yes — `<id>` |
| present, path absent from disk | other | — | nothing to retire | no |
| present, path is not a regular file | any | — | kept (refused) | no |
| present, path unreadable | any | — | kept (refused) | no |
| present, path escapes the config dir | any | — | skipped (refused) | no |
| present, regular file | `skills/<id>/...` | matches | deleted, journaled `retired` | yes — `<id>` |
| present, regular file | `skills/<id>/...` | differs | moved under `state/archive/legacy-0.3.x/`, journaled `archived` | yes — `<id>` |
| present, regular file | `skills/<id>/...` | not recorded | kept; the adopter owns the bytes | no |
| present, regular file | `commands/goal.md` or other | matches | deleted, journaled `retired` | no |
| present, regular file | `commands/goal.md` or other | differs | moved under `state/archive/legacy-0.3.x/`, journaled `archived` | no |
| present, regular file | `commands/goal.md` or other | not recorded | kept; the adopter owns the bytes | no |

Only a `skills/<id>/...` path (three or more segments, first segment
`skills`) can contribute `<id>`, and only where its row above says yes —
a kept file with no recorded hash does not; `commands/goal.md` and a bare
`skills/goal` never do. A row that adds no skill ID therefore never prunes
an allow, while an earlier run's retired or archived entry keeps
contributing its skill on every later run.

The merge applies the run's final set (`retiredSkills`) to the adopter's
own rules:

| `retiredSkills` | Adopter rule naming `goal` | Prune result |
| --- | --- | --- |
| contains `goal` | `{"action": "skill", "resource": "goal", "effect": "allow"}` | dropped from the merged config and logged |
| contains `goal` | a `goal` rule with any other effect, or a `skill *` rule | not eligible for the prune |
| does not contain `goal` | any | kept |

So a concrete `goal` allow is pruned if and only if a `skills/goal/...`
entry put `goal` in the run's final retired-skill set; retiring or
archiving only `commands/goal.md` leaves the allow alone, and a `goal`
allow with no supporting manifest entry survives as adopter-owned.
Unknown files are preserved throughout: anything the manifest does not
list, any entry with no recorded hash, and any refused entry stay on disk.
An emptied `skills/goal/` directory is pruned once its last file leaves,
while a `/goal` file the manifest never listed is not removed by this
upgrade. Rules identical to a shipped harness rule are deduped by the
permissions union on any run; that is separate from the prune.

## [0.5.0] - 2026-10-28

### Fixed

- `plugins[]` entries are emitted in the OpenCode 2.2.0 shape: a specifier
  string. A 1.x `[specifier, options]` tuple is reduced to its specifier and
  reported (2.2.0 drops a tuple entry outright, so the plugin silently stopped
  loading), a non-string entry is reported instead of written, and the union
  dedupes on strings so a re-run is byte-identical. The retired distro-plugin
  match no longer assumes an unscoped `name@version` specifier.
- Config shapes are proven against the installed host rather than assumed:
  new `test/host-schema.test.js` round-trips the shipped config and a real
  merged config through `opencode debug config` and fails if the host drops any
  key, while the hermetic suite pins `plugins` strings, `permissions[]` rules,
  `policies[]` with `tool.use`, and the absence of 1.x singular keys.
- Preflight reads the `opencode v2.2.0` banner instead of echoing it (the log
  line printed the product name twice), refuses a 1.x host before writing
  anything (different config dialect), warns on a 2.0/2.1 host that the
  `permissions[]`/`policies[]` deny gate is unproven there, and records the
  host version in the install manifest. Compatibility truth: 2.2.0 tested;
  2.x warned; 1.x refused.

## [0.4.5] - 2026-10-23

- npm front door split into a short `README.md`; full documentation moved to `docs/GUIDE.md`; no functional change.

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
