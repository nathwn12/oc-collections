# Report: check-split

> Assembled by the lead from the worker's final summary. The worker completed the split and both runs, then hit its step limit with tools disabled before it could write this file or commit. Every number below was re-measured by the lead at the tree being committed; nothing here is transcribed on trust.

## Outcome

`scripts/check.mjs` (1,844 lines) is now a 4-line entry point plus `scripts/check/`, nine modules, 2,193 lines total:

| file | lines |
|---|---|
| `index.mjs` (runner, helpers, order) | 120 |
| `agents.mjs` | 352 |
| `content.mjs` | 322 |
| `state.mjs` | 257 |
| `exec.mjs` | 104 |
| `git.mjs` | 68 |
| `tools.mjs` | 313 |
| `gate.mjs` | 580 |
| `plugin.mjs` | 77 |

Each subject exports `register(ctx)`; the runner owns the counters, `check`/`checkAsync`/`assert`, `tmpRepo`, `commitAll`, `configuredRepo`, `runIn`, the summary line and the exit code, and calls subjects in the brief's order.

## Evidence

`node scripts/check.mjs` before the split, at `0e5b764`: `107/107 passed`.
After the split, re-measured by the lead on the tree in this commit: `107/107 passed`, exit 0.

The worker additionally machine-diffed every `pass`/`FAIL` line (name plus detail) before and after: 107 before, 107 after, zero differences. That is the assertion that matters — the count can lie, the names cannot.

## Scope

`scripts/check.mjs` and `scripts/check/**` only. Two mechanical consequences inside the guard: the CEO-ghost allowed set now names `scripts/check/agents.mjs` instead of the old monolith, and gate's fixture config comes from the shared `configuredRepo` helper. Nothing deleted, nothing skipped, no assertion weakened.

## Unverified

- No live-host load of the split tree; the suite is the only proof.
- `git.mjs` holds two assertions. That is the true size of the git subject, not an omission.

## Lesson

The worker took its baseline in the real working tree because a fresh `git worktree` at HEAD produced a spurious `106/107` — `core.autocrlf` rewrote `commands/*.md` and one assertion read the rewrite as a missing description. A verification environment that changes the bytes under test is not a baseline. Take the before-measurement in the tree you are about to edit.
