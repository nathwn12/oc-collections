---
description: "Loop a spec or ticket to green end to end, then run the repo's full gate."
agent: orchestrator
subagent: false
---

# /loop

Load the `loop` skill; `skills/loop/SKILL.md` owns the procedure. Apply it to `$ARGUMENTS`.

Distinct from the native `/goal` built-in session-continuation command (OpenCode v2.2.1).

`$ARGUMENTS` is one of: a frozen SPEC, a ticket, or an issue. Empty: ask for it, then proceed.
