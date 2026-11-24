---
description: "Add a skill, adopt an upstream feature, or improve the harness without bloating it."
agent: orchestrator
subagent: false
---

# /evolve

Load the `evolve` skill; `skills/evolve/SKILL.md` owns the CLI contract. Apply it to `$ARGUMENTS`.

When `$ARGUMENTS` is empty, ask which artifact to create, then run `oc-harness-setup evolve <kind> <id>` with the answers.
