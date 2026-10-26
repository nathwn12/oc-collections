# Changelog

## [Unreleased]

### Changed

- `--bootstrap` now follows upstream instead of a shim version table: it reads the accepted Ghidra release line from the exact `rea-agents` release it installs, selects the latest official NSA Ghidra release in that line, and takes the archive SHA-256 from official GitHub release data. Missing policy, artifact or published hash fails the run; there is no fallback to an older shim pin.
- The JDK minimum is read from the installed Ghidra's `application.properties`, not a shim constant. Bootstrap installs the latest official Eclipse Temurin x64 Windows JDK for that minimum and verifies the checksum published by the Adoptium API.
- The `--ghidra <version>` override is gone. Installing an upstream-unsupported line is not a feature; update upstream instead.
- Bootstrap installs one exact, immutable `rea-agents` release into its own prefix and runs all three upstream checks against that same version. No dist-tag is accepted for bootstrap.
- `engines` now matches the current upstream `rea-agents` Node range.
- This supersedes the earlier unreleased pinned-pair design in the working tree.

### Fixed

- Archive extraction refuses traversal, absolute paths, NTFS streams, reserved names, links, devices and other non-regular entries, and checks existing ancestors and the extracted tree for symlinks, junctions and reparse points.
- A download never overwrites or deletes a pre-existing destination; only a file this run created is cleaned up on failure. A mismatched cache entry is reported and preserved.
- The Ghidra provider gate requires the observed provider version and every Ghidra provider check, but no longer fails on unrelated skill or registration setup checks.
- The MCP gate requires the observed upstream package and server version; the analysis gate requires the observed Ghidra provider version. Neither is optional.
- `--doctor` remains read-only and never creates the bootstrap root.

### Verification

- Added an offline contract suite (`test/bootstrap.test.js`) covering official-release selection, hash extraction, archive safety, installer refusal paths, exact-version gates and the read-only CLI. It uses fixtures and injected runners; it does not download anything or start a real engine.
- Runtime acceptance remains a clean Windows Sandbox run with no Java or Ghidra installed; the recipe is in `docs/GUIDE.md`. This entry does not claim that run has been performed.

## [0.1.4] - 2026-10-23

- Pipeline-verification patch; no functional change.

## [0.1.3] - 2026-10-23

- Corrected `docs/PUBLISHING.md`: the release lane has executed four times, one package per run, all four publishing over OIDC with provenance. The only unproven step is the post-publish registry verify. No code change.

## [0.1.2] - 2026-10-22

- Version bump for the monorepo release; no runtime change.
- The pinned example now matches the manifest.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-21

### Fixed

- README/npm-page patch.

## [0.1.0] - 2026-10-18

### Added

- Initial `rea-shim` launcher: resolve JDK 21+ and Ghidra, then serve upstream `rea-agents --mcp` over stdio.
