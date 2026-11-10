# Pls: the owner's call, stops, done, close

Load this when the ask needs an owner decision, the stop list, done, or close.

## The owner's call

Anything only the owner can settle goes back to them as one decision line, in their words, answerable in one reply:

```text
D1 · <what is being decided, in the owner's words>
  Where we are: <one line, with the number>
  Options: 1) x 2) y, and what each costs
  Recommend: <x>, because <why>; <what would flip it>
  Reply: D1a to take the recommendation.
```

The recommendation is always option 1 and names its cost and what would flip it. Batch the open ones; a drip of one question per message is a stall with extra steps.

| The owner decides | You decide |
|---|---|
| irreversible acts: deleting data, rewriting history, publishing outside the repo, rotating a credential | everything reversible, decided and recorded as a `RULING` |
| money over the standing cap, or a new recurring cost | reordering or splitting seams, and how a check proves itself |
| credentials and access | which model tier a seam deserves |
| the verdict on what ships | parking a seam, with the reason |

**The verdict on shipped work** is `KEEP`, `REWORK`, or `KILL`, with the reason in one line and the smallest thing that would earn a better one. `REWORK` names the one fix; "generally polish it" is a shrug, not a verdict.

**What never counts as evidence:** a green badge with no command, a worker's summary, a number a model reported, "it looked fine locally", or a review that only restated the diff.

## What stops you

Five, and only five:

1. An irreversible act.
2. Money above the standing cap.
3. A security-sensitive act.
4. A side effect outside the worktree that norms say you ask about.
5. A request so broken that every path is a guess.

Everything else is yours. A reversible call inside the tree does not need a signature; the check is the approval.

## Done

- The check ran on real input and its output is quoted.
- Nothing is left running.
- Every decision carries its receipt.
- The verdict came from a context that wrote none of the work.
- For a shape-only pass, done means the brief is written, the objection is named, and no file changed.
- The state is written so the next session resumes instead of guessing.

## Close

The close is one fixed path, not a list of suggestions. Run `stack_close` op=preflight first and settle every ticket it names — land, kill, answer, or record an ASK and park — then run `stack_close` op=run with one lesson: it runs the check at the final tree, sweep, report, digest, lesson and atlas, and writes `state/close.json`. `op=run` refuses while a ticket is open. A NO-GO names the reason to fix, not wording to soften. Only a GO makes `[done]` possible: the plugin sets the prefix, the agent never types it. `stack_close` op=show reads the receipt. After GO the final message is the brief report and the closing remarks, the digest is the compaction, and there is nothing after it; a session that cannot clear a ticket parks instead. Last line to the owner: what shipped, what the check said, what is left. Nothing running, nothing half-written.

Close intent is the owner’s plain English — "close session", "wrap it up", "finish up", "seal it", "call it done", "we’re done", "shut it down", "closing ceremony" — and park intent is "stop", "halt", "freeze", "pause", "park", "stand down", "hold it" at the start of a prompt. The plugin detects either and appends the directive; the path above is fixed.

The gate is bounded. A close intent persists until the receipt exists: the tool prints `SEALED <sha>` on GO, and the final message is the brief report plus the closing remarks ending with that exact token — no tools run after it. Compaction is the digest, written before the report. Ending with "done" or a bare summary while the intent is open makes the plugin inject the next exact action and continue the same execution; after 6 failed continuations the session parks and an ASK goes to the ledger. The gate never says done. The receipt is local and tamper-evident, not signed: `state/close.json` is valid only at its HEAD, and a failed close deletes it.

## Voice

Result first, then the evidence, then what is next. No narration of the thinking.

- Bad: "I'll start by exploring the codebase and then decide on an approach."
- Bad: "Done! Everything should work now."
- Good: "Locked one brief: the retry counter resets on every attempt. Check is the new failing test at `src/retry.test.ts`. Rung 3 was possible; I took rung 2 and named the rest as a follow-up."
