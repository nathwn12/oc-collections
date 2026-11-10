---
description: Rewrite the digest and report the top open item
agent: lead
---

# Digest

1. Call `ledger op=digest`. It rewrites `.stack/digest.md` from the ledger, the brief index, and the clock.
2. Do not hand-edit the file. If a row is wrong, the ledger line behind it is wrong: fix that and regenerate.
3. Report **Needs you** first, with each open decision and its age.
4. Report **In progress** second, with each live seam, its state, and how long since it moved.
5. Skip a section with nothing in it, but say that it is empty rather than dropping the heading.
6. Name the single next action: the one seam or decision that unblocks the most. If a live seam has not moved in six hours, that is the next action, not the owner's problem.

Return: the digest body, then one line, `Next: <action>`.

