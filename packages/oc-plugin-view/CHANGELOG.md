# Changelog

## [Unreleased]

- Failed plugins now sort before active ones in the sidebar, keeping alphabetical order inside each group.
- Server entry ids now render as their plugin name: the sidebar label strips one trailing `.host` segment (`flight-deck.host` reads as `flight-deck`), while the `source.target`/`path` fallbacks and the self-exclusion are unchanged.

## [0.1.0] - 2026-11-03

- Clicking the Plugins header now collapses and expands the section again: the sidebar no longer imports `solid-js` control-flow components, so the host's own render tracks the persisted `view.open` state instead of a second Solid instance. `bun run compile` now fails if the bundle imports `solid-js` or `solid-js/store`.
- Add a no-op server entry (`oc-plugin-view.host`) and expose the package root, so listing it in `opencode.jsonc` before other sidebar TUI plugins puts the Plugins section in the intended order.
- Add the Plugins sidebar section for installed and loaded server plugins.
