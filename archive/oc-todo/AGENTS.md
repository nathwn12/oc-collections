# oc-todo

An OpenCode plugin that gives every session its own durable todo list. It is for anyone who drives multi-step work through the OpenCode host — human or agent. In the plugin ecosystem it plays the per-session memory role: a `todo` tool the agent calls to track steps, backed by real plugin storage, with a read-only sidebar checklist and a `/show-todos` inspector panel for one item's full detail.

## Quick start

This repository is end-of-life; do not install it. See `EOL.md` for the migration to the built-in `todowrite`.

To work on it (prerequisites: Node or Bun — see `README.md` for the minimums):

```sh
git clone https://github.com/nathwn12/oc-todo.git
cd oc-todo
bun install
bun run check
```

`bun run check` runs the test suite plus `tsc --noEmit`. `bun test` runs the suite alone. `prepublishOnly` runs the same check before publish, so a broken type or test can never be published.

## Layout

- `index.ts` — server plugin: the `todo` tool, the per-session store, the `todo.list` RPC.
- `tui.tsx` — interface plugin: the read-only sidebar checklist and the `/show-todos` inspector panel.
- `contract.ts` — shared, dependency-free RPC contract between the server plugin and the interface plugin.
- `test/unit.test.ts` — unit tests for mutations, formatting, and the panel's pure renderers.
- `docs/specs/` — dated spec documents, one per shipped slice (`v0.2.0.md`, `v0.5.0.md`).
- `README.md` — what the plugin is, the install pins, usage, and pointers to the rest of the docs.
- `INSTALL.md` — the three install routes with their measured results.
- `ROADMAP.md` — shipped tiers, saved items, and what is explicitly not being built.
- `CHANGELOG.md` — release history, newest first.
- `package.json` — scripts, entries, dependencies, and peers.
- `.github/workflows/` — `check.yml` (tests plus types on push and pull requests), `ci.yml`, `release.yml` (publish on tag).
- `assets/` — icon and signature artwork used by the README.

## Conventions

- Commit subjects follow the conventional pattern (`feat:`, `fix:`, `docs:`, `chore:`, with optional scopes).
- Branches are named `<type>/<slug>` (for example `docs/repo-guide`), matching the commit type.
- Land only through a pull request, squash-merge it, and delete the branch afterwards.
- Keep `CHANGELOG.md`, `ROADMAP.md`, and the docs current with every user-facing change.
- Spec documents live under `docs/specs/` and are dated artifacts, not living docs: record a new slice in a new file, never by revising a shipped one.

## Host contract

- Targets OpenCode V2.
- Uses the plugin API for a `todo` tool, a `todo.list` RPC, and `session.panel` for the `/show-todos` inspector.
- The OpenCode host provides the plugin runtime, the per-session SQLite plugin store, and the sidebar/panel slots. The `@opentui/core`, `@opentui/solid`, and `solid-js` packages are peers supplied by the host.
- The repo ships its own dependency on the plugin package (`@opencode/plugin`), pinned as `package.json` states it, plus the three TypeScript sources that are its entries: the root entry resolves to `index.ts`, `./tui` to `tui.tsx`, and `./contract` to `contract.ts`. There is no build step — the host loads the sources directly.

## Release

- Releases are cut by pushing an annotated tag named `v<version>`.
- This repo's rule: the release workflow fails unless the tag equals the `package.json` version, so bump the version and document the change first, then tag.
- The changelog lives in `CHANGELOG.md` at the repo root; the published files are listed under `files` in `package.json`.

## Guardrails

- Never add an npm script named `install`, `postinstall`, `preinstall`, `build`, `prepare`, or `prepack` — npm runs those names automatically on install or publish, and this repo deliberately ships TypeScript sources with no build step.
- Keep every install pin in `README.md` and `INSTALL.md` in step with the released version — those pins are what users copy, and a stale pin installs the wrong release.
- Do not rewrite dated spec documents under `docs/specs/` — they are the frozen record of what a slice shipped; a correction or a new slice gets a new dated note, not an edit to history.
- Keep the inspector panel's pure renderers (`listRows`, `metadataLines`, `proseLines`, `wrapText`, `formatStamp`, `resolveSelection`, and the selection/column math) free of host calls — their purity is what lets `bun test` cover the panel without a live host.
