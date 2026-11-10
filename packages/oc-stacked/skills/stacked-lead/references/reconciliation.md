# Lead: reconciling reports

Load this when an employee report comes back.

### 5. Reconcile

Read the report **before** you read chat. Then verify, in this order:

1. `scope` with the seam id — every touched path inside `Owns`.
2. `check` — re-run the cheap check yourself at the head you intend to land.
3. Read the diff against `Out`. Not the summary: the diff.
4. `ready` with the seam id — the gate names every reason it is not landable.

Then answer each `Unverified:` line yourself or accept it in writing. A report whose unverified list you did not read is a report you did not read.

**When the report comes back wrong** — `BLOCKED`, `NEEDS_CONTEXT`, or a check that will not go green — classify before you act:

| Signal | Response |
|---|---|
| Brief was incomplete | Fix the brief, re-dispatch. The failure is yours, say so. |
| Two failures of the same command | The failure is structural. Change approach or route around it; do not retry a third time. |
| Out of scope discovered | New seam. Brief it. Do not widen the open one. |
| Design wrong | Kill the seam, log `RULING`, and re-cut. A wrong design carried to green is the most expensive outcome available. |
