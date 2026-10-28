# Changelog

## [Unreleased]

## [0.2.1] - 2026-10-28

### Added

- `npm test` and `npm run check`. The suite existed but nothing ran it: `test/bootstrap.test.js` was orphaned (no `scripts` block), so 57 contract tests were unreachable from the package. `check` syntax-checks every `bin/*.js` and `lib/*.js`, and a test asserts that coverage so a new source file cannot be left out.
- `test/handshake.test.js`: a spawned-binary handshake. A stub `npx` first on `PATH` stands in for upstream, and the real launcher is driven through `initialize` and `tools/list`. It asserts that stdout carries only JSON-RPC frames (one per line), that upstream receives the frames byte-identically, that the child exit code is forwarded, and that a refusal writes nothing to stdout.

### Fixed

- `--print-config` printed a flat `"rea": { ... }` entry with a `timeout` key. OpenCode 2.2.0 reads MCP servers at `mcp.servers.<name>` and writes `{ type, command }` itself; the printed block omitted the `servers` level and promised a startup timeout the client does not write or honour. It now prints the 2.2.0 shape, generated with `JSON.stringify` so it is always valid JSON. `docs/GUIDE.md` showed the older `mcpServers` shape for the same block and is corrected.

## [0.2.0] - 2026-10-26

### Added

- `--bootstrap`: one explicit command takes a clean Windows x64 machine with no Java and no Ghidra to a checked upstream setup. It installs one exact `rea-agents` release, the official NSA Ghidra release that release accepts, and the Eclipse Temurin JDK that Ghidra requires, then runs the upstream doctor, MCP inventory, and a Ghidra analysis against that same set. The Ghidra archive and JDK are checked against the checksums published with their official releases.
- The bootstrap follows upstream release data rather than a shim version table: the Ghidra line comes from the exact `rea-agents` release, the JDK minimum comes from that Ghidra's `application.properties`, and the Node range matches the current upstream release.

### Fixed

- Windows short paths and path aliases are accepted: a DOS 8.3 name, a different letter case, or a substituted drive is treated as the directory it names, not refused as a reparse point. Real links, junctions, and other redirections are still refused.
- Archive extraction refuses traversal, absolute paths, NTFS alternate data streams, reserved names, links, and other non-regular entries. A download never overwrites an existing file, and a mismatched cache entry is reported and kept.

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
