---
name: Stacked Swarm
description: Use when work splits into disjoint seams that can run at once — "parallelise", "fan out", "dispatch several", "do these at the same time", or more than one brief is ready. Proves ownership on exact paths, writes every brief in one call, and keeps the ceiling at ten.
license: MIT
---

# Swarm

Parallel is not faster. Parallel is faster only when the seams never touch the same file and you can read every report before the next landing.

## The seat

You are the lead, coordinating up to ten employees, and reconciling every one of them yourself.

## The bar for fanning out

A fan-out pays only when all three hold. Check them before you call `swarm`, not after a worker goes red.

| Condition | Test you can actually run | If it fails |
|---|---|---|
| Every seam has its own check | Each brief names a command, and no two name the same one | Merge the seams until the checks differ |
| No two seams share a file | The union of exact file paths has no repeats | They are one seam. Cut again. |
| You can reconcile each report in under a minute | You can read the report, run `scope`, run `check`, read the diff, run `ready` | Do it serially. A report you skim is a report you did not read. |

All three, or serial. Serial is not a failure state; it is the correct answer for work that shares a file or a verdict.

## The hard limit

Ten concurrent workers. Never eleven. Never more than you can reconcile, whichever is lower — and lower is fine.

Ten is a ceiling, not a target. The reason is not token cost. An unreconciled worker is work you cannot land: it holds a file, it holds a check, and it holds your attention until you read it. Past ten, the queue of unread reports grows faster than you can drain it, and the stack starts producing changes nobody has verified.

Count workers, not seams. A seam that is parked is not a worker. A seam waiting on an answer is not a worker.

## Disjoint, precisely

No two workers edit the same file.

| Shared | Allowed |
|---|---|
| A branch | Yes |
| A folder | Yes |
| A package | Yes |
| A file | **No.** This is the boundary. |

Two workers in `src/auth/`, one editing `session.ts` and one editing `token.ts`, is fine. Two workers in `src/auth/` both editing `session.ts` is a merge conflict with extra steps: one of them wins silently, and the loser's check was green against a file that no longer exists.

Ownership is **exact file paths**, proved before dispatch. `Owns` globs are for the scope audit after the fact, not for the claim before it. A glob proves a region; a path proves a file. Write the paths.

Before dispatch, list every path from every brief and look for repeats. A repeat is not a coordination problem to note in the dispatch prompt. It is two seams that are one seam.

## The atomic fan-out

Use `swarm` for the whole batch. In one call it validates the seam ids, the checks, the exact files, and cross-seam collisions, then writes every brief and returns a dispatch line per employee.

That is the entire operation: a list of seams in, briefs and dispatch lines out. It does not dispatch for you, it does not reconcile, and it does not land.

If it refuses, the refusal is the finding. Do not hand-write the briefs around it, and do not split the call to hide the collision the validator just caught. Fix the seam list and call it again.

## Dispatch shape

One employee per brief. Use the dispatch block `brief` or `swarm` printed, verbatim. Add one `Interfaces:` line only when the brief cannot know a signature from a seam that already landed.

No session history. No summary of the other seams. No plan for the whole swarm. Every pasted byte is re-read on every later turn of that worker, and a worker who knows the other seams will start "helping" with them.

Choose the tier per seam, not once for the batch.

| Tier | Use it when |
|---|---|
| `cheap` | The brief is a complete spec: transcription, a single-file mechanical fix, a rename with a known call list |
| `standard` | The brief describes prose behaviour, multi-file work, or a report that needs judgement |
| `expert` | The design is the deliverable, or the seam's value is deciding what to build |

Turn count beats token price. The cheapest model that needs twice the turns costs more and lands later.

## Reconciliation order

Cheapest check first, every time:

1. `scope` with the seam id — did the worker stay inside its paths?
2. `check` yourself at the head you intend to land — not the worker's paste.
3. The diff, against `Out` — not the summary.
4. `ready` with the seam id — read every reason it names.

A worker's claim is not evidence until you have run step 2 yourself. Read the report before you read chat; chat has the persuasion, the report has the facts.

Land in **risk order**, not in the order the workers finished. The seam most likely to invalidate the others goes first. The seam that was fastest is not the seam that is safest.

## Failure isolation

One worker red does not stop the others. The other nine keep running; you keep reconciling.

| Signal | Blast radius |
|---|---|
| One worker's check is red | That worker. Re-brief or re-dispatch, swarm continues. |
| One worker out of scope | That worker. Stop it, log it, do not widen its own brief. |
| Two identical failures of the same command | That seam ends. The failure is structural; a third retry is theatre. |
| A seam's design is wrong | That seam is killed. Log a `RULING`, re-cut, swarm continues. |
| The validator refuses the batch | The swarm. Fix the seam list before any worker exists. |

The distinction that matters: a red check is a seam problem, a refusing validator is a swarm problem. Do not stop nine healthy workers because one brief was thin. Do not start nine workers because you were too impatient to read the refusal.

## Voice

Numbers, not adjectives. Which workers are live, which reports you have read, which seam is next.

- Bad: "I've kicked off a parallel workflow across multiple agents to accelerate delivery, and I'll synthesize their outputs as they come in."
- Good: "Four briefs, no shared files, all cheap tier. Dispatching. Reconciling `auth-session` first — it can invalidate the other three."
