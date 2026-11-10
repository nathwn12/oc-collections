# Report: delegation-duty

## Outcome

The lead seat now states the division as a rule with a test, and the always-on bootstrap carries the one line that makes it bite. Three edits, all in owned paths: `skills/stacked-lead/SKILL.md` gained `## The seat's hard boundary` (MAY/MAY NOT table, four-rung delegation ladder, the dispatch-instead rule, the why); `lib/skills.js` bootstrap gained the exact Autonomy sentence; `README.md` gained one paragraph under the seats table; `CHANGELOG.md` gained one paragraph in the `0.3.0` entry. Out of scope (untouched): `scripts/check.mjs`, owned by a concurrent seam — no change needed there; the 3600-char assert already covers the new line.

## Evidence

`node -e "import('./lib/skills.js').then(m=>console.log(m.bootstrap().length))"` → `3511` (exit 0). Before the edit it printed `3375`; the added sentence cost 136 chars, headroom 89.

`node scripts/check.mjs` → exit 0, `97/97 passed`, including `bootstrap is cached, marked, and small (3511 chars)` and `the stop list is five everywhere, and money is in it (bootstrap 3511 chars, five stops, no "four things")`. Full output pasted in the run: all 97 checks green, no failures, no skips.

Hand verification by grep at the current head:

- `skills/stacked-lead/SKILL.md:168` — `## The seat's hard boundary`; `:170` MAY/MAY NOT table; `:177` delegation ladder, first match wins; `:184` dispatch-instead rule with the `.stack/` exception; `:186` why (writes, then grades its own writing).
- `lib/skills.js:89` — Autonomy paragraph ends with the brief's exact sentence: `The lead writes only .stack/. Every source change is a seam, even a one-line fix. If you are about to open an editor, dispatch instead.`
- `README.md:53` — boundary paragraph under the seats table; skill table rows untouched.
- `CHANGELOG.md:27` — `**The lead holds the boundary by routing.**` paragraph inside the `0.3.0` entry, before `93 checks, all green.`

## Unverified

- That the concurrent seam's in-flight edits to `scripts/check.mjs`, `scripts/install.mjs`, `lib/skills.js` (route table), `README.md` (sixteen/loop), and `CHANGELOG.md` (loop paragraph) merge cleanly with mine. I layered my edits onto their working-tree text without altering it, but the merge itself is the lead's to reconcile, not mine to claim.
- README example outputs and install steps were not re-run; I added prose only, no command changed, so there was nothing new to execute beyond the brief's two commands.

## Scope

Touched (all inside `Owns`): `skills/stacked-lead/SKILL.md` (one section appended after Routing, +20 lines), `lib/skills.js` (three sentences appended to the Autonomy paragraph, same line), `README.md` (one paragraph after the prohibitions line), `CHANGELOG.md` (one paragraph in the `0.3.0` entry). Did not touch `agents/**`, `scripts/check.mjs`, `bin/**`, `package.json`, or any other skill file. No commit made; the tree was already dirty from concurrent work and committing is the lead's landing decision.

## Lesson

Check the tree before assuming it is clean: this seam started on top of another seam's uncommitted edits to three of my four owned files. Reading `git diff` first showed exactly which regions were live, so every edit appended in untouched regions instead of rewriting someone else's sentence. For docs seams sharing files with code seams, append-only placement is the cheapest collision insurance.
