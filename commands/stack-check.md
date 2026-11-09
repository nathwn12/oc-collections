---
description: Run the repo's proving checks and bind the result to HEAD
---

# Run the checks

1. Call `check op=run`. If `$ARGUMENTS` names a check, pass it as `name`; otherwise run all of them.
2. Compare the recorded head with the current HEAD. If they differ, the result is stale: say so and re-run.
3. If the tool reports no checks configured, print the `.stack/config.json` shape below and stop. Readiness without a check is `UNPROVEN`, not green.

```json
{ "checks": [ { "name": "unit", "command": "npm test", "timeout": 180000 } ] }
```

Report, in this order:

- Verdict: `GREEN` or `RED`, and the head it is bound to.
- Each failing check by name, with the real output tail.
- The one thing to fix, in one line, or `none`.

Never report a check you did not run, and never call a red result flaky after one failure.
