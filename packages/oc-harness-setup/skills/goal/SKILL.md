---
name: goal
description: Use when a frozen SPEC must become working code without rescoping — cut tracer-bullet tickets, loop one ticket at a time with TDD to a cited runnable check, then run the repo's full gate green.
---

# goal

End-to-end looper: `to-spec` → `to-tickets` → `implement` → `tdd` → repo gate → fresh verdict.

## When to load

- Load on "take this spec to green end to end".
- Load on "take this ticket to green with TDD".
- Load on "loop this feature until everything is green".
- Load when a frozen SPEC must become working code without rescoping.
- Load when a ticket queue must drain in dependency order.

## Procedure

1. Read the input as one of three: a frozen SPEC, a ticket, or an issue. Name which before touching code.
2. If it is not a SPEC, freeze one with `to-spec`: outcome, scope, requirements, acceptance evidence.
3. Done when the SPEC names one observable outcome plus evidence per requirement.
4. Discover the gates the repo actually has before the first ticket: read `package.json` scripts, `Makefile`, `pyproject.toml`, and CI config. Name the exact full-gate commands and the per-ticket check.
5. Seed one known failure per gate once and cite it; a gate that cannot fail is not a gate.
6. Cut the SPEC into tracer-bullet tickets with `to-tickets`; order blockers-first.
7. Done when every ticket states what it delivers plus its blocking edges.
8. Work only the frontier whose blockers are done; pull exactly one ticket per loop.
9. Never run two tickets against one artifact at once.
10. Build with `implement` through `worker`, testing at the pre-agreed seam with `tdd`: failing test first, then only enough code to pass it.
11. Run the ticket check through `worker` or `verifier`, and close only on exit 0 with the command plus output cited.
12. Send every closed ticket to `verifier`; a fail revises the work before the next ticket starts.
13. Hand the state deltas to `historian` after each ticket so a fresh session resumes at the next frontier ticket.
14. A round is one full sweep of the frontier. If a round closes no ticket, stop and escalate: that is no progress, not a slow loop.
15. After two failures on one approach, pivot and record the trade.
16. After a pivot, three failures on the new approach — five attempts total — stop and escalate the cause plus every attempt.
17. When no frontier ticket remains, run the full gate through `worker` on the final tree — every discovered check, not the ticket checks alone.
18. "Green" means every gate exits 0 on the final tree and `verifier` ran on that same tree.
19. Close only on a `verifier` pass; a fail re-enters repair, and a self-verdict is not a verdict.

## Done

- Every ticket closed with a cited runnable check that can fail.
- The repo's full gate run on the final tree, every command cited with exit 0.
- Fresh verifier pass from an agent that did not write the work.
- Failures pivoted at two, escalated after three on the new approach (five attempts total), trades recorded.
- State written so the next session resumes at the next frontier ticket, or is done.
- Next frontier ticket named, or `none` with the gate output.

## Delegates to

- `to-spec` (vendor): conversation synthesis into a frozen SPEC.
- `to-tickets` (vendor): SPEC sliced into blocked tracer-bullet tickets.
- `implement` (vendor): ticket built with typechecks plus test runs.
- `tdd` (vendor): red-green loop rules, seams, and anti-patterns.
- Vendor skills above are optional supply: this harness denies non-local skills (`skill *`), so the procedure above stands alone — the named vendor skill is a shortcut, never a dependency.

## Never

- Never work two tickets against one artifact at once.
- Never close a ticket on a check that cannot fail.
- Never repeat a twice-failed approach; pivot, then the new approach gets three attempts.
- Never close the loop on a self-verdict; the verifier is always fresh context.
- Never widen a ticket mid-loop; re-cut and re-brief instead.
- Never call the loop green on ticket checks alone; the full gate runs last.
- Never absorb an overrun silently; escalate it.
