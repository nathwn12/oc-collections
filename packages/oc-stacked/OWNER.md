# OWNER

The owner's standing decisions for this repository, so no session re-asks them.

**Status:** standing decisions. The lead may cite these; it may not overrule them. A new decision from the owner replaces the line, and the date goes with it.

## Seats

- **Three kinds of seat.** `lead` decides and dispatches. Specialised employees build one seam each. `auditor` judges work it did not write. The owner is the CEO and is not an agent in the stack. *(2026-11-10)*
- **Employees are a standing family of specialists**, not one generic worker reused per seam. The seats are permanent; the seams are disposable. *(2026-11-10)*
- **Six seats, twenty-two role cards in seven departments.** The seats are the six agent files (`lead`, `employee`, `auditor`, `scout`, `runner`, `planner`); the cards in `roles/` name a department (Product, Design, Engineering, Platform, Quality, Knowledge, Research) and the seat that reads them. Department boundaries are card boundaries, and no department gets a lead; the lead routes directly. *(2026-11-10)*
- **The Research department answers before the seam is briefed.** A seam that turns on external behaviour routes to `researcher` or `scout` first, so no specialist guesses at an API it could have read. *(2026-11-10)*
- **The auditor is not a department.** It answers to the owner and never shares a model family with the seat that wrote the work. *(2026-11-10)*

## Work

- **Disjoint seams, up to ten concurrent, aggressively.** Ten is the ceiling from the host, not a target; a worker that cannot be reconciled is work that cannot land. *(2026-11-10)*
- **A new seam gets a fresh worker; the same seam resumes.** Context is per seam, never per session. *(2026-11-10)*
- **Every seam names its archetype.** A seam with no archetype is not finished being cut, and `ready` refuses it. *(2026-11-10)*

## Output

- **Sharp output:** result first, numbers over adjectives, `file:line` or `UNVERIFIED`, one screen. *(2026-11-10)*

## Evidence and the source hierarchy

Every claim in this repository is ranked by where it came from. The order is fixed and it never runs backwards.

1. **Upstream code and docs at the pinned version** — repository, CHANGELOG, types, tests.
2. **The specification or RFC** the behaviour claims to implement.
3. **Official guides and release notes.**
4. **Issues, discussions, gists, forum threads** — real-world behaviour, unreviewed.
5. **Local comments, README claims, remembered knowledge** — a hypothesis with a timestamp, never evidence.

**Rule:** when local and upstream disagree, upstream wins until a pinned test says otherwise, and the version checked goes in the report. *(2026-11-10)*

## Autonomy

1. A specialist does not ask what it can find: bounded research first, up to three lookups, before any gap reaches the lead. *(2026-11-10)*
2. A claim carries its source and date, or it is `UNVERIFIED` — including claims about how the code behaves. *(2026-11-10)*
3. A worker that cannot find the answer names what it looked for, so the next worker does not repeat the search. *(2026-11-10)*
4. Escalation is a routing decision: hand back a diagnosis and the recommended archetype, not an open question. *(2026-11-10)*

## Savepoints

- Commit on a green suite: a green run is a savepoint.
- Commit when a seam lands, even while others are mid-flight.
- Commit at ten changed files or thirty minutes, whichever comes first, and mark the message `savepoint:` with an honest line on what is unverified.
- Push every commit; a local savepoint is one crash from nothing.
- A savepoint is never a landing: the last commit of a pass is green, audited, and named for what shipped.

The tree must never be allowed to get dirty enough that a day of work is uncommitted. *(2026-11-10)*

## Stops

The lead stops and asks the owner for exactly five things, and no others. *(2026-11-10)*

1. An irreversible act.
2. Money above the standing cap.
3. A security-sensitive act.
4. An outward side effect that norms say you ask about — a merge, a push, a publish.
5. A request with no path: a brief so broken that every path is a guess.

## Releases

- Releases follow `RELEASING.md`; a version is tagged only after the suite is green and an auditor has passed the pass it belongs to. *(2026-11-10)*
- **Adopt the upstream format when one exists** — Conventional Commits for messages, semver for versions, the registry's own metadata schema, the host's own config schema, the project's own lint and test commands. Invent a house format only where upstream has none, and say in one line why. *(2026-11-10)*
- The current version lives in `package.json`; do not restate it here, because two copies of a version is one stale copy. *(2026-11-10)*

## Session titles

A session title is `[status] <short subject>`, and the status is one of exactly three words — no synonyms, no extra vocabulary. *(2026-11-10)*

| Status | Means | Duration |
|---|---|---|
| `[active]` | running progress; work is moving in this session | until it stops moving |
| `[parked]` | paused, stopped, frozen, or deferred; work exists but is not moving | until resumed or killed |
| `[done]` | genuinely finished: closing remarks written, session compacted, no afterthoughts | **terminal** |

1. The title always carries the status in square brackets, first, so a tab list scans by state.
2. The subject is short and names the work, not the week: `[active] oc-stacked · 24-agent org`.
3. The lead renames at every transition and logs it to the ledger as one line: `NOTE · session active -> parked: <why>`.
4. `[done]` is immutable. A done session is never renamed, never reopened under the same title, and never resumed; new work starts a new session. The fate is sealed by the closing remarks, which are final.
5. No fourth status, no colour, no emoji, no date suffix.

## Model routing

- **Three tiers, shipped unset and pinned at install.** `routing.json` is the single source: terra plans, reviews and verifies; muse covers everything that is not production code; deepseek writes production code. *(2026-11-10)*
- **The lead is always unpinned** and inherits the TUI selection. No agent file in the repository carries a `model:` line. *(2026-11-10)*

## Boundaries

- **Nothing is added to BARE, the host harness.** Every capability lives in OC-STACKED. *(2026-11-10)*
- **Naming stays as it is.** Agent files are bare names; skills carry the `stacked-` prefix. *(2026-11-10)*
