---
name: Stacked Ship
description: Use when landing a seam: committing, closing a branch, or releasing. Covers the pre-flight, the commit, the branch finish, and the one rule that survives a revert. Load on "ship it", "land this", "commit and merge", "make a release".
license: MIT
---

# The Ship

A ship is a seam that leaves the room with evidence attached. Everything before it was preparation; everything after it is a new seam.

## The seat

**The lead** lands. It runs the pre-flight, writes the commit, picks the branch verb, and says what shipped.

**The employee** never merges. It hands back a diff and a report; the branch is not its to close.

## The pre-flight

Four things must be true at the head you are landing. Not near it. At it.

- [ ] `scope` — every touched path is inside the brief's `Owns`, or the report names the exception and you approved it in writing.
- [ ] `check` — green, run by you, at this exact HEAD. A green result bound to an older SHA is a green result about different code.
- [ ] The report exists, and you have read its `Unverified:` lines. `none` is a reading; a list is a decision you are making.
- [ ] The audit verdict is in — `PASS` or `PASS WITH NOTES` from a context that wrote none of the diff.

If one is missing, it is not a ship. It is a push with a nicer name.

`ready` op=run aggregates the mechanical ones and names each reason it is not landable. It cannot read the report for you, and it cannot see a verdict nobody asked for.

## The commit

One commit per seam. Two seams in one commit cannot be reverted separately, cannot be reviewed separately, and cannot be blamed separately.

**Subject:** imperative, plain words. No ticket prefix, no agent name, no emoji. A reader in two years should know what changed without opening the diff.

**Body,** in this order:

1. What changed, and why — the reason the seam existed.
2. The check output, pasted, not summarised.
3. The `Unverified:` line, when it is not `none`.

```text
Retry the upload when the connection drops

The uploader treated a dropped connection as a permanent failure, so a
flaky network surfaced as "file rejected". It now retries twice with a
short backoff, then fails with the last real error.

Check: npm test -- upload
  upload > survives a dropped connection   ok
  upload > gives up after two retries      ok
  12 passing

Unverified: the 30s timeout path — needs a proxy I do not have locally.
```

The last two blocks are the ones people skip. They are the ones the next person needs.

## Branch finish

Read the ledger before you pick a verb. The recorded decision wins over your taste on the day; where none was recorded, this table decides.

| Situation | Verb | Why |
|---|---|---|
| Shared branch, others have pulled | merge | Rewriting what others already have is not a cleanup, it is an incident. |
| Private branch, nobody else has it | rebase | Linear history, no merge commit nobody asked for. |
| The seam's history is noise — "wip", "fix", "fix again" | squash | The seam is one idea. Ship one commit for it. |

Never rebase a branch someone else has. Never squash two seams into one commit — that is not squash, that is an un-ship.

## Release, when there is one

Not every seam is a release. When it is:

- Changelog entry under `Unreleased`, in the user's words. "Retries a dropped upload" beats "refactored UploaderClient".
- Version bump only in the files the repo designates. If you have to guess which files, that is a seam of its own.
- Tag after `check` runs on the commit you are tagging.

A version chosen before the check is a guess. A tag on an unverified commit is a promise you cannot keep.

## After a revert

When something ships and comes back out, the question is not who missed it. It is: *why did every reviewer believe it was right?* The check passed, the audit passed, the lead read the diff — and all of them were wrong in the same direction. That shared blindness is the finding.

The output is one of three things, written down before the next seam starts: a rule in this file, a field in the brief that would have forced the question, or a check that would have gone red. A postmortem with no rule was a diary entry.

Then re-open the seam with the new evidence. Not with an apology.

## What never ships

| Never | Because |
|---|---|
| A red check | You are shipping a known failure and calling it a landing. |
| A stale check | Green at an older SHA describes code you are not shipping. |
| An `Unverified` list nobody read | The reader is the only control on the claims the check could not cover. |
| A diff wider than the brief | Nobody reviewed the extra paths — not the auditor, not the brief, not you. |
| A secret, in any form | Once it is in the history it is in every clone, every fork, every cache. |
| A commit that explains nothing | The diff says what; only the message says why, and why is what gets lost. |

A revert costs less than any of these. Say so before someone argues for the shortcut.

## Voice

Result first, with the artifact named. No ceremony around the landing, no thanks for approvals, no summary of what the diff already says.

- Bad: "Landed the upload retry work — tests look good and the team is happy with it."
- Good: "Upload retry landed at 4f2c1ab. `scope` clean, `check` green at that SHA, audit PASS with one note: the 30s path stays `Unverified:` until we have a proxy. Revert is one command."
