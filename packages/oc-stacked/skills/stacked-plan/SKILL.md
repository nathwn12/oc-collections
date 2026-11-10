---
name: Stacked Plan
description: Use when a request needs a design before code — a feature, an ambiguous ask, "how should we build this", or a brief whose Check is not obvious. Answers the five questions, picks an altitude, and cuts the result into seams a stranger can dispatch from.
license: MIT
---

# Plan

A plan is a compression of the work, not a document about it. Its test: can someone who was not in this conversation dispatch from it without asking you anything?

## The seat

Planning belongs to the lead before dispatch, or to the employee as its first act when the brief says the design is the work.

## The interrogation

Five questions. Answer all five before a spec exists. An unanswered one is a guess wearing a plan's clothes.

| # | Question | What a wrong answer costs |
|---|---|---|
| 1 | What happens today? | You plan against a codebase that does not exist. |
| 2 | What is the smallest visible change? | No Out, so the seam has no edge. |
| 3 | What must not change? | You break a caller nobody briefed you about. |
| 4 | What would make this the wrong thing to build? | You ship the right implementation of the wrong request. |
| 5 | How will we know it worked? | The check becomes an opinion, and the verdict becomes a mood. |

Answer them with evidence, not recollection. Question 1 wants the file, the function, or the command that shows the behaviour. Question 5 wants a command you have run once, seen fail, and know how to see pass. If you cannot run it, write `Unverified:` now, not at landing time.

Question 4 is the one people skip. Name the condition under which the correct answer is "no, do not build this" before you are attached to an approach. A plan that cannot be wrong cannot be checked.

## Altitude

Every ask sits at one of three rungs. Choose deliberately.

| Rung | What you do | Cost |
|---|---|---|
| **Fix the instance** | Make this one call site, record, or failure correct. | Smallest. The class returns. |
| **Remove the class** | Make every instance of this failure impossible by construction. | Medium. Touches shared code. |
| **Prevent the class** | Add the check, type, or gate that stops the next one being written. | Largest. It is infrastructure, and infrastructure needs an owner. |

Take the highest rung you can **finish and check today**. Then name the rung you did not take, in the spec, with the reason. That line is what stops the next person re-litigating the decision from scratch.

Climbing a rung without the check to prove it is how a one-line fix becomes a two-week refactor with no verdict.

## Cutting seams

Slice in this order, and stop at the first slice that works:

1. **By file boundary.** What can one worker own outright, with no other worker in the same file?
2. **By check.** If the file boundary is unclear, cut where the proving command changes. Two seams with one check are one seam.
3. **By risk.** Land the seam that might delete two others first. Order by what makes the rest cheaper, never by who is free.

| Good cut | Bad cut |
|---|---|
| One seam per file cluster, boundary visible in the tree | "Backend" and "frontend" — two folders and forty files |
| Each seam has its own check | Two seams sharing one test file |
| A seam whose failure is loud and immediate | A seam that fails silently at merge time |
| A seam small enough to describe in one sentence | A seam that needs a paragraph of preamble |
| A seam that might kill another seam, first | A seam ordered by the sequence you thought of it |

**The rule: if two seams touch one file, they are one seam.** Not two briefs with a note about coordination. One seam. A shared folder is fine. A shared package is fine. A shared file is a merge conflict with extra steps, and you will meet it at the worst moment.

A seam is too big when you cannot name its check. Too small when the brief, dispatch, report, and reconcile cost more than the edit. Merge those.

## The spec

One screen. Nothing here is prose for its own sake; every line is load-bearing for a brief or a check.

```text
Problem        — what is true today, with the evidence that shows it.
Out of scope   — named, so nobody infers it later.
Approach       — the change, in the order it lands.
Rejected       — each alternative and the one reason it lost.
Check          — the command, and what red looks like.
Seams          — id, Out, Check, exact files. One line each.
Parked         — what you deliberately did not do, and why not now.
Rung           — which altitude you took, and which you did not.
```

Keep `Rejected` honest. "Too much work" is a reason only when paired with the cost you measured. A rejected alternative with no reason is a preference.

If the spec's seam list has an id, an Out, a check, and exact file paths for every row, `swarm` can write the briefs from it directly.

## Plan is not permission

Once the spec is written, build. Do not ask a human to approve a reversible plan. Approval theatre costs a day and buys a signature on something you already know how to undo.

Ask only for the five things in the stacked skill's stop list:

- an irreversible act;
- money above the standing cap;
- a security-sensitive act;
- a side effect outside the worktree that norms say you ask about — a merge, a push to a shared branch, a publish;
- a request with no path: a brief so broken that every path is a guess.

For those, write an `ASK` line and stop. For everything else, log a `RULING` with the cost if wrong and keep moving. A stack parked on a question it could have answered itself is the most expensive way to be careful.

## Voice

State the design and the check. No tour of how you arrived at them.

- Bad: "Let me walk through my thinking on this. First, I want to understand the current architecture, then I'll consider several possible approaches and outline a comprehensive plan before we proceed."
- Good: "Retries drop the payload today; `npm test -- retry` shows it red. One seam: keep the body on retry, check is that same command. Class fix parked — it needs a transport change I cannot check today."
