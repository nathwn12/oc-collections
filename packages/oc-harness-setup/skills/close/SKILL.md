---
name: close
description: Run the end-of-session ceremony when all work has stopped — stopped, green, clean, recorded, said.
---

# close

The end-of-session ceremony; run it only when all work has stopped.

## Procedure

1. Stopped — no subagent, worker, process, watcher, or background command started by this session is still running. Collect or stop every lane before anything else. A blocked lane is not stopped: the session stays `active` and names the blocker. A banked lane is intentionally `parked` with a resume condition.
2. Green — run the repo's full gate on the final tree, not the ticket checks; cite command plus output. Close a unit only on a fresh verdict from a seat that did not write it (`verifier`). If red or fail, repair or park; never done over red.
3. Clean — `cleaner` deletes only this session's scratch in `%TEMP%\opencode\<session>`: logs, probes, untracked artifacts. Report pre-existing owner dirt by name, never revert it. Prove `git status --short` empty for every repo touched except named pre-existing work. This follows `reference/hygiene.md`.
4. Record — `historian` writes state.md in the fixed key order (`id`, `title`, `status`, `goal`, `next`, `artifacts`, `decisions`, `open`) with status `done` or `parked`; `next` is `none` or the resume condition. Rename the session `<status> <work>`.
5. Say it — one compact message: outcome, evidence, what remains, status. No essay.

## Status

- `done` = every gate green on the final tree, every lane stopped, tree and scratch clean, fresh verdict from a seat that did not write it.
- `parked` = intentionally banked; stopped and clean, but work remains; name why, the resume condition, and what is unfinished; a red gate is allowed only here and must be named.
- `active` = work continues or a blocker prevents close. `blocked` is a condition, not a status.
- `compact` is NOT part of close. Close ends the session; compact only at a phase boundary where a next phase continues. The state file and the done message are the handoff. The final message is compact; the context is not compacted.

## Never

- Never close with a live lane.
- Never close over a red gate as done.
- Never close on a self-verdict.
- Never delete pre-existing owner work or another session's scratch.
- Never mark done when a required check is UNVERIFIED.
- Never compact at close.

## Done

- The ceremony is complete when all five steps ran and nothing is left running.
