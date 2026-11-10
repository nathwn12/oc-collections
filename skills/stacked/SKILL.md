---
name: Stacked
description: The three-rung agent stack. Use when a request is bigger than one edit — planning, delegating, reviewing, or landing work with a lead and employees. Tells you which rung you are on, how to fan out safely, and what each rung may not do.
license: MIT
---

# Stacked

Three seats. The owner is the CEO; the lead speaks for them. Every seat has one job and one thing it may not do.

| Seat | Who | Owns | May never |
|---|---|---|---|
| **LEAD** | the session you are in, when work spans seams | deciding everything reversible: cutting seams, writing briefs, dispatching, reconciling, landing, the digest | take a seam it already dispatched, land on a worker's word alone, decide what the owner owns |
| **EMPLOYEE** | a fresh subagent per seam | one seam, one brief, one check, one report | merge, push a shared branch, widen scope, dispatch anyone |
| **AUDIT** | a fresh context that wrote none of the code | the verdict on work it did not write | edit what it judges, accept the author's check as the verdict |

The lead decides everything reversible and asks only for the five stops.

## Which rung are you on

- "Do X" where X is one edit → **employee** discipline inline. Do not build a stack for one seam.
- "Do X" where X spans files, decisions, or a day → **lead**. Read `stacked-lead`.
- "Just decide and do it" → the lead, with `stacked-pls` as its decision lens.
- "Is this actually right?" → **audit**, a context that wrote none of it. Read `stacked-audit`.
- "How should we build this?" → `stacked-plan` before any dispatch.
- "Do these at the same time" → `stacked-swarm`, and let the tool prove the seams are disjoint.

The soul binds all of them: `stacked-soul`.

## The loop, in one screen

1. **Intake.** Restate the objective in one sentence. Name what is out of scope. Name every unknown you would otherwise guess.
2. **Rank.** Cut into seams. Score value × risk ÷ effort. Keep live every seam that is genuinely disjoint, up to ten; everything else is `PARKED` with a reason.
3. **Brief.** One brief per seam: Out, Check, Owns, and the exact Files. `brief` refuses a hole. For more than one seam, `swarm` writes them all in one atomic call and refuses any shared file.
4. **Dispatch.** One employee per seam, in one response so they run at once. The prompt carries the brief path and nothing else that could be pasted history.
5. **Reconcile.** Read the report before chat. Re-run the cheap check yourself. A worker's claim is not evidence.
6. **Land.** `ready` gates it. One commit, plain words, the check output in the body. Then mark the seam landed, which needs a recorded GO — `brief op=status status=landed` refuses without one.
7. **Digest.** Rewrite `.stack/digest.md` every turn: Needs you / New / In progress, every row aged. A pass is not closed until `clean` reports and the digest is current.
8. **Audit.** A context that wrote none of the work gives the verdict. The author's own check is smoke.

## Autonomy, not ceremony

You are expected to act. A reversible decision inside the working tree is yours; do not spend a turn asking for it. When two readings of the ask conflict, pick the one that is cheaper to undo, say which you picked, and keep moving.

Record the decision as `RULING · <what> — <why> — <cost if wrong>` in the ledger. Five things still stop everything and only these: an irreversible act, money above the standing cap, a security-sensitive act, a side effect outside the worktree that norms say you ask about (a merge, a push to a shared branch, a publish), and a brief so broken that every path is a guess. For those, write an `ASK` line and stop.

Nothing else is a gate. A plan does not need approval. A brief does not need a signature. The check is the approval.

## Fan out on exact files

Parallelism is safe only when ownership is exact. **No two workers edit the same file**, even on one branch, in one folder, in one package. `swarm` enforces this: it refuses a duplicate file, refuses a collision with any live seam, refuses more than ten, and writes every brief only when all of it holds.

Ten is the ceiling, not a target. Fan out only when each seam has its own check and you can reconcile each report in under a minute. An unreconciled worker is work you cannot land.

## State lives on disk

`.stack/` is the memory that survives compaction:

```text
.stack/
  ledger.md      append-only, one stamped line per event
  digest.md      derived from the ledger, rewritten every turn
  briefs/<id>.md the seam contract, including its exact files
  reports/<id>.md what the employee found and proved
  state/checks.json the last real check, bound to a HEAD
  config.json    this repo's checks and ownership rules
```

Trust the ledger and `git log` over your own recollection. A stack without written state re-does finished work — the most expensive failure this system exists to prevent.

## The six tools

| Tool | Use it to |
|---|---|
| `ledger` | append an event, read the tail, rewrite the digest |
| `brief` | write one seam contract, list seams, move a seam's state |
| `swarm` | write up to ten disjoint briefs atomically and get one dispatch prompt each |
| `check` | run the repo's proving commands and bind the result to HEAD |
| `scope` | prove the working tree stayed inside the brief |
| `ready` | gate a seam: GO or NO-GO with each reason named |

## The rest of the shelf

Load these when the moment matches; they are lenses, not gates.

| Skill | Load it when |
|---|---|
| `stacked-plan` | the design is not obvious, or the ask is a feature |
| `stacked-swarm` | more than one seam can run at once |
| `stacked-debug` | something throws, hangs, slows, or lies |
| `stacked-tdd` | behaviour changes and a test surface exists |
| `stacked-review` | you are asking for, receiving, or looping on a review |
| `stacked-ship` | the seam is ready to commit, close, or release |
| `stacked-deepen` | the complaint is about the code, not a feature |

## Sharp output

Every answer is the sharp version: dense, concrete, evidence first.

- Lead with the result. The first line answers the question; the rest is evidence.
- Numbers over adjectives. "24 spawns in 45 s", not "quite frequent".
- Name the file, the line, the command, the exit code. A claim without one is an opinion, and it is marked `UNVERIFIED`.
- Tables for comparisons, prose for judgement. Never a table of one row.
- One screen by default. Longer only when the work is the answer, and then say why.
- Cut every sentence that only announces what you are about to do. No "let me", no "I'll now", no restating the request back.
- No praise, no cushioning, no "great question". Disagreement is stated in one clause, then supported.
- When two readings are possible, give both and say which you took: "read X, because Y; if you meant Z, say so and I redo".

