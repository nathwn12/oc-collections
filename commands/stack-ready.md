---
description: Gate a seam for landing
---

# Gate a seam

Seam: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask for the seam id, or run `brief op=list` and show the live ones.

1. Call `ready` with that seam id. The gate never merges anything; it names what is wrong.
2. If the verdict is `GO`, restate it in one line: what lands, at which head, on which check.
3. If the verdict is `NO-GO`, list every failing reason as a numbered action. Each action names the file, the command, or the artifact that fixes it.
4. Never soften a gate. "Should be fine", "probably green", and "just needs a rebase" are not verdicts.
5. Do not re-run the gate until at least one reason has actually changed.

Return exactly:

```text
GO | NO-GO, seam <id> at <sha7>
1. <the first thing to fix>
2. <the next>
```

A gate that always says GO is not a gate.
