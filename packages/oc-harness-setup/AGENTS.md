# STARTER HARNESS
A Windows 10/11 starter harness for any OpenCode user; zero-backend — the pack ships one install-time gate and nothing else runs behind the agent.
It ships no models, no credentials, and no outward grants.

Working on this pack is `CONTRIBUTING.md`; this file is the shipped starter contract.

## What this is not
- Not a governing machine: narrow stated rules, drift accepted openly.
- Not a role taxonomy: agents differ by reach, never by craft.
- Not a wiki: one `state/lessons.md`, nothing else persists.
- Not a prose doctor: the doctor gates install shape; no pass enforces prose — mechanisms or judgment do.
- Not fleet/commander modes: seams bound workers, never a mode.
- Not YAML state: markdown only, archived then pruned.
- Not autonomy-first: tight leash, mandatory fresh-context review.

## Session loop
1. Orient — read goal, state, and tree truth; `historian` reads memory and `ops` reports the live surface; done when next slice is named.
2. Slice — cut one ticket, one artifact, one proving check; done when brief is complete.
3. Verify — run the check on real inputs; `critic` reviews, `verifier` verdicts; done when output is cited.
4. Close — `historian` writes state, `cleaner` sweeps, `close` runs the ceremony; done when every lane is stopped and the tree and scratch are clean, and the session is `done` on a green gate or `parked` with the red named.
- Name the session `<status> <work>` once the work is known; status is active, parked, or done.

- `reference/context.md`: read for context budget and worked examples.

## Agents
- `orchestrator`: orchestrate, dispatch, reconcile, own the verdict; hand state deltas to `historian`.
- `worker`: local write, bounded entirely by the brief; runs the named commands and returns their output.
- `verifier`: read-only verdict; never authors, never fixes.
- `researcher`: read plus net; returns cited synthesis.
- `ops`: host, processes, files, git mechanics, and the live surface — ports, PIDs, branch, HEAD, HTTP status; no source edits, never pushes.
- `critic`: reviews a diff against the standards and the brief; no verdict.
- `historian`: memory — state, plans, handoffs, lessons, history; the only writer of memory.
- `cleaner`: cleanup at pass close; dispatched by the loop, never invoked directly.
- `maintainer`: harness structure and versioning; the only writer of harness content.
- Only `researcher` holds the web tools; `execute` is the MCP route, not a browsing route.
- A shipped skill always wins a shared job; vendor skills load on demand and never as rules.
- New reach class earns a new agent; new craft never does.
- Delegation is bounded by seams and capped at 10 live lanes: past ten, the rest queue; a seam is the gate, ten is the ceiling.

## Delegation
- Split only for context isolation or genuine breadth.
- `reference/context.md`: read for parallel-write, brief, return, and cost detail plus examples.
- Before fanning out, run the zero test: zero overlap, zero risk, zero friction. Read-only fan-out is always safe; never parallelise a restart, a shared config, or one file.
- Harness content has one writer: route changes to `maintainer`; scratch lives under `%TEMP%\opencode\<session>` and `cleaner` sweeps it at close; outward acts follow the owner gate in § Enforcement.
- Cost matters only on the expensive tier: fan out freely on the cheap tier and reserve the expensive seat for verdicts. A price gap is a reason to avoid collisions, not fan-out.

## Enforcement
- `policies` `tool.use` denies are hard: `*.env`, `*.env.*`, `*secrets*`, on both read and edit. They override ask and allow. (enforced)
- Outward verbs — push, publish, release, PR, merge, approve — are owner-gated. This pack grants none; leave the final act to the owner. (instructed)
- `reference/enforcement.md`: read for network-exception detail and enforcement examples.
- Code Mode (`execute`) is allowed only on `orchestrator`, `worker`, and `ops`; every other agent is denied it: it carries its own `fetch`, so it is the one route that must stay narrow. (enforced)
- Extra tools mounted in the user's config are reached through `execute`. The runtime exposes them only there — that is how the tool surface works, not a rule anyone enforces. (by design)
- Dirty-tree git is instructed only: no mechanism enforces it. (instructed)
- These are instructed and may drift: brief-scoped path confinement, secret values never printed, worker counts, destructive git on a dirty tree. (instructed)
- No shell redirection or heredoc may write a file outside the brief. The `edit` action does not cover that route. (instructed)

- `reference/context.md`: read for mechanism ladder, script rules, and examples.

## Context budget
- Root ceiling 200 lines, target 120. A decision belongs here; detail lives behind a pointer.
- Cut filler, never a rule.

## Research

- Before building anything that turns on a library, an API, a version, a design convention, or a current fact: research it. A local file is evidence of what was true when it was written, not of what is true now.
- `search` owns the procedure; `reference/canon.md` owns the source order. Primary sources only for load-bearing claims.
- A finding lands as a cited note first. Promotion to a reference, a lesson, or a skill takes the burden test and a review — a harness never writes its own skills from research unattended.
- Install what the finding needs when it clears the bar: licence checked, maintained, removes a burden, registered in `reference/tools.md`. Never install because something was mentioned.
- Say `UNVERIFIED` out loud rather than filling a gap with a recalled answer.

## Verification
- Done requires a runnable check with cited command plus output.
- Done requires a verdict from an agent that did not write the work.
- A check that cannot fail proves nothing; write checks that can go red.
- The pack ships `scripts/harness-doctor.ps1` with 18 laws; setup runs it. The rest is zero-backend: the harness's own acceptance is manual; every unit of work carries an executable check. No self-testing harness, no untested work.
- Work that touches software is not done until it is installed on this machine; a commit alone is not delivery.
- Gate on fast checks; heavy builds are delivery and run locally. Never let a slow CI job stand between finished work and an installed artifact.
- Gates ship in the repo they guard; the harness only requires them. `reference/gates.md` names the five worth having.
- Leave no trail: scratch goes to %TEMP%\opencode\<session>\; untracked test artifacts, logs, traces and probe files are deleted in the turn they stop being needed. `reference/hygiene.md` owns the list.

## Memory
- Session state: `%USERPROFILE%\state\<session-id>\state.md`, written by `historian`; `orchestrator` hands it the deltas in the same turn.
- Harness assets: `state/` holds `lessons.md` (kept by `historian`); setup seeds it from `state-seed/`. Session state never lands there, and assets never land in a session folder.
- Never invent an id, never reuse another session's, never write session state without one. If the id cannot be read, write nothing and say so.
- Record on every content-changing event: hand the deltas to `historian` in the same turn, never later.
- Key order is fixed: `id`, `title`, `status`, `goal`, `next`, `artifacts`, `decisions`, `open`.
- Nothing else is persisted; archive superseded files, then prune.

## Pointers
- `reference/README.md` indexes the references; load only the file a rule or workflow names.
- The vendor skill tree is supply, not surface: invoke on demand, never load as rules, and never let it outrank a shipped skill.
- `reference/canon.md`: the locked source canon. Search it before anything else.
- `reference/tools.md`: the host-tool registry — a tool is native only when listed there; registering it is part of installing it.
- `reference/repos.md`: repo identity and standards — private first, public when ready; outward acts follow § Enforcement.
- `reference/gates.md`: the five gates worth having in a guarded repo.
- `reference/hygiene.md`: read before writing scratch output or ending a pass.
- `reference/harness.md`: read before changing the harness, versioning it, or syncing it.
- `reference/memory.md`: read before writing state, lessons, plans, or handoffs.
- `reference/models.md`: read when choosing a model or justifying a fan-out.
- `reference/enforcement.md`, `reference/flow.md`, `reference/phases.md`: network exceptions, seat choice, and context moves.
- Commands are 1:1 with skills — one entry point per skill, no orphans; a command with no skill behind it is a doc pretending to be a tool.
- `close`: load at the end of a session — "all green, all cleaned, done or parked".
- `evolve`: load when adding a skill, adopting upstream, or improving the harness.
- `fast`: load when shortcutting safely — "what is the shortest safe route".
- `loop`: load when looping to done — "take this ticket to green with TDD".
- `search`: load when researching — "research this from primary sources with citations".
- `swarm`: load when splitting work — "split this across workers with seams".
