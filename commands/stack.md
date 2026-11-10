---
description: Enter the stack, restate the objective, cut seams, brief the first one
agent: lead
---

# Enter the stack

Objective: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask for the objective in one line and stop.

1. Restate the objective in one sentence, in your own words. If the restatement and the request disagree, say so now.
2. Write three short lists: constraints (what cannot change), unknowns (every place you would otherwise guess), out of scope (named so nobody infers it later).
3. Cut the objective into seams. Score each by value × risk ÷ effort. Keep at most three live; the rest go to the ledger as `PARKED` with the reason.
4. Order the seams so the first landing makes the rest easier or proves them unnecessary.
5. Write the first brief with `brief op=new`: Out, Check, Owns, Do not touch, Read first, Tier. If no proving command exists, say so instead of inventing one.
6. Log intake with `ledger op=log kind=INTAKE text="intake: <one sentence>"`.
7. Dispatch one employee with the seam id and the brief path. Nothing else.

Return: the restated objective, the ranked seam table, and the first dispatch. One screen.

