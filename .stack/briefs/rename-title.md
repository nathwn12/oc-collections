# rename-title

## Out

The user-facing name reads `oc-flight-deck` instead of `Flight Deck`, everywhere it is compile-time, with the built `dist/` regenerated and committed.

Four strings, all confirmed in source:

1. `packages/oc-flight-deck/src/tui/index.tsx:66`, `:143`, `:385` - `title: "Flight Deck"` -> `title: "oc-flight-deck"`.
2. `packages/oc-flight-deck/src/tui/config.ts:512` - `export const DEFAULT_FOOTER_TEXT = "Flight Deck"` -> `"oc-flight-deck"`. Leave the `footer.text` config override working exactly as it does now; only the default changes.

Then regenerate the build the way the package expects:

```bash
cd packages/oc-flight-deck
bun run compile          # scripts/build.ts
git diff --exit-code -- dist   # must be the only diff, and it must be zero after staging
```

`dist/` is committed and `check:dist` asserts it matches source, so an uncommitted dist is a broken release. Do not hand-edit `dist/`; regenerate it.

## Explicitly out of scope

- **The plugin id** `flight-deck-tui` stays. It keys persisted state (`flight-deck.guard`, `flight-deck.go`, `flight-deck.frame`) and is not what the user sees.
- **The npm package name** is already `oc-flight-deck`; nothing to do.
- **The config file path** `~/.config/opencode/flight-deck.jsonc` stays. Renaming it silently orphans every user's tuning file.
- Comments and prose in source that say "Flight Deck" as a sentence (docs, headers) stay; this is a display-name change, not a copy rewrite. If a comment would now be misleading, change the minimum words.

## Check

```bash
cd packages/oc-flight-deck
bun run check        # typecheck + test
bun run compile
git diff --exit-code -- dist
```

All three exit 0. Then grep the built output and paste the hits:

```bash
grep -rn "Flight Deck" dist/ | head
```

Expected: only strings you deliberately left (none of the four above). Paste the final `node -e`/grep evidence, not a summary.

## Owns

`packages/oc-flight-deck/src/tui/index.tsx`, `packages/oc-flight-deck/src/tui/config.ts`, `packages/oc-flight-deck/dist/**`, and `packages/oc-flight-deck/CHANGELOG.md` (one entry, if the repo's convention requires one before publish).

## Do not touch

Every other package in the monorepo, `package.json` version (the owner decides the release), the plugin id, the config path, and anything outside `packages/oc-flight-deck`. Do not commit or publish.

## Read first

- `packages/oc-flight-deck/src/tui/index.tsx` around the three `title:` lines - confirm each is a display surface and not a lookup key.
- `packages/oc-flight-deck/src/tui/config.ts:205-215` and `:505-530` - the footer text contract.
- `packages/oc-flight-deck/CHANGELOG.md` for the entry style.

## Tier

Implementation. Small and mechanical, but the build must be regenerated, not skipped.
