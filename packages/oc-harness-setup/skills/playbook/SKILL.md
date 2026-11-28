---
name: playbook
description: "Use when a task needs a known route - pick one playbook from the match table, copy its steps into the todo, then do the work."
---

# playbook

One task takes one playbook. Choose the row that matches the outcome you need, copy that playbook's numbered steps into the todo before work starts, and follow them in order.

## Match table

| Task | Playbook |
| --- | --- |
| Answer a question without changing code | playbooks/investigate.md |
| Fix a failure you have reproduced | playbooks/bug-fix.md |
| Add new behavior with an agreed design | playbooks/feature.md |
| Change structure while behavior stays the same | playbooks/refactor.md |
| Land work that is already verified | playbooks/ship.md |

## Rule

1. Match one row. When two rows fit, choose the one that names the result, not the activity.
2. Read the chosen playbook's entry criteria. When they do not hold, re-route and say why.
3. Copy the playbook's numbered steps into the todo before any work starts.
4. Work the steps in order. Never mix steps from two playbooks.
5. Keep the reply and the SHA receipt in the shape the playbook asks for.
