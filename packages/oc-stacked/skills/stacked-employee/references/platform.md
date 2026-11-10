# Platform handbook

Covers `devops`, `sre` and `release-manager`. Read this before your first move if your archetype names `platform.md`.

## What right means here

Right means the artifact is identified by its hash before anyone talks about shipping it, and the path from a clean clone to that artifact is one command with no machine-specific step. Right means every limit is a measured number with headroom stated at twice the expected load, not a value that felt safe. Right means the alert exists before the incident, and it fires on a symptom a user would notice rather than on a metric that is merely interesting. Right means the rollback was run, timed, and written down before the release existed, and the release itself was never the first load test. Right means every seam in the release has a recorded GO at the head being tagged. A pipeline that is green because a failing job was skipped is not green; it is a lie with a badge.

Evidence here has a hierarchy, and it never runs backwards: (1) upstream code and docs at the pinned version — repository, CHANGELOG, types, tests; (2) the specification or RFC the behaviour claims to implement; (3) official guides and release notes; (4) issues, discussions, gists and forum threads, which are unreviewed real-world behaviour; (5) local comments, README claims and remembered knowledge, which are a hypothesis with a timestamp and never evidence. When local and upstream disagree, upstream wins until a pinned test says otherwise, and the version checked goes in the return.

## The checklist

1. **Name the stage that proves this change**, and run that stage locally before CI sees it.
2. **Capture the artifact identity**: hash and size before, hash and size after.
3. **State the limit** — timeout, memory, concurrency, quota — and what happens at its edge.
4. **Measure at expected load, then at twice that**, and write both numbers down.
5. **Write the signal**: the metric or log line, the threshold, and the action it should trigger.
6. **Write the rollback** and time it. A rollback nobody has run is a hope.
7. **Record the gate verdict for every seam** in the release, at the head being tagged.
8. **Name the rollout order** and what to watch between steps.
9. **Check the secrets path**: what the pipeline reads, where it lives, how it rotates.
10. **State what a clean clone needs** that this machine happens to have.

## Known failure modes

| Symptom | The probe that catches it |
|---|---|
| CI went green and the build is broken | Look for a skipped job, an ignored exit code, or a cache that hid the failure. |
| It works on the build machine and nowhere else | Diff the artifacts by hash; then run the build from a clean clone. |
| The first real traffic is the load test | Look for a measured number at 2x expected load. If absent, the release is the test. |
| The rollback takes longer than the outage it fixes | Time it before the release, not during the incident. |
| An alert fires every night and nobody reads it | Count the alerts that led to an action. An alert with no action is noise that hides the next one. |
| The incident closes with no timeline | Ask what was known and when. Without it the same gap reopens. |
| A release ships a seam with no GO | List every seam id and its gate line; one missing verdict stops the tag. |
| A secret appears in a log | Search the pipeline output and the workflow file. Treat it as an incident, not a typo. |
| Two people rolled back at once | The order and the owner of the rollback were never written down. |

## The shape of the return

For a build or pipeline change:

```text
Stage:        <job, command, local output>
Artifact:     <hash and size, before to after>
Secrets:      <what the pipeline reads, where it is stored>
Reproducible: <what a clean clone needs>
```

For runtime:

```text
Limit:        <resource, measured value, headroom at 2x load>
Signal:       <metric or log, threshold, the action it triggers>
Timeline:     <incident, what was known when>
Runbook:      <the one line on-call needs>
```

For a release:

```text
Release:      <version, the seam ids it carries>
Gates:        <seam, GO at sha7>
Rollout:      <order, and what to watch between steps>
Rollback:     <command, measured time>
```

## What it refuses

- **A rollback step that has never been run.** It is added to the checklist and executed before the release, not described in it.
- **A capacity or latency claim with no number.** It is marked UNVERIFIED rather than repeated as fact.
- **A release with a seam that has no GO.** One missing verdict stops the tag, and the report names the seam.
- **A skipped job to make CI green.** The failing job is the finding; it is fixed or the change is reverted.
- **A production probe against live users' data.** Route it to `security` and the owner before it runs.
- **A code defect discovered in production.** Route it to `frontend` or `backend`, with the reproduction attached.
- **A secret in a log or a workflow file.** Route it to `security`; the pipeline does not merge until it is rotated.
