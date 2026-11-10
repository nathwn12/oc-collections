# content-registry

## Outcome

`lib/skills.js` is gone and its two jobs are two modules: `lib/content.js` owns `here`, `packageRoot`, `skillsDir`, `agentsDir`, `commandsDir` and `readSkills()` (directories → the host's `Skill.Info` shape, including the `SOUL.md` → `stacked-soul` case), and `lib/bootstrap.js` owns `MARKER`, the cache and `bootstrap()` with the `<STACKED>` string. `bootstrap.js` imports `content.js` for `skillsDir`; `content.js` imports neither `bootstrap.js` nor anything else in `lib/` except `text.js`. No re-export file was left behind.

Behaviour is unchanged: the same 16 ids in the same order, `bootstrap()` byte-identical to 05fb491 (3511 chars both sides), suite 106/106 → 107/107 where the +1 is exactly the new one-way assertion.

**One Owns gap, disclosed up front.** `lib/tools.js:5` imported `packageRoot` from the deleted file. `Owns` did not list it and `Do not touch` did not forbid it; Out item 3 ("update its importers — `index.js`, `scripts/check.mjs`, and any other file") does authorise it, and without it the plugin cannot load, so every assertion fails. I made that one-line import change and nothing else in that file. If the lead wants the Owns list to be exhaustive, this is the line that should have been on it.

## Evidence

Baseline, before any edit (`git status --porcelain` empty):

```text
$ git rev-parse --short HEAD
05fb491
$ node -e "import('./lib/skills.js').then(m=>console.log('bootstrap len:', m.bootstrap().length))"
bootstrap len: 3511
$ node scripts/check.mjs | tail -3
106/106 passed
```

Red first — the new assertion watched failing, with two deliberate violations in place (`lib/scratch-violation.js` containing `import '../index.js';`, and a temporary `import { bootstrap } from './bootstrap.js';` on `content.js`):

```text
$ node scripts/check.mjs
  FAIL  lib imports the entry nowhere, and the registry never imports the injected text
        a one-way boundary is broken: content.js imports ./bootstrap.js; scratch-violation.js imports the plugin entry (../index.js)
106/107 passed
Failed:
  - lib imports the entry nowhere, and the registry never imports the injected text: ...
```

Both violations removed, then the named check, on the final tree:

```text
$ node scripts/check.mjs
  pass  lib imports the entry nowhere, and the registry never imports the injected text  (7 modules, entry and bootstrap both one-way)
  pass  sixteen skills register  (stacked-soul, stacked, stacked-audit, stacked-debug, stacked-deepen, stacked-employee,
         stacked-lead, stacked-loop, stacked-oftb, stacked-plan, stacked-pls, stacked-review, stacked-ship, stacked-swarm,
         stacked-tdd, stacked-wizard)
  pass  bootstrap is cached, marked, and small  (3511 chars)
107/107 passed
$ node -e "import('./lib/bootstrap.js').then(m=>console.log(m.bootstrap().length))"
3511
```

Before/after `bootstrap().length`: **3511 and 3511**. The count moved 106 → 107 only because the brief ordered one assertion added; no existing assertion was edited.

Byte identity against the pre-change module, captured to a temp file before the split and compared after:

```text
byte-identical to 05fb491: true | old 3511 new 3511
MARKER "<STACKED>"
```

Move-not-rewrite, proved mechanically: the two moved regions of the old file are byte-equal to the new files (EOL normalised to LF for the comparison only):

```text
discovery region identical : true      # old slice "export const here" .. "const MARKER"  vs  lib/content.js
bootstrap region identical : true      # old slice "const MARKER" .. EOF                  vs  lib/bootstrap.js
content has MARKER         : false
```

Symbol surface after the split:

```text
content.js  : agentsDir, commandsDir, here, packageRoot, readSkills, skillsDir
bootstrap.js: MARKER, bootstrap
```

Deletion proved — zero hits outside `.stack/` for the old path:

```text
$ grep (all *.js,*.mjs,*.json,*.md, excluding .stack/, .git/, node_modules/) for "skills\.js"
(no output)
```

Scope of the working tree:

```text
$ git status --porcelain
 M index.js
 D lib/skills.js
 M lib/tools.js
 M scripts/check.mjs
?? lib/bootstrap.js
?? lib/content.js
```

## Unverified

- **Head is not committed.** The lead lands; I did not commit. The suite was run once on the final working tree, not on a committed head, so `check` was not run at a new SHA.
- **The Windows EOL warning.** `git diff` prints `warning: in the working copy of 'index.js', LF will be replaced by CRLF` for the three edited files. The diff itself is CR-free (`git diff | grep \r` → 0 matches) and git normalises to LF in the index, so the landed blob is unaffected; I did not force the worktree back to CRLF.
- **Host behaviour unchanged** is asserted only against this repo's checker and the module surface; I did not load the plugin in a live OpenCode session.
- **`scripts/install.mjs`** ships `lib/` wholesale (`package.json` `files` has `"lib"`), so no installer change was needed; I did not exercise an install.

## Scope

Inside `Owns`: `lib/skills.js` (deleted), `lib/content.js` (new), `lib/bootstrap.js` (new), `index.js` (import split into two lines), `scripts/check.mjs` (import split into two lines + the one new assertion, 24 added / 1 removed).

Outside `Owns`, disclosed above: `lib/tools.js` — one import specifier changed from `./skills.js` to `./content.js`. Nothing else. No edit to `agents/**`, `skills/**`, `commands/**`, `bin/**`, `README.md`, `CHANGELOG.md`, `package.json`, `scripts/install.mjs`, or `.stack/**` outside this report.

The new assertion walks every `.js` under `lib/` recursively and reads `import`/`export ... from` specifiers, plus bare side-effect imports, so it catches the two evasions the brief's wording implies: a pass-through re-export of the entry and a `import '../index.js';` that exists only for its side effect.

## Lesson

The two halves of that file had different dependencies and only the registry's half was being read by `tools.js`; the brief's import list named the two obvious callers and missed the third because a symbol (`packageRoot`) looked like a path constant rather than a registry concern. When splitting a module, grep the *symbols* (`packageRoot`, not `skills.js`) before writing the Owns list — the export names are what find the hidden importer. The one-way assertion is worth more than the split itself: it is now the thing that stops `content.js` from quietly growing a dependency on the text it is supposed to be independent of.
