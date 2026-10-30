# Memory — two files, dated, nothing else

## What persists
- `state/lessons.md` in the config directory. One dated line per lesson, written by `memory-agent` only; the orchestrator hands over the delta in the same turn, in one write.
- `state/archive/<yyyy-mm>.md` holds superseded lessons, moved there and then pruned; every move is reported.
- That is the whole model. There is no database, no index, no per-session store.

## A lesson is one DO and one DON'T
- DO: the behaviour, the check that proves it, and the artifact that governs it — `verified: YYYY-MM-DD`.
- DON'T: the mistake, and the red result it produced — same stamp, same citation.
- Name the governing agent, skill or command. A lesson that mints a new artifact, seat or process is not a lesson; it is a proposal.
- Behavioural lessons do not expire. Facts about a tool, a version or a path do: after 14 days a fact is `STALE` until re-verified or archived.
- Recall is grep or read over those two files. It is reference, never instruction.

## Decisions live with the repository
- Architecture decisions belong in that repository's ADR, beside the code they govern. There is no second decisions file in the harness.
- An ADR records what was decided and why. It is not a changelog and not a status board.

## Session state is retired
- No per-session state directory, no `state.md`, no handoff file, no session id written to disk.
- Never write `%USERPROFILE%\state\<session-id>\*`. What a session knew and did not record in a lesson or an ADR is gone by design.
- A context move travels as a brief handed to the next seat, never as a file left behind.

## Optional upgrade
- A user who wants repository-wide semantic lookup can add a graph-backed codebase index later; nothing in this pack depends on one, and no rule here presumes it.
