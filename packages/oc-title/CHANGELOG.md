# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A manual rename survives lifecycle writes: once a title is stamped, a body that is no longer lowercase is an owner edit and is left alone, while a first-time stamp is still normalized.
- A closed title is final on every lifecycle event, not only on catch-up: a mapped event can no longer reopen a session the title has already closed. The guard reads the `closed:` prefix, the `oc-title` metadata state and the archived flag, so a bare child title stays closed too.

### Added

- First public release: session titles carry their state as `active:`, `parked:` or `closed:`, with a `oc_title_refresh` tool that rewrites only the scope of a title this plugin already stamped.

### Roadmap

- Auto-refresh stale scope on compaction or a turn threshold: the trigger and scope policy need a decision before any code changes.
- Derive refresh scope from a session note or summary for synthetic sessions: the row shape is not defined; an explicit `scope` is the escape hatch today.
