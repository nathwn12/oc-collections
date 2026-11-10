# content-registry

## Out

`lib/skills.js` is two modules wearing one coat, and it becomes two real ones. No pass-through: the old file is deleted, not left re-exporting.

**Why it is two.** Discovery answers "what content exists on disk"; bootstrap answers "what text is injected into every session". They change for different reasons - one when the content layout moves, the other when the doctrine moves - and the 16-registration assertion tests the first while the char-budget assertion tests the second.

1. **`lib/content.js`** - the registry. Owns `packageRoot`, `skillsDir`, `agentsDir`, `commandsDir`, `here`, and `readSkills()`. Its job: turn directories into the host's `Skill.Info` shape, including the `SOUL.md` -> `stacked-soul` special case. Nothing about prompts.
2. **`lib/bootstrap.js`** - the injected text. Owns `MARKER`, `bootstrap()`, the cache, and the `<STACKED>` string. It may import `content.js` (to check that the content exists before building); `content.js` must never import it.
3. **`lib/skills.js` is deleted.** Update its importers - `index.js`, `scripts/check.mjs`, and any other file - to import each symbol from the module that now owns it. A re-export file is a pass-through and fails the deletion test.
4. **Add the one-way assertion** to `scripts/check.mjs`: no file under `lib/` imports the plugin entry (`../index.js` / `./index.js`), and `lib/content.js` does not import `lib/bootstrap.js`. Walk the directory and assert on the import lines.

Do not change behaviour: same registered ids, same order, same bootstrap bytes. This is a move, not a rewrite. `bootstrap().length` must be identical before and after - paste both numbers.

## Check

```text
node scripts/check.mjs
node -e "import('./lib/bootstrap.js').then(m=>console.log(m.bootstrap().length))"
```

First exits 0, with the new one-way assertion named. Second prints the same number `bootstrap()` printed before the change (3511 at the time of writing - verify it yourself before editing, do not trust this number).

Then prove the move: `grep` for `lib/skills.js` across the repo and show zero hits outside `.stack/` reports.

## Owns

`lib/skills.js` (delete), `lib/content.js` (new), `lib/bootstrap.js` (new), `index.js`, `scripts/check.mjs` (import lines plus the one new assertion only)

## Do not touch

`agents/**`, `skills/**`, `commands/**`, `bin/**`, `README.md`, `CHANGELOG.md`, `package.json`, `scripts/install.mjs`, `.stack/**` outside your report.

## Read first

- `lib/skills.js` in full (97 lines or so - read all of it before cutting)
- `index.js` lines 1-20 and wherever `readSkills`/`bootstrap`/`MARKER` are used
- `scripts/check.mjs` around its import block and the bootstrap assertion

## Tier

Refactor. Zero behaviour change. If the check suite goes from green to green with the same count, you did it right; if the count moved, you changed something you were told to move.
