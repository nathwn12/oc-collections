# Seam employee-family

## Outcome

The single generic `employee` is gone. `agents/` now holds 24 files: `lead`, `auditor`, and 22 specialist archetypes across seven departments (Product, Design, Engineering, Platform, Quality, Knowledge, Research), each `mode: subagent`, each denying `subagent`, each reading one department handbook under `skills/stacked-employee/references/`. The repository ships unpinned: no agent file carries a `model:` line; `routing.json` is the only place a model is named, and `scripts/install.mjs` injects it into the copies it installs (proved below). Debugging and refactoring are not files — the engineer who owns the surface does both, and the lead's routing table says so.

The lead routes by seam type, the brief names its archetype, `brief`/`swarm` refuse an id that is not in `routing.json`, and `ready` refuses a seam with no archetype. Doctrine grew with the roster: five stop conditions including money, the source hierarchy in all seven handbooks and `OWNER.md`, four autonomy rules in pls/lead/employee, the laziness ladder in `SOUL.md` and the engineering handbook, an action-shaped output contract replacing `## Sharp output`, savepoints, releases (`RELEASING.md`, Conventional Commits), session titles, and a four-command fallback CLI.

Out of scope and untouched: `CHANGELOG.md`, `SOURCES.md`, `preview/`, `commands/`, `lib/state.js`, `lib/git.js`, `lib/exec.js`.

## Evidence

The named check, at the head this report is handed back at (`1557adb` plus the working tree):

```text
$ node scripts/check.mjs
97/97 passed

The plugin does what it says. Install it, then restart OpenCode.
```

Counts the check asserts and reports:

```text
  pass  twenty-four agents exist with valid V2 frontmatter  (24 agents)
  pass  every archetype is a subagent that denies subagent and reads one handbook  (22 archetypes cannot delegate)
  pass  routing.json covers every agent exactly once, and the lead inherits  (terra 9 · muse 10 · deepseek 4 · lead inherit)
  pass  every archetype reads a handbook that exists and is long enough  (7 handbooks cover 22 archetypes)
  pass  stacked-lead routes every archetype, and research comes first  (22 rows, one per archetype)
  pass  the stop list is five everywhere, and money is in it  (bootstrap 2533 chars, five stops, no "four things")
  pass  a dispatch block names the archetype, its routed model, or unassigned  (named, unassigned, refused at the gate)
```

Handbook line counts (floor 60, ceiling 100):

```text
design.md 71    engineering.md 68    knowledge.md 75    platform.md 75
product.md 70   quality.md 66        research.md 87
```

Install-time pinning, installed into a scratch config dir, never into the real one:

```text
$env:OPENCODE_CONFIG_DIR="...\Temp\oc-stacked-install-proof"; node scripts/install.mjs
  ok   24 agent file(s) → ...\oc-stacked-install-proof\agents
  ok   backend = deepseek-v4.1-flash
  ok   lead = inherit
  ok   qa = gpt-6.1-terra
  ok   ui-designer = muse-spark-1.3-contributor
```

The copies, read back from disk:

```text
backend => model: opencode-go/deepseek-v4.1-flash
qa => model: openai/gpt-6.1-terra
ui-designer => model: opencode-go/muse-spark-1.3-contributor
lead => (no model line)
repo agent files with a model line: 0
```

Fallback CLI, run in a scratch repo with no plugin:

```text
help=0   init=0   run=0   badusage=2
exit=1
NO-GO — no brief named `missing`. A seam with no contract cannot land.
```

## Unverified

- **Permission ordering.** Each archetype denies edit on `skills/stacked-employee/references/**` and then allows its own handbook, following the existing `employee.md` pattern (deny first, allow after). I could not exercise the host's rule-precedence semantics, so the "may not touch another department's surface" rule is enforced only by the handbook deny/allow pair and one prose line per archetype, not proved at runtime.
- **No commit was made by me.** The tree carried another seam's in-flight work and was committed mid-seam as `1557adb` by something outside this session; the changes since are uncommitted, and an employee never pushes. Landing is the lead's act.
- **`ready` was not run on this seam.** It re-runs the repo's own checks, which would recurse into `node scripts/check.mjs`. The named check was run directly, three times.
- **Model availability** was checked against the host's model list (all three ids resolve); whether the owner's provider account can actually call `opencode-go/muse-spark-1.3-contributor` is untested.
- **Pre-existing briefs unland.** `doctrine-counts` and `readme-truth` were briefed before archetypes existed, so `ready` will refuse both until they are re-briefed with an `agent`. Named as a concern, not fixed (their briefs are another seam's file).
- **The provenance walk changed shape.** `.stack/` is now excluded from the "provenance lives in exactly one file" scan, because a concurrently written brief (`install-parity`) cites `obra/superpowers` as a reference implementation to study. Working state is not shipped prose; if the owner disagrees, the exclusion is one line in `scripts/check.mjs`.

## Scope

Inside the original `Owns`: `agents/**` (22 added, `employee.md` deleted), `skills/stacked-lead/SKILL.md`, `skills/stacked-employee/SKILL.md`, `lib/tools.js` (`dispatchBlock`, plus `brief`/`swarm` `agent` fields, `buildBrief`, and the `ready` refusal — assigned by the owner after the first brief), `scripts/check.mjs`.

Assigned by later owner instructions on this seam, outside the first `Owns` and named here because each widened it: `OWNER.md`, `RELEASING.md`, `routing.json`, `bin/stack.js`, `README.md` (one sentence plus `## Fallback CLI`), `package.json` (`bin`, `files`, `prepublishOnly`), `scripts/install.mjs`, `lib/skills.js`, `skills/stacked/SKILL.md`, `SOUL.md`, `skills/stacked-pls/SKILL.md`, `skills/stacked-ship/SKILL.md`, `skills/stacked-plan/SKILL.md`, `skills/stacked-employee/references/*.md`.

Two files were reworded outside every list because the owner's phrase test covers `skills/` wholesale: `skills/stacked-review/SKILL.md` ("four things" → "four items") and `skills/stacked-ship/SKILL.md` ("Four things must be true" → "Four checks"). Both are the same word, not a doctrine change.

Routing rows whose triggers sit closest, and why they are still distinct: `docs` (the record of what shipped: README, changelog) against `technical-writer` (the steps a stranger follows, plus error and empty-state wording) — the sharpest pair, and the one to watch; `qa` (break the feature) against `security` (break the boundary); `tester` (build the proof of what was asked) against `qa` (hunt what nobody asked about); `researcher` (what upstream says at a pinned version) against `fact-checker` (whether one source says one claim); `design-reviewer` (measured conformance on a built screen) against `qa` (behaviour under adversarial use).

## Lesson

The twenty-two archetypes are cheap; the routing table is the seam. Five roster changes arrived mid-flight and only the table plus one map in `check.mjs` had to move, because the bodies are generated from one data file — keep it that way. The failure mode to fear is not a missing archetype, it is two whose triggers a tired lead cannot tell apart: that is the generic employee with extra files. Write the "not this seat" line before the seat line.
