# oc-flight-deck

An OpenCode plugin that renders live session telemetry — agent, model, cost, tokens, cache, context and more — as a panel in the sidebar. It is for anyone running agent sessions who wants the numbers where they are already looking, and it fits the OpenCode plugin ecosystem as a sidebar-panel plugin loaded through the host's plugin array.

## Quick start

To use it, add the plugin name to the `plugins` array in `opencode.jsonc`, restart the OpenCode host, and check that the panel appears beside an open session. See `INSTALL.md` for the npm-only install route and `flight-deck.example.jsonc` for every option.

To work on it, from this package's directory (`packages/oc-flight-deck` in the monorepo; the monorepo root works too with `-w oc-flight-deck`; dependencies come from the root `npm install`):

```sh
bun run check
bun run compile
```

`bun run check` typechecks and runs the suite. `bun run compile` emits the shipped entries to `dist/`.

## Layout

- `index.ts` — package root, re-exports the server entrypoint.
- `src/index.ts` — server-side entrypoint (deliberately inert; visible behavior lives in `src/tui`).
- `src/tui/index.tsx` — sidebar panel entrypoint.
- `src/tui/` — one module per concern (rows, config, stats, formatting, caution, go usage).
- `scripts/build.ts` — compile script behind `bun run compile`.
- `fixtures/` — test suite (`*.test.ts`).
- `flight-deck.example.jsonc` — every option, documented inline; copy to the host config path to configure.
- `flight-deck.schema.json` — types, defaults and allowed values.
- `INSTALL.md` — the npm-only install route.
- `CHANGELOG.md` — release history.
- `../../.github/workflows/check.yml` — the repo's offline checks on pushes and pull requests.
- `../../.github/workflows/release.yml` — the tag-driven publish workflow.
- `assets/` — repo images (icon, signature).

## Conventions

- Commit subjects follow Conventional Commits (`<type>: <subject>`).
- Branches are named `<type>/<slug>`.
- Land only through a pull request, squash-merged, then delete the branch.
- Keep `CHANGELOG.md` and the docs current with every user-visible change.
- `README.md` follows the house README standard (Tier A): house frame, voice, `## Install` first, and the guide rule; the body composes to the artifact.

## Host contract

- Targets the OpenCode host (compatible with opencode 2.1.1) through the official CLI plugin API.
- The host provides the renderer: `@opentui/core`, `@opentui/solid` and `solid-js` are peer dependencies, supplied by the host and never bundled.
- `@opencode/plugin` is a runtime dependency (`^2.2.5`), installed with the package rather than taken from the host: relying on the host to supply it left it absent from the published install, and both entrypoints threw `ERR_MODULE_NOT_FOUND`. `@opentui/core`, `@opentui/solid` and `solid-js` stay optional peers and install correctly. The repo ships the compiled entries in `dist/` that the host actually loads — never raw source.

## Release

- Releases are cut by pushing a tag `<package>@<version>` (e.g. `oc-flight-deck@0.20.2`); the `release` workflow triggers on `**@*`, then builds and publishes to the public registry.
- `scripts/release-target.mjs` enforces the guard: the tag version must equal that package's manifest version and be strictly newer than every published version, and only the three allowlisted packages (bifrost, flight-deck, harness) are releasable. A `v<version>` tag does nothing — it does not match the trigger.
- `dist/` is committed so a clone can inspect the built entries, but the git-install route is gone; npm is the only install route. The `release` workflow rebuilds it (`bun run compile`) before publishing.
- The changelog lives in `CHANGELOG.md` (Keep a Changelog, Semantic Versioning).
- The registry is the only install route; there is no git-install track.

## Guardrails

- Never add an npm script named `install`, `postinstall`, `preinstall`, `build`, `prepare`, or `prepack`: npm runs those automatically on install or publish, and this package has no setup step.
- `dist/` is committed, so rebuild it (`bun run compile`) before any package is published — never publish from a stale or missing `dist/`.
- Keep the docs' publication claims true: if the install, build, or publish story changes, update `README.md`, `INSTALL.md` and this guide together.
- Do not hand-edit `dist/`: it is generated output; change the source and recompile.
