# delegation-duty

## Out

The lead skill states the division as a rule with a test, not as advice, and the always-on bootstrap carries the one line that makes it bite. Three edits:

1. **`skills/stacked-lead/SKILL.md`** gains a section, `## The seat's hard boundary`, containing:
   - A two-column table: what the lead MAY do, what it MAY NOT.
     - MAY: read, search, fetch, run the check, write `.stack/**` (ledger, briefs, goal.md, digest, reports), dispatch, reconcile, land a commit, decide anything reversible.
     - MAY NOT: edit any file outside `.stack/`, fix the bug it just diagnosed, take a seam it dispatched, audit its own work, push or publish (owner).
   - **The delegation ladder**, in order, first match wins: one file and one edit -> still a seam, dispatched; two or more files -> seamed and ranked; a task with no file yet (a decision, a diagnosis, a review) -> dispatched to the department that owns it (product, design, quality, platform, knowledge, research, engineering); a request that is itself a question about the stack -> answered directly, because talking is not working.
   - **The rule that makes it aggressive**: if the lead is about to open a file editor, it dispatches instead. The only exception is `.stack/`.
   - **Why**: an unreconciled worker is work you cannot land, but a lead that does the work is a seam nobody audited - it writes and then grades its own writing.

2. **`lib/skills.js` bootstrap**: one line added in the Autonomy section, no more than two lines of text, in the existing voice:
   `The lead writes only .stack/. Every source change is a seam, even a one-line fix. If you are about to open an editor, dispatch instead.`
   Keep the bootstrap under 3600 characters - it is asserted, and the assert wins.

3. **`README.md`**: under the seats table, one short paragraph naming this boundary and the delegation ladder; and in the skill table, no change to existing rows. `CHANGELOG.md`: append one paragraph to the `0.3.0` entry describing the boundary and the routing duty in plain words, matching the surrounding voice (result first, numbers over adjectives, no hype).

## Check

```text
node -e "import('./lib/skills.js').then(m=>console.log(m.bootstrap().length))"
node scripts/check.mjs
```

The first prints a number under 3600. The second exits 0. Paste both outputs verbatim.

Then, by hand, verify the edits are where the brief says: the table exists in `stacked-lead`, the line exists in the bootstrap, the README paragraph exists. A claim without that grep is a claim.

## Owns

`skills/stacked-lead/SKILL.md`, `lib/skills.js`, `README.md`, `CHANGELOG.md`

## Do not touch

`agents/**`, `scripts/check.mjs`, `bin/**`, `package.json`, any other skill file. `scripts/check.mjs` is owned by another seam running at the same time - if you believe it needs a change, say so in the report instead of editing it.

## Read first

- `skills/stacked-lead/SKILL.md` (especially the "Act, do not ask" and routing sections already there - do not duplicate them)
- `lib/skills.js`, `bootstrap()`
- `README.md` seats section
- `CHANGELOG.md` `0.3.0` entry, for voice

## Tier

Doctrine. No code behaviour changes. Do not "improve" surrounding prose; add only what the brief names.
