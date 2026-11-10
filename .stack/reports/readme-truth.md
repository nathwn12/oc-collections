# readme-truth

## Outcome

The README now describes the product that exists: three seats with no CEO, seven tools including `clean`, thirteen skills matching `skills/`, the model policy (lead inherits, employee and auditor pinned), a three-row glossary, and a close ceremony of `clean` sweep, `clean` report, digest refresh, and one lesson. Four claims changed: two "the owner is the CEO" sentences removed, "four agents" corrected to three, and a "Closing a pass" subsection added under the loop. Nothing else in the README was rewritten; the tool count, the skills table, the model table, and the glossary were already true and were left alone.

## Evidence

A claim-checking script written for this seam, at `C:\Users\nathan\AppData\Local\Temp\opencode\readme-truth-check.mjs` (outside the repo: `scripts/` is not mine). It reads the README and compares it with `agents/`, `skills/` + `SOUL.md`, and `toolDefinitions()` from `lib/tools.js`. Run before the edit, it went red for the three stale claims:

```text
readme-truth: claims against the filesystem

  FAIL  no CEO seat is named anywhere in the README
        README still names a CEO: A three-rung agent stack for OpenCode: **one lead, a fresh employee per seam, and an auditor that wrote none of it.** The owner is the CEO. | The owner is the CEO. The lead decides everything reversible and asks only for the five stops.
  pass  the seat table names exactly the agents on disk  (auditor, employee, lead)
  FAIL  the seat count in prose matches agents/
        the README still says "four agents"
  pass  the tool count and every tool name match lib/tools.js  (7: brief, check, clean, ledger, ready, scope, swarm)
  pass  the skills table and the registry are the same set  (13 ids agree)
  pass  the README states the skill count it lists  (13)
  pass  stacked-soul is described as registered from SOUL.md  (SOUL.md is the one copy)
  pass  the model policy matches the agent files  (lead inherits · opencode-go/deepseek-v4.1-flash · openai/gpt-6.1-terra)
  pass  the glossary has the three terms, and nothing else  (BARE, OC-STACKED, `.stack/`)
  FAIL  the close ceremony names sweep, report, digest, and one lesson
        the loop has no closing subsection

7/10 passed

FAILED: no CEO seat is named anywhere in the README; the seat count in prose matches agents/; the close ceremony names sweep, report, digest, and one lesson
EXIT=1
```

After the edit, the same script:

```text
  pass  no CEO seat is named anywhere in the README  (no CEO)
  pass  the seat table names exactly the agents on disk  (auditor, employee, lead)
  pass  the seat count in prose matches agents/  (3 agents on disk)
  pass  the tool count and every tool name match lib/tools.js  (7: brief, check, clean, ledger, ready, scope, swarm)
  pass  the skills table and the registry are the same set  (13 ids agree)
  pass  the README states the skill count it lists  (13)
  pass  stacked-soul is described as registered from SOUL.md  (SOUL.md is the one copy)
  pass  the model policy matches the agent files  (lead inherits · opencode-go/deepseek-v4.1-flash · openai/gpt-6.1-terra)
  pass  the glossary has the three terms, and nothing else  (BARE, OC-STACKED, `.stack/`)
  pass  the close ceremony names sweep, report, digest, and one lesson  (sweep, report, digest, lesson)

10/10 passed
Every README claim checked matches the filesystem.
EXIT=0
```

The brief's check, run once on the tree as handed back (`git rev-parse HEAD` = `344e16e8aeb6bce752b399d998005b808dd11f7c`, `git status --short -- README.md` = `M README.md`):

```text
  pass  thirteen skills register  (stacked-soul, stacked, stacked-audit, stacked-debug, stacked-deepen, stacked-employee, stacked-lead, stacked-plan, stacked-pls, stacked-review, stacked-ship, stacked-swarm, stacked-tdd)
  pass  the README skills table and the registry cannot drift  (13 ids agree)
  pass  README points at SOURCES.md for lineage  (pointer present)

81/81 passed

The plugin does what it says. Install it, then restart OpenCode.
EXIT=0
```

`git diff -- README.md` on the working tree is 29 insertions, 15 deletions; most of that diff is the README rewrite that was already uncommitted from other seams. My four changes are the only ones this seam made.

## Unverified

- **No commit.** The working tree carries other seams' edits (`SOUL.md`, `lib/*.js`, `agents/`, `skills/`, `scripts/`); `git add`-ing the README alone would be fine, but the brief does not ask for a commit and the lead lands. The report names the tree state instead of a SHA of mine.
- **Every other README claim** outside the brief's Out (OpenCode "verified on 2.2.6", the four-command table, the preview link, `config.json` shape, the environment flags, "a V1-compatible export is kept", "up to ten live seams") was not re-derived from source. `preview/index.html` and `preview/readme-hero.png` exist; their contents were not opened, because `preview/` is another seam's.
- **"the five stops" (line 39) against "Four things still stop it" (line 68).** Left unchanged on purpose: the count is doctrine, and the files disagree (`skills/stacked/SKILL.md:17` and the bootstrap say five; `agents/lead.md:37`, the bootstrap, and `skills/stacked-lead` say four). Picking one is the lead's call, not a prose edit.
- **"Every genuinely disjoint seam stays live, up to ten" (line 60) against `agents/lead.md:28` "at most three live".** Not touched: the brief's Out does not name it and the two can be read as the tool's ceiling versus the lead's working limit. Raised below.

## Scope

- `README.md` — inside Owns. Four edits: line 3 (drop "The owner is the CEO."), line 39 (drop the same sentence), line 165 ("four agents" → "three agents"), and a new `### Closing a pass` paragraph at lines 70–72 stating `clean` `sweep`, `clean` `report`, the digest refresh, and one lesson. Also removed a trailing blank line I introduced at EOF, so no whitespace orphan remains.
- Nothing outside `README.md`. `lib/`, `scripts/`, `skills/`, `agents/`, `commands/`, `SOUL.md`, and `preview/` are untouched — the verifier script lives in the temp directory, not in the repo.

## Lesson

The README's stale claims were the ones no check read: `scripts/check.mjs` asserts the skills table and the `SOURCES.md` pointer, so `CEO`, "four agents", and the missing close ceremony sat there green through a full 81/81 run. A front page needs its own falsifier — ten assertions in a throwaway script found three lies in a minute, and the same script proves the fix. When the next seat touches the README, re-run the claim checker rather than the self-test; the self-test cannot see prose that is merely wrong. And the two CEO sentences survived in `package.json` and `skills/stacked/SKILL.md`, outside this seam's Owns: a doctrine name dies file by file, so the seam that removes it should grep the repo, not the file it was given.
