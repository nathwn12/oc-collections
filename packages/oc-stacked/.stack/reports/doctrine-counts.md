# doctrine-counts — one stop list, one owner sentence

## Outcome

README.md, `package.json`'s `description`, and `skills/stacked/SKILL.md` now each state the single owner sentence **"The owner is the CEO; the lead speaks for them."** and nothing in them claims a `ceo` agent or seat. The stop list is stated once per prose document and now opens with "Five things", with *money above the standing cap* restored as item 2 in both README and the stacked skill.

Reading taken (brief does not say it): `package.json`'s one-line description cannot carry a five-item list, so it carries only the owner sentence; the list lives in the two documents that actually state one. Out of scope and left for the lead: `lib/skills.js`, `agents/lead.md`, and `skills/stacked-plan/SKILL.md` still say four — named under Unverified below.

## Evidence

A failing case first, watched fail for the right reason. Script: `C:\Users\nathan\AppData\Local\Temp\opencode\doctrine-counts-check.mjs` (my own cheapest honest check — asserts one owner sentence per file, every `ceo` hit is that sentence, and the list opens "Five things" with each of the five items exactly once).

Before my edit — `node C:\Users\nathan\AppData\Local\Temp\opencode\doctrine-counts-check.mjs` (exit 1):

```text
  FAIL  README.md: owner sentence appears 0 times, expected once
  FAIL  package.json: owner sentence appears 0 times, expected once
  FAIL  package.json: 1 "ceo" hits but only 0 owner sentence(s) — a seat may be claimed
  FAIL  skills/stacked/SKILL.md: owner sentence appears 0 times, expected once
  FAIL  skills/stacked/SKILL.md: 2 "ceo" hits but only 0 owner sentence(s) — a seat may be claimed
  FAIL  README.md: stop list does not open with "Five things": four things still stop it: an irreversible act, a security-s
  FAIL  README.md: "money above the standing cap" appears 0 times, expected once
  FAIL  skills/stacked/SKILL.md: stop list does not open with "Five things": four things still stop everything and only these: an irrever
  FAIL  skills/stacked/SKILL.md: "an irreversible act" appears 0 times, expected once
  FAIL  skills/stacked/SKILL.md: "money above the standing cap" appears 0 times, expected once

RED: 10 finding(s)
```

After — same script (exit 0):

```text
  pass  README.md: owner sentence once
  pass  README.md: all 1 "ceo" hits are the owner sentence
  pass  package.json: owner sentence once
  pass  package.json: all 1 "ceo" hits are the owner sentence
  pass  skills/stacked/SKILL.md: owner sentence once
  pass  skills/stacked/SKILL.md: all 1 "ceo" hits are the owner sentence
  pass  README.md: stop list opens with "Five things"
  pass  README.md: "an irreversible act" stated once
  pass  README.md: "money above the standing cap" stated once
  pass  README.md: "a security-sensitive act" stated once
  pass  README.md: "a side effect outside the worktree" stated once
  pass  README.md: "a brief so broken" stated once
  pass  skills/stacked/SKILL.md: stop list opens with "Five things"
  pass  skills/stacked/SKILL.md: "an irreversible act" stated once
  pass  skills/stacked/SKILL.md: "money above the standing cap" stated once
  pass  skills/stacked/SKILL.md: "a security-sensitive act" stated once
  pass  skills/stacked/SKILL.md: "a side effect outside the worktree" stated once
  pass  skills/stacked/SKILL.md: "a brief so broken" stated once

GREEN: one stop list, always five, one owner sentence
```

The brief's check — `node scripts/check.mjs` (exit 0), run on this tree before and after my edit, 81/81 both times:

```text
  pass  README points at SOURCES.md for lineage  (pointer present)

81/81 passed

The plugin does what it says. Install it, then restart OpenCode.
```

The brief's second evidence, every `ceo` hit in the three files (`Select-String -Path README.md,package.json,skills\stacked\SKILL.md -Pattern 'ceo'`):

```text
--- README.md
39: The owner is the CEO; the lead speaks for them. The lead decides everything reversible and asks only for the five stops.
--- package.json
4: "description": "A three-rung agent stack for OpenCode: one lead, a fresh employee per seam, and an auditor who wrote none of it. The owner is the CEO; the lead speaks for them. Local-first, zero MCP, Windows-native.",
--- skills\stacked\SKILL.md
9: Three seats. The owner is the CEO; the lead speaks for them. Every seat has one job and one thing it may not do.
```

Three hits, all the owner. No agent, no seat.

## Unverified

- **The rest of the repo agrees on five.** I grepped and it does not, outside my `Owns`. Three live contradictions the lead must brief separately: `lib/skills.js:86` — the always-injected bootstrap still says *"Only four things stop the stack"* and omits the money cap; `agents/lead.md:37` — *"Four things stop you"*, same omission; `skills/stacked-plan/SKILL.md:88` — *"the four things in the stacked skill's stop list"*. I did not touch them (Owns).
- **The plugin loads in a real host.** Not run. `node scripts/check.mjs` is the repo's self-test, not an OpenCode session.
- **`preview/index.html`** still carries a `--ceo` CSS variable and `.r-ceo` rules. Cosmetic, outside Owns, not checked against the rendered page.
- **`CHANGELOG.md`** (untracked) says the CEO seat is gone and "five owner gates" — consistent on the count, unchanged by me.

## Scope

Three paths, all inside `Owns`:

- `README.md` — owner sentence at line 39; stop list at line 68 now five with the money cap.
- `package.json` — `description` only, owner sentence completed.
- `skills\stacked\SKILL.md` — owner sentence at line 9 (line 17's duplicate "The owner is the CEO." removed); stop list at line 45 now five with the money cap.

All three files already carried uncommitted edits from other seams when I arrived (`git status` at start showed them modified), so `git diff -- README.md package.json skills\stacked\SKILL.md` reports 55 insertions/28 deletions — not my delta. My delta is the four lines above; `Four things` now returns zero hits in all three files (`Select-String -Pattern 'four things'` → no output).

No commit: the working tree holds other seams' uncommitted work, so a commit here would land work I did not write. Landing is the lead's call.

## Lesson

The count drifted because the five-item list is restated in seven places and only two of them were in this seam. A stop list that lives in prose will drift again; the always-injected `lib/skills.js` bootstrap is the copy that matters most, because it is the one every session reads, and it is still at four. Whoever next touches the list should fix `lib/skills.js` and `agents/lead.md` first, and consider making the bootstrap read the list from a single constant rather than restating it.
