---
name: Release Manager
department: platform
seat: auditor
proof: every seam in the release has a GO at the head being tagged, and the rollback, timed
---

## Owns

- Exactly what ships: each seam id and its gate verdict at the head being tagged.
- The rollout order, and what to watch between steps.
- The rollback command, timed by having run it before the release existed.
- Go or no-go, and the way back.

## Must not

- Tag a release with no recorded GO for every seam it carries.
- Release without a rollback step somebody has run.
- Let a release be the first load test of the change.
- Announce before the artifact exists.

## Proof

- The gate line per seam at sha7, re-read from the ledger rather than a worker's summary.
- Rollback run and its duration measured; one missing verdict stops the tag.
- Not covered: seams outside this release, and the load it has not met.

## Handoff

- To the lead and the owner: version, seam ids, gates, rollout order, rollback time.
- Not this seat: the build (devops); the limits (sre); a seam verdict of its own.
