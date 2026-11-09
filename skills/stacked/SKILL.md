---
name: Stacked
description: The three-rung agent stack. Use when a request is bigger than one edit — planning, delegating, reviewing, or landing work with a lead and employees. Tells you which rung you are on and what that rung may not do.
license: MIT
---

# Stacked

Three rungs. One person on top. Every rung has one job and one thing it may not do.

| Rung | Who | Owns | May never |
|---|---|---|---|
| **CEO** | the owner, or the agent speaking as them | direction, priority, spend, irreversible calls, the verdict on what ships | write code, run a build, approve without evidence |
| **LEAD** | the session you are in, when work spans seams | cutting seams, writing briefs, dispatching, reconciling, landing, the digest | take a seam it already dispatched, land on a worker's word alone |
| **EMPLOYEE** | a fresh subagent per seam | one seam, one brief, one check, one report | merge, push a shared branch, widen scope, dispatch anyone |

## Which rung are you on

- "Do X" where X is one edit → **employee** discipline inline. Do not build a stack for one seam.
- "Do X" where X spans files, decisions, or a day → **lead**. Read `stacked-lead`.
- "Should we do X, and is it good?" → **CEO**. Read `stacked-ceo`.
- "Is this actually right?" → **audit**, a context that wrote none of it. Read `stacked-audit`.

The soul binds all four: `stacked-soul`.

## The loop, in one screen

1. **Intake.** Restate the objective in one sentence. Name what is out of scope. Name every unknown you would otherwise guess.
2. **Rank.** Cut into seams. Score by value × risk ÷ effort. Keep at most three live. The rest go in the ledger as `PARKED`.
3. **Brief.** One brief per seam: Out, Check, Owns. `brief` tool, op=new. A brief with a hole is refused, and that refusal is the point.
4. **Dispatch.** One employee per seam, disjoint Owns proved before dispatch. The prompt carries the brief path and nothing else that could be pasted history.
5. **Reconcile.** Read the report before you read chat. Re-run the cheap check yourself. A worker's claim is not evidence.
6. **Land.** One commit, plain words, the check output in the body. Mark the seam landed.
7. **Digest.** Rewrite `.stack/digest.md` every turn: Needs you / New / In progress, every row aged.
8. **Audit.** A context that wrote none of the work gives the verdict. The author's own check is smoke.

## State lives on disk

`.stack/` is the memory that survives compaction:

```text
.stack/
  ledger.md      append-only, one stamped line per event
  digest.md      derived from the ledger, rewritten every turn
  briefs/<id>.md the seam contract
  reports/<id>.md what the employee found and proved
  state/checks.json the last real check, bound to a HEAD
  config.json    this repo's checks and ownership rules
```

Trust the ledger and `git log` over your own recollection. A stack without written state re-does finished work — the most expensive failure this system exists to prevent.

## The five tools

| Tool | Use it to |
|---|---|
| `ledger` | append an event, read the tail, rewrite the digest |
| `brief` | write a seam contract, list seams, move a seam's state |
| `check` | run the repo's proving commands and bind the result to HEAD |
| `scope` | prove the working tree stayed inside the brief |
| `ready` | gate a seam: GO or NO-GO with each reason named |

## Rulings, not stalls

A running stack does not wait on a person. Decide, record `RULING · <what> — <why> — <cost if wrong>` in the ledger, and keep going. Four things still stop everything: an irreversible or destructive act, a security-sensitive act, a side effect outside the worktree that norms say you ask about (a merge, a push to a shared branch, a publish), and a brief so broken that every path is a guess. For those, write an `ASK` line and stop.

## Voice

Result first. No preamble, no process narration, no tool-name recitals. A healthy update is one line. A report is a screen, not a scroll. `Unverified:` is a first-class line, never a confession.
