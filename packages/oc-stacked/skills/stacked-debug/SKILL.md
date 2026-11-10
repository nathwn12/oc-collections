---
name: Stacked Debug
description: Use when something is broken, throwing, failing, or slow — "debug this", a stack trace, a flaky test, "it stopped working", a wrong number. Turns the failure into bytes, one hypothesis, a bisect, and a guard.
license: MIT
---

# Debug

A bug is a claim about the world that turned out false. Find the claim before you edit the code.

## The seat

You are whoever owns the broken seam: an employee holding a brief, or the lead when nothing has been dispatched yet. The prohibition is one line — **never fix what you have not reproduced.** A patch for an imagined cause is a second bug laid on top of the first.

## Capture before you reason

Get the failure as bytes before you form a theory. A theory shaped by a half-read error message costs more than the minute it saves.

| Failure | Capture |
|---|---|
| **Crash** | the exact command, its exit code, the full stderr, the top ten frames, the runtime and dependency versions |
| **Wrong value** | the input that produced it, the expected value and where that expectation comes from, the actual value, the line that printed it |
| **Hang** | the last output before it stopped, the process state, which timeout fired, the size of the input |
| **Slow path** | a timing before and after, same machine and same input, the count of whatever is slow, the profile if one exists |

```text
$ npm test -- retry
  retry budget: expected 3, got 2
  exit 1 · node 22.4.0 · 2026-11-10T09:12:41Z
```

Paste the command and the output. "It errors" is not a capture.

Capture the tree as well: the full SHA, the branch, and whether the working tree is dirty. A failure on an unpinned tree cannot be reproduced by the person you hand it to, which makes it a rumour.

## Reproduce

Reduce to the smallest input that still fails: drop fields, files, flags, and steps until one more removal makes it pass. That last removal names the cause more often than any reading of the source.

Run it twice. Twice the same is deterministic. Fails once in ten is intermittent, and it gets its own note rather than a guess. A failure that needs the network, the clock, or an order of events is not deterministic until you pin the dependency that varies.

If it will not reproduce, the bug is in the report, not in the code. Go back for the reporter's exact input, version, environment, and step order. Do not read deeper into the source until a command fails on demand.

## One hypothesis at a time

State it as a sentence that can be false. Predict what changes if it is true. Make the cheapest observation that separates true from false: one print, one log line, one query, one config toggle. Then act.

| What I think | What I would see | What I saw |
|---|---|---|
| the counter resets on every attempt | attempt 3 logs a 1s backoff | 4s backoff, counter held — wrong |
| the cache serves a stale row | clearing the key returns the right value | same value after clear — wrong |
| the request never reaches the server | no log entry for that delivery id | entry present, status 500 — wrong |

If the observation neither confirms nor refutes, the hypothesis was too vague. Restate it as something a single line of output could kill.

## Bisect

Halve the space instead of reading it: commits, inputs, config keys, layers of the stack. Establish a known-good and a known-bad endpoint, then probe the middle. Six probes settle a range of sixty-four.

When a change is the suspect and the history is bisectable, `git bisect run <check>` beats reading a diff. The check is the oracle, so keep it cheap, deterministic, and honest about its exit code. No bad commit in range means the input is the variable — halve the fixture instead.

```text
$ git bisect start HEAD <known-good>
$ git bisect run npm test -- retry
<sha> is the first bad commit
```

## Flaky is not a licence

A case that failed on its own verdict may be re-run once at the same tree. Twice is real. Weakening the assertion, raising the timeout, or adding retries edits the test, not the bug, and needs the owner's words. Say it plainly in the report: "the test passes now" and "the bug is fixed" are different sentences, and the ledger records which one you wrote.

## The fix carries a guard

The repro becomes a test that is red on the old bytes and green on the new. Paste both runs, in that order:

```text
red    npm test -- retry → 1 failed: expected 3, got 2 (exit 1)
green  npm test -- retry → 1 passed (exit 0)
```

Then run the full `check` the brief names, and `scope` to show the fix landed inside `Owns`. A fix with no red run before it is a claim, not a repair — write `Unverified:` and say so.

## Two strikes

Two identical failures of the same command mean the approach is wrong, not the command. Change the approach or route around it. Never a third identical try: it spends budget the second one already proved is wasted. Write the dead approach into the ledger so the next context does not rediscover it.

## Voice

Result first. Cause, evidence, guard, scope.

- Bad: "I've debugged the issue — it turned out to be a race condition in the cache layer. Fixed!"
- Good: "Reproduced twice: `npm test -- retry` exits 1 with `expected 3, got 2` on `fixtures/short.json`. Cause: the counter resets per attempt instead of per delivery. Guard red before (1 failed), green after (43 passed). `scope`: one file, inside Owns."
