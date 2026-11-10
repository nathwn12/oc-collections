# Seam employee-family: employees become specialists, not one generic

**Owner:** one employee. **Written by:** the lead. **State:** briefed.

## Why now

One generic `employee` spawned per seam means every worker starts blank, re-reads the same repo, and accumulates nothing. The seats are permanent and the workforce is disposable — backwards. Make the archetypes permanent and the seams disposable: the lead routes a seam to the employee whose expertise fits.

## Out

Six employee archetypes replace the single generic, all `mode: subagent`, all denying `subagent`:

| File | Owns | Pins |
|---|---|---|
| `agents\builder.md` | feature and fix implementation | `opencode-go/deepseek-v4.1-flash` |
| `agents\tester.md` | the proving check itself: harnesses, fixtures, regression cases | same |
| `agents\debugger.md` | reproduction, bisect, root cause | same |
| `agents\refactorer.md` | shape without behaviour change | same |
| `agents\reviewer.md` | diff against the brief, before audit | `openai/gpt-6.1-terra` |
| `agents\docs.md` | README, changelog, references | `opencode-go/deepseek-v4.1-flash` |

Delete `agents\employee.md`. `skills\stacked-employee\SKILL.md` becomes the shared body all six load — keep its id, do not duplicate prose into six files. Each archetype's agent body is short: its seat, what it refuses, the skill to load, and the report shape.

`skills\stacked-lead\SKILL.md` gains a routing table: seam type → archetype, one line each, plus the rule that a seam names its archetype in the dispatch block.

`lib\tools.js` `dispatchBlock` takes the archetype and prints `Agent: <archetype> (<model>)`. Keep it one line; the block must stay pasteable.

`scripts\check.mjs`: agents are now **8** (`lead`, `auditor`, six archetypes); every archetype has `mode: subagent`, denies `subagent`, and pins the model its row names.

## Check

```text
node scripts/check.mjs
```

Exit 0, and the agent count assertion reads 8.

## Owns

`agents\`, `skills\stacked-lead\SKILL.md`, `skills\stacked-employee\SKILL.md`, `lib\tools.js` (`dispatchBlock` only), `scripts\check.mjs`.

## Do not touch

`README.md`, `package.json`, `skills\stacked\SKILL.md` — another seam owns them right now. `SOUL.md`, `preview\`.

## Read first

`agents\employee.md`, `agents\lead.md`, `skills\stacked-employee\SKILL.md`, `skills\stacked-lead\SKILL.md`, the `dispatchBlock` function in `lib\tools.js`.

## Report

`.stack\reports\employee-family.md`, five sections, then one paragraph: what changed, the count, the check line, concerns.
