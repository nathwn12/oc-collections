# Changelog

All notable changes to this package are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Six read tools over the atlas: graph_stats, graph_node, graph_neighbors, graph_path, graph_god_nodes, graph_query. The injected block named MCP verbs this host does not configure; it now names these. graph_query is label-token search and says so, rather than claiming the CLI's heuristic.

### Fixed

- The freshness probe no longer spawns the compiled host binary. `process.execPath` is `opencode.exe` inside the Bun host, so the old call started a second OpenCode, which died with `ENOTDIR` and left a dead Windows Terminal pane. The probe now resolves `bun`/`node` (or `OC_GRAPHIFY_RUNTIME`), refuses any non-JS executable, and passes `windowsHide: true`. The same flag was added to the `git` HEAD probe.
- The freshness verdict is the vault's, not the plugin's: `graph-freshness.mjs` decides (corpus inputs, lesson-bearing session notes, the semantic seed, a dirty tree), and commit equality is only the fallback when that tool is absent. The plugin had been calling a fresh graph STALE on every non-corpus commit.
- `setup()` registers six reads again. `graphFile` had been dropped from the import, the registration threw, the outer catch swallowed it, and the six tools vanished from a running host with no error. Two tests now hold the line: setup registers six reads and still hooks when the tool editor refuses; a freshness command that exits 127 is not a verdict.
- `graph.js` and `tools.js` ship in the tarball. `files` had listed only `index.js` and `lib.js` while `index.js` imported both, so `npm pack` produced a module that died on its first import.

## [0.1.0] - 2026-11-10

### Added

- The plugin, its four atlas readings (counts, path, verbs, freshness) and the
  three request hooks it registers. Injected once per request, 603 characters.
- Hermetic tests: the hook-registration case points `OC_GRAPHIFY_CONFIG` at a
  fixture so it no longer depends on the machine having an atlas record.
