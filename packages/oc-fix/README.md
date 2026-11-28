# oc-fix

A silent guard for a session that must not hang. It wraps every tool call with a
deadline and clamps a foreground shell timeout, so a tool cannot hold a turn for hours.

- Every tool gets a 10 minute deadline; shell and bash get 12.
- A foreground shell request longer than 10 minutes is clamped to 10, so the host
  backgrounds it instead of blocking the turn.
- task, agent and subagent are exempt: they own their own lifetime.
- An expired call throws one line naming the tool and the budget, so the failure is
  a fact in the transcript instead of a stalled turn.
- A clamped call is observable: the tool's returned result carries
  `metadata["oc-fix"] = { clamped: true, requested, applied }` alongside the
  original output. Unclamped calls return the result untouched, and primitive or
  array output is never reshaped. If a host drops the result metadata, the same
  clamp decision is logged when `OC_FIX_TRACE=1` is set.

## Shape

index.js is the wiring and the guard. No other module, no state on disk.
Tests sit in test/.

## Run

```bash
bun test .
```

Set OC_FIX_TRACE=1 to log each guard decision, including every clamp and the
mark attached to its returned result (the fallback when a host drops metadata).
