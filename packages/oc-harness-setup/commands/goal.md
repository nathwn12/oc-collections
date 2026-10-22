---
description: "Loop a spec or ticket to green end to end, then run the repo's full gate."
agent: orchestrator
subagent: false
---

# /goal

Load the `goal` skill; `skills/goal/SKILL.md` owns the procedure. Apply it to `$ARGUMENTS`.

`$ARGUMENTS` is one of: a frozen SPEC, a ticket, or an issue. Empty: ask for it, then proceed.
