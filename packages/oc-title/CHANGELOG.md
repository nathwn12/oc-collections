# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A closed title is final on every lifecycle event, not only on catch-up: a mapped event can no longer reopen a session the title has already closed. The guard reads the `closed:` prefix, the `oc-title` metadata state and the archived flag, so a bare child title stays closed too.

### Added

- First public release: session titles carry their state as `active:`, `parked:` or `closed:`, with a `oc_title_refresh` tool that rewrites only the scope of a title this plugin already stamped.
