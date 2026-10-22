---
description: "Run the end-of-session ceremony when all work has stopped — stopped, green, clean, recorded, said."
agent: orchestrator
subagent: false
---

# /close

Load the `close` skill; `skills/close/SKILL.md` owns the procedure. Apply it to the current session.

When a lane is live or a blocker prevents close, close does not run: name the blocker and stay `active`. A red gate is repaired, or the work is explicitly `parked` with the red named.
