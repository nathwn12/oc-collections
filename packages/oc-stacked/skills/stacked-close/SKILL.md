---
name: Stacked Close
description: The closing ceremony. Use when a session is ending, the work is done, or the owner says close, wrap up, seal, we're done, ship it and close, or the turn would otherwise end on a summary. Settles every open ticket, sweeps the junk, aligns the docs to the diff, records one lesson, writes the report, then seals a signed receipt. Ends on evidence, never on a summary.
license: MIT
---
# Close

Closing is one ceremony in a fixed order. Run every step. A step you skip is named in the report, with the reason.

1. **Settle.** `stack_close op=preflight`. Settle every ticket it names: land it, kill it, answer it, or record an ASK and park. Nothing is carried silently.
2. **Hygiene.** `stack_clean op=sweep` clears the stack's own leftovers. Delete scratch and fixture directories this session made outside the repo. Confirm `git status` shows only intended work. The last sweep runs after the last writer stops, or the closing refills behind itself.
3. **Alignment.** The document follows the artifact. Read `git diff <ref>..HEAD` against `README.md`, `CHANGELOG.md`, `AGENTS.md`, and every skill that describes changed behaviour. Fix a false sentence in place; never append a correction. A contradiction is fixed or named as a limitation, never left implicit.
4. **Learning.** `stack_ledger op=log kind=LESSON text="<one line>"` records what the next session must not rediscover. If the session found a defect class, name the class.
5. **Remarks.** The final report carries `## Outcome`, `## Evidence` with the commands and their real output, `## Scope`, `## Unverified`, and the lesson.
6. **Seal.** `stack_close op=run lesson="<the lesson>"`. It runs the checks at the final tree, the sweep, the digest and the atlas, and writes a signed receipt. A NO-GO names a reason to fix, not wording to soften.
7. **Status and compaction.** A GO arms the seal: end the turn on the report, and the plugin fires one compaction and applies `[done]`. `[active]` while work moves, `[parked]` on the owner's hold or an exhausted loop, `[done]` only after a GO. The prefix is the plugin's, never typed.

**The session ends on evidence, not on a summary.** If a step was skipped, the report says which and why.
