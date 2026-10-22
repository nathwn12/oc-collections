# Changelog

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
