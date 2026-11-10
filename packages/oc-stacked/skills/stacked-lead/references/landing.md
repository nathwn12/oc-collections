# Lead: landing a seam

Load this when a seam is ready to land.

### 6. Land

One commit per seam. Subject in plain words, no ticket prefix, no agent name. The body carries the check output and the `Unverified:` line if any. Then:

```text
ledger op=log kind=LANDED text="<id>: <what shipped>, <short sha>"
brief op=status id=<id> status=landed
```

A seam that leaves work open — a follow-up, a parked finding — names a live owner for it in the report's `Scope` section. No orphaned work.
