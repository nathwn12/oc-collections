---
name: Stacked Loop
description: Keep working toward a goal until it is actually met, judged by a context that did none of the work. Use on "don't stop until", "keep going", "loop on this", "until it's done", a vague ask that should still land, or any multi-turn job with a check. Also use when a previous turn ended with "should work" and nobody ran anything.
license: MIT
---

# Stacked Loop

One job: **do not stop while the goal is still reachable, and do not declare it met on your own word.**

This is oc-stacked's own goal loop. It borrows the one idea worth borrowing - a fresh judge decides completion, not the worker - and replaces the parts that do not fit here: the goal is a file in `.stack/`, the judge is a fresh context that can run the check, and the loop only ever routes to rungs that exist.

## The goal is a file, not a feeling

`.stack/goal.md`, rewritten only when the goal changes:

```text
Out:         <one measurable end state>
Check:       <exact command> -> <expected output or exit code>
Constraints: <what must not change on the way there>
Budget:      <n turns, or a wall clock>
Assumption:  <the guess you made about a vague ask, in one line>
Tried:       <appended once per turn, never edited>
```

A file, because the loop outlives the context window: after a compaction the file is still there, the digest can read it, and the judge can be shown it. A goal that lives only in a conversation is a goal that quietly changes shape when the conversation is summarised.

**The Check must be demonstrable in the transcript.** A command whose output the judge can read. "The code is cleaner" is not a Check. "`npm test` exits 0 and `git status` is clean" is.

## One turn

1. **Read** `.stack/goal.md`. No goal? Make one - see *Vague is a first turn*.
2. **Route.** First matching row in the table below. One seat per turn, and say which.
3. **Act.** The smallest change that could plausibly move the verdict. Not the whole plan.
4. **Judge** from a context that did none of it: a fresh context (load `stacked-audit`), or the Check's own output when the Check is unambiguous. **Never the context that just acted.**
5. **Record** one ledger line: `kind=GOAL turn=<n> seat=<x> verdict=met|not-yet|impossible reason="<short>"`.
6. **Branch.** `not-yet` - the reason becomes the next turn's directive, verbatim. `met` - clear the goal, write the AUDIT line with the sha, update the digest. `impossible` - stop and ASK, with the evaluator's reason quoted.

The turn you just did is not evidence. The judge's verdict is.

## Auto-routing

First match wins. Log the route; a silent route is a guess with good manners.

| Signal | Seat |
|---|---|
| The ask is vague, half-shaped, or "just sort it out" | `stacked-pls` - turn it into a candidate Out before acting |
| The design is not obvious | `stacked-plan` |
| One file, one edit | morph discipline inline - do not build a stack for one seam |
| More than one genuinely disjoint seam | `stacked-swarm` |
| Cause unknown: throws, hangs, slow, lies | `stacked-debug` |
| Behaviour must change and a test surface exists | `stacked-tdd` |
| Code fights every edit, no behaviour change wanted | `stacked-deepen` |
| Blocked, "it won't let us", no path | `stacked-oftb` |
| The host is misconfigured: seats missing or stale | `stacked-wizard` |
| Someone asked for or gave a review | `stacked-review` |
| The seam is ready to commit, close, or release | `stacked-ship` |
| A verdict is due on work already done | fresh context + `stacked-audit` |

**The groundhog rule.** If two consecutive turns route to the same seat and return the same verdict with the same reason, the route is wrong, not the work. Change seat, or change the Out. Looping harder is not a strategy.

## Vague is a first turn, not a refusal

A vague request does not get a question mark by default. It gets a guess, written down:

```text
Assumption: you want the migration done for the global CLIs, not for repo-local deps.
```

Then run one turn against that hypothesis. The verdict is cheap; a question costs a full round trip and often gets a worse answer than a concrete attempt to react to.

Ask only when two different readings of the ask would produce **incompatible work** - not merely different work. That is the one shape of vagueness that is genuinely a stop, and it is worth exactly one question, with both readings laid out.

## When the loop stops

| Stop | Who decides |
|---|---|
| `met` | the judge, with the Check's output in the transcript |
| `impossible` | the judge, with a reason - then ASK |
| **no progress** - two consecutive turns with no new evidence | you, immediately. Stop, report, leave the goal open |
| **budget spent** | you. Report what moved and what did not |
| **an owner gate** | the five stops in `stacked`. Write the ASK, stop the loop |

A goal is never cleared because it is late, because a session is ending, or because the work "looks right". Those are the three ways a loop turns into a lie.

## Commands are the owner's

`/stack` and every other command are the human hand on the wheel. **The loop never types a command for itself.** It is triggered by language and by the digest, not by slash syntax; if the loop could issue commands, the owner would lose the only lever that reliably stops it.

## What the loop refuses

- A Check it cannot run.
- A verdict from the context that did the work.
- "Should work" as a reason.
- Clearing a goal to end a turn.
- Two seats in one turn, so that neither is accountable.

## Report, one line per turn

```text
turn 4 · seat=backend · verdict=not-yet · reason="login.test.ts still red: 401 vs 200"
```
