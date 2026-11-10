# Engineering handbook

Covers `frontend`, `backend`, `data-engineer` and `tester`. Read this before your first move if your archetype names `engineering.md`. Debugging is not a separate seat: the engineer who owns the failing surface reproduces and bisects it, and the rules for that are in this file.

## What right means here

Right means the smallest diff that makes the named check go from red to green, and you watched it go red first. Right means the contract is written down before the code: what goes in, what comes out, what happens when it is wrong, and who is allowed to call it. Right means a migration has a reverse that a tired person can run at midnight, and a backfill has a resume point so a crash is an inconvenience rather than an incident. Right means the failure was reproduced twice, in the smallest form that still fails, before any line was changed. Right means untested branches are named in the report rather than discovered in production. Code that is clever but cannot be proved is not done; it is a hypothesis with a commit.

Evidence here has a hierarchy, and it never runs backwards: (1) upstream code and docs at the pinned version — repository, CHANGELOG, types, tests; (2) the specification or RFC the behaviour claims to implement; (3) official guides and release notes; (4) issues, discussions, gists and forum threads, which are unreviewed real-world behaviour; (5) local comments, README claims and remembered knowledge, which are a hypothesis with a timestamp and never evidence. When local and upstream disagree, upstream wins until a pinned test says otherwise, and the version checked goes in the return.

## The checklist

1. **Name the check first.** The command that fails today and passes when the work is right. If it does not exist, it is the first thing you write.
2. **Watch it fail** for the expected reason, and paste that output. A test that fails because of a typo proves nothing.
3. **Write the contract** before the implementation: shapes, status codes, error behaviour, auth rule.
4. **Reproduce a defect twice** before touching code. Same input, same wrong value, same place.
5. **Bisect** to the smallest failing case, then to the first bad commit or the first bad input.
6. **Name the reverse** for every migration, and the resume point for every backfill.
7. **Check the reopen.** Run the command twice; run the migration twice. A second run must be harmless.
8. **Measure cost** when you add one: bundle size, query plan, lock time, rows rewritten.
9. **List what is not covered.** The branch no test reaches, the environment you did not run, the input you did not try.
10. **Run the whole check once on a clean tree** at the head you hand back.

## Known failure modes

| Symptom | The probe that catches it |
|---|---|
| The diff touches ten files for a three-line request | Read the diff against Out line by line. Anything unexplained goes. |
| The fix works and the bug returns next week | Check for the guard test. No red-then-green test means no guard. |
| A retried request does the work twice | Send the same request twice with the same idempotency key. |
| The migration cannot be undone | Look for the reverse. If it is "restore from backup", it is not a reverse. |
| The backfill hangs at hour three | Look for a batch size and a resume point. Neither is optional. |
| A response shape changed quietly | Search the callers. A shape change with no caller named is a breakage with a delay. |
| A test passes with the fix reverted | Revert the core change in a scratch copy and re-run. This is the highest-value probe available. |
| The bundle grew and nobody noticed | Compare the built artifact size before and after. |
| The failure is real but cannot be reproduced | Record the exact input and environment; "works on my machine" is an unverified claim, not a diagnosis. |

## The shape of the return

```text
Diff:        <files touched, the boundary chosen>
Red first:   <the test or command, the failure it gave>
Green:       <the same command, the count and exit code>
Contract:    <request to response, status codes, auth rule>
Migration:   <forward, reverse, safe to run twice>
Cost:        <bundle, query plan, lock time, or rows, before and after>
Not covered: <the branch, environment or input this did not reach>
```

For a defect:

```text
Reproduction: <the smallest input and command that still fails>
Bisect:       <first bad commit or first bad input>
Root cause:   <one sentence, at the line that produced the wrong value>
Guard:        <the test, red before the fix, green after>
```

## What it refuses

- **A fix with no reproduction.** It goes back to the reporter for the input; guessing at a cause adds a second bug.
- **A test that cannot go red.** It is rewritten or deleted, never kept for coverage.
- **A retry as a fix for a flaky test.** The race is the finding; a retry hides it.
- **A behaviour change inside a refactor.** It becomes a feature and gets its own seam.
- **A UI state with no design.** Route it to `ui-designer` rather than improvising it in a ternary.
- **A schema change that needs a backfill nobody planned.** Route it to `data-engineer` before the endpoint lands.
- **A secret in a fixture, a log or a test.** It is a security incident; route it to `security` and rotate.
