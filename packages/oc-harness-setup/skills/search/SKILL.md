---
name: search
description: Use when a question turns on a library, API, version, or current fact — research primary sources, cite every load-bearing claim, return a verdict with evidence.
---

# search

All-purpose researcher returning a cited verdict from primary sources.

## When to load

- Load on "research this from primary sources with citations".
- Load on "look this up and prove it" or "verify this claim".
- Load on "is this API still current" or "what version changed this".
- Load when a choice turns on a library, API, version, or current fact.

## Procedure

1. Pin the question: decision it supports, product plus version, what counts as answered.
2. Done when the decision, the version, and the answer bar are stated back.
3. Skip research for ordinary language or standard-library choices.
4. Stop at decidable, never at exhaustive.
5. Work primary sources only: official docs, specs, source repos, release notes, papers.
6. Prefer current versioned docs over blogs and snippets.
7. Pin the product version beside every claim it affects.
- Treat every local reference as dated: state the date it was written or read, and re-verify anything load-bearing before relying on it.
8. Follow every load-bearing claim back to the source that owns it.
9. Mark each load-bearing claim with an inline numbered marker like [1], [2].
10. Never invent a marker number; every marker resolves to exactly one source entry.
11. State dead, paywalled, or unreachable sources as such; never cite them as read.
12. Separate sourced fact from inference in the evidence section.
13. Stamp adopted knowledge with source plus pinned revision or `verified: <date>`.
14. Verify locally with the strongest runnable gate before claiming code satisfies a contract.
15. Label any claim without executed evidence UNVERIFIED.
16. Synthesize as verdict first, then evidence, then sources.
17. Keep raw reads out of the return; file the full note at `%TEMP%\opencode\<session-id>\<topic>-notes.md`; promote a finding into `reference/` only by proposal through `evolve`, never directly.

## Done

- Verdict names the decision plus its primary-source marker.
- Every load-bearing claim carries a marker resolving to the source list.
- Dead or paywalled sources are stated, never silently dropped.
- Local verification output is cited beside the claim it proves.
- The finding is filed as a cited note, and any promotion beyond a note is proposed, never applied.

## Delegates to

- `research` (vendor): investigation against primary sources plus the Markdown note. It is optional supply: this harness denies non-local skills (`skill *`), so the procedure above stands alone — the named vendor skill is a shortcut, never a dependency.

## Canon

- Search order lives in `reference/canon.md`.
- Software, AI, harness, loop, or graph work: the three preferred corpora first — Claude/Anthropic, Karpathy, Pocock.
- Any other domain: the primary source that owns the domain outranks all three.
- Tier-1 silence is named; secondary sources are labeled as secondary.

## Never

- Never cite a secondary write-up for a load-bearing claim.
- Never invent a source number or cite a source not read.
- Never claim code satisfies a contract without a local run.
- Never return raw dumps; return verdict plus evidence plus sources.

## Examples

- <example>Good: verdict cites official docs [2] plus a local `pytest -q` run. Bad: verdict cites a blog summary with no source.</example>
- <example>Good: dead upstream link reported as dead with the attempted URL. Bad: dead link cited as if read.</example>
- <example>Good: inference labeled as inference below the sourced facts. Bad: guess presented beside facts with the same marker.</example>
