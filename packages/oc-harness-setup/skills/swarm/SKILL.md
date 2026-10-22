---
name: swarm
description: Use when work needs splitting across workers with clean seams — cut disjoint briefs, dispatch them together, integrate behind one fresh verifier.
---

# swarm

Split work across workers with clean seams; integrate behind one fresh verifier.

**When to load**
- "split this across workers with seams"
- "fan this out"
- "run these in parallel"

## Before you fan out — the zero test

Three questions. All three must be yes, or the split is wrong.

- **Zero overlap** — does every worker own a disjoint file set? If any two share a file, a branch, or a PR, they are one worker. Seams that touch are not seams.
- **Zero risk** — can any worker restart a service, edit shared config, or touch a running process? If yes, serialise that one and fan out around it.
- **Zero friction** — can each worker return a summary the parent can reconcile without reading raw output? If not, the brief is too vague, not the worker too weak.
- List live lanes before you cut seams: `opencode api GET /api/session/active`. A lane past its brief is stopped before a new one starts, and two lanes never share a file.
- **Zero divergence** — every lane works from one frozen brief. A changed brief is a new lane, never an edit to a running one.
- **Ten lanes, not eleven** — ten live subagents is the ceiling; past ten the work queues. A seam is the gate; ten is the ceiling.

Read-only fan-out — research, audits, surveys — is always safe, because reads cannot collide. Write fan-out needs an integration point and a fresh verifier before it closes.

1. Split only for context isolation or genuine breadth; never for speed alone.
2. Refuse the split when one context holds the breadth honestly.
3. Cut one seam per worker across disjoint file sets.
4. Admit a worker only with its own seam, its own artifact, and its own check.
5. Grant one write lane per artifact; parallel reads go free.
6. Allow parallel writes only across disjoint file sets.
7. Hold every parallel write behind one integration point.
8. Assign a fresh verifier to each integration point.
9. Refuse overlapping write sets; re-cut the seams first.
10. Name the integration point in every brief it serves.
11. Route network-dependent seams through the researcher; a seam that downloads a named artifact goes to ops.
12. Cap the fan-out to the seams the work actually has.
13. Send independent seams out together, never staged in waves.
14. Brief each worker with objective, output format, tool/source guidance, task boundaries.
15. State the objective as one checkable sentence.
16. State the output format as summary plus `file:line`.
17. Name the allowed tools or sources in the brief.
18. Bound the brief to one artifact, one proving check, one return budget.
19. Forbid the worker from widening the brief or delegating again.
20. Demand the return as a summary plus `file:line` anchors.
21. Keep raw reads in the child; never paste bulk context upward.
22. Treat a return without anchors as failed; ask once, then re-cut.
23. State the cost up front: multi-agent runs cost ~15x single-chat tokens.
24. Spend that cost on isolation and review, never on parallel writes to one file.
25. Reconcile every return at the integration point before verdict.
26. Close on the fresh verifier's verdict, never the author's word.
27. Report the cost beside the verdict at close.
28. Treat a silent worker as a failed return; re-brief once, then re-cut.
29. Record state naming each worker's seam plus its check output.
30. Collect or stop every worker before closing.
31. Done when seams are disjoint, briefs carry all four fields, and the verdict is cited.

**Never**
- Never put two writers on one artifact.
- Never dispatch without the four-field brief and the return contract.
- Never merge parallel writes without a fresh verifier at the integration point.
- Never spend the 15x token cost on work one context does alone.

**Examples**
- <example>Good: two disjoint packages build in parallel, then merge behind one verifier. Bad: two workers editing one file at once.</example>
- <example>Good: forty-file sweep returns a summary with `file:line` pointers. Bad: pasting forty files into the parent trace.</example>
- <example>Good: overlapping seams get re-cut before dispatch. Bad: dispatching overlapping briefs hoping the merge sorts it out.</example>
