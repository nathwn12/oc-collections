# Changelog

All notable changes to this package are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-10

### Added

- The plugin, its four atlas readings (counts, path, verbs, freshness) and the
  three request hooks it registers. Injected once per request, 603 characters.
- Hermetic tests: the hook-registration case points `OC_GRAPHIFY_CONFIG` at a
  fixture so it no longer depends on the machine having an atlas record.
