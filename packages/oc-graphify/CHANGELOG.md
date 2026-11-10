# Changelog

All notable changes to this package are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Six read tools over the atlas: graph_stats, graph_node, graph_neighbors, graph_path, graph_god_nodes, graph_query. The injected block named MCP verbs this host does not configure; it now names these. graph_query is label-token search and says so, rather than claiming the CLI's heuristic.

## [0.1.0] - 2026-11-10

### Added

- The plugin, its four atlas readings (counts, path, verbs, freshness) and the
  three request hooks it registers. Injected once per request, 603 characters.
- Hermetic tests: the hook-registration case points `OC_GRAPHIFY_CONFIG` at a
  fixture so it no longer depends on the machine having an atlas record.
