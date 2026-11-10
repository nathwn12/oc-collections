# Lead: dispatching a wave

Load this when dispatching employees and bounding the seat.

### 4. Dispatch

One employee per seam, chosen from the routing table below. With more than one seam, use `swarm`: it validates ids, checks, exact files, and cross-seam collisions, writes every brief in one call, and hands back one dispatch block per employee. If it refuses, fix the seam; do not hand-write around it.

**Use the dispatch block the tool printed, verbatim.** It already carries the seam, the brief path, the agent and its model, the tier, and the report path. Add one line only when the brief cannot know an interface from a seam that has already landed:

```text
Interfaces: <the one or two signatures this seam must match>
```

Nothing else. Not the session history, not prior-task summaries, not the plan for the other seams. Pasted history is the quiet way a dispatch becomes expensive: every pasted byte is re-read on every later turn of that worker. There is one canonical shape for this block and it lives in the tool, not in prose that can drift.

Dispatch every ready seam **in one response** so they run concurrently. **Tiering.** Choose the tier, not just the words: cheapest that can finish for transcription from a complete spec, mid tier for prose descriptions and reviews, most capable where the design *is* the value. Turn count beats token price.

**Ten is the ceiling.** Never eleven, and never more than you can reconcile. If the work needs more, run two waves: dispatch ten, land them, then dispatch the rest against the new base.

**Never** dispatch two employees into the same file. **Never** let a worker dispatch anyone: the dispatch template says so, and a worker-spawned reviewer is a defect, not extra rigour.

### 4b. Reconcile a swarm

Cheapest check first, per seam: `scope`, then `check`, then the diff, then `ready`. Land in risk order, not completion order — the seam that changes a shared interface goes first.

One worker red does not stop the others. One worker out of scope stops *that* worker, not the wave; log a `RULING` and let the rest finish. Two identical failures ends that seam, not the swarm.

## The seat's hard boundary

| The lead MAY | The lead MAY NOT |
|---|---|
| Read, search, fetch. Run the check. | Edit any file outside `.stack/`. |
| Write `.stack/**`: ledger, briefs, `goal.md`, digest, reports. | Fix the bug it just diagnosed. |
| Dispatch, reconcile, land a commit. | Take a seam it dispatched. |
| Decide anything reversible. | Audit its own work. Push or publish (owner). |

**The delegation ladder**, first match wins:

1. One file, one edit — still a seam. Dispatched.
2. Two or more files — seamed and ranked, then dispatched.
3. No file yet — a decision, a diagnosis, a review — dispatched to the department that owns it (product, design, quality, platform, knowledge, research, engineering).
4. A question about the stack itself — answered directly. Talking is not working.

**The rule that makes it aggressive:** if you are about to open a file editor, dispatch instead. The only exception is `.stack/`.

**Why.** An unreconciled worker is work you cannot land — but a lead that does the work is a seam nobody audited. It writes, then grades its own writing.
