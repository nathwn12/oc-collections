---
name: evolve
description: "Use when the user asks to add a capability, write a skill, adopt an upstream feature, or improve the harness itself — decide the smallest extension, write it in house form, wire it 1:1, verify, and record it."
---

# evolve

The harness grows by one deliberate extension at a time, never a burst.

## When to load

- "add a skill for this"
- "make the harness do X"
- "adopt this feature/pattern from upstream"
- "this should be built in"
- A repeated manual workflow that should become a skill.

## Decision order

1. Existing reference or skill first — if one already covers the job, use it; done when the covering surface is named.
2. Repeatable procedure → skill + 1:1 command; done when the procedure clears the bar below.
3. New reach class → agent seat; a new craft alone never earns one; done when the reach gap is stated.
4. Configuration → `opencode.jsonc` + doctor, no agent; done when the config change and its check are named.
5. One-off → do it as a task, add no surface; done when the task ships with proof and nothing new is wired.

## Write the skill

- One job, one trigger, one artifact, one proving check; done when all four are named in one line.
- Frontmatter `name` matching the directory and a `description` stating when to load; done when both parse.
- Body sections: When to load, Procedure (numbered, each step with its done condition), Done, Never, Examples (Good/Bad); done when every section exists.
- ≤500 lines; detail behind a reference pointer; done when the line count holds.
- Add `commands/<id>.md` with `agent: orchestrator`, `subagent: false`, body pointing at `skills/<id>/SKILL.md`; done when the command exists and points.
- Wire the `AGENTS.md` pointer and the `opencode.jsonc` skill allowlist; done when both name the new skill.
- Add a reference to `reference/README.md` if it adds one; done when the index matches the tree.
- Update README/CHANGELOG if public; done when the public surface matches.
- Do not add count edits: the doctor derives 1:1 dynamically.

## Adopt upstream

1. Name source, version, license before reuse; done when all three are stated.
2. License verdict first (digest, quote-only, reject); done when the verdict is stated before any reuse.
3. Burden test: does this remove maintenance or add it; done when the one-line verdict holds.
4. Digest to house form; never paste unlicensed code; done when the digest is house-shaped and licensed.
5. Credit source + pinned revision; pin third-party packs; done when the pin is recorded.
6. Promote by ladder: cited note → proposal → reference or skill; done when no rung is skipped.

## Adopt a user improvement request

1. Treat it as a brief: outcome, scope, exclusions, proving check; done when all four are locked.
2. A doctrine change is proposed as rule/reason/surface, never applied inline; done when the proposal states all three and stops.
3. A local preference goes to the user's config or notes, not the shipped pack; done when the pack stays generic.
4. A niche request is rejected in one line and the general form that would earn a place is named; done when the rejection plus the general form are stated.
5. Implement through `worker` for code/docs, `maintainer` for harness content; done when the right seat owns the write.
6. Verify with a fresh seat; done when the verdict comes from a seat that did not write the work.

## Verify

1. Frontmatter parses; done when the loader accepts it.
2. Name matches directory; done when they are identical.
3. Command/skill 1:1; done when neither side is orphaned.
4. The skill loads in a fresh session and its trigger is discoverable; done when a fresh session fires it.
5. Run the doctor and package gate; cite command + output; done when both are green and cited.
6. Record CHANGELOG and state; version when shipped; done when the record exists.

## Never

- Never add a skill for a one-off.
- Never a command without a skill or a skill without a command.
- Never an agent for a new craft.
- Never paste unlicensed upstream code.
- Never apply a doctrine change without a proposal.
- Never widen the pack with a niche skill — generalize or reject.

## Done

- The smallest extension is wired, 1:1, loadable, doctor-clean, recorded, and versioned when public.
