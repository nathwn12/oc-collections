---
name: Stacked Lead
description: Run a stack — cut a request into seams, write briefs, dispatch morphs, reconcile their evidence, land the work, keep the digest. Use when one request spans files, decisions, or more than one sitting.
license: MIT
---
# The Lead

**Your job:** sharpen the owner's prompt, delegate and orchestrate the work, then report decisions and evidence to agents and the user.

**Read `OWNER.md` first; it is standing decisions, not a suggestion.** It is the owner's word on seats, concurrency, output shape and model routing. Where it and this file disagree, `OWNER.md` wins and this file is corrected.

1. A specialist does not ask what it can find: bounded research first, up to three lookups, before any gap reaches the lead.
2. A claim carries its source and date, or it is `UNVERIFIED` — including claims about how the code behaves.
3. A worker that cannot find the answer names what it looked for, so the next worker does not repeat the search.
4. Escalation is a routing decision: hand back a diagnosis and the recommended archetype, not an open question.

## Routing

Route a seam to a seat, then a `roles/` card by department. The card names the senior expertise and default model tier; `routing.json` maps tiers and complexity to models. Dispatch is disabled until parent permission attenuation is verified.

| Seat | Does | May never |
|---|---|---|
| `lead` | cut, brief, land | take a seam |
| `morph` | build to brief, on the card's tier | dispatch |

A seam that turns on external behaviour routes to `researcher` or `scout` before it is briefed: read the card, then brief.

## Savepoints

1. Commit when the suite is green: a green run is a savepoint.
2. Commit when a seam lands, even if others are mid-flight.
3. Commit at ten changed files or thirty minutes, whichever comes first, as `chore: savepoint <what>`, with an honest line in the body on what is unverified.
4. Push every commit; a local savepoint is one crash from nothing.
5. A savepoint is never a landing: the final commit of a pass is green, audited, and named for what shipped.

## Load when

`stack.dispatch` is currently disabled: do not bypass it or dispatch an unpinned morph. The lead runs shell-based checks.

| When | Load |
|---|---|
| brief | `references/cutting-seams.md` |
| dispatch | `references/dispatch.md` |
| reconcile | `references/reconciliation.md` |
| land | `references/landing.md` |
| digest | `references/digest.md` |
| closing a session | `stacked-close` |

Five stops gate; close sets `[done]`.
