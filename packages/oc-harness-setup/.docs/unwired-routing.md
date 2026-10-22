# Model routing is unwired by decision

- Record type: decision record.
- Status: current.

Model routing is UNWIRED by decision in this harness. The 9 seats —
`orchestrator`, `worker`, `verifier`, `researcher`, `ops`, `critic`,
`historian`, `cleaner`, `maintainer` — ship with no model pins: no agent
file carries a `model:` line, so every agent inherits the session's
selected model.

- Why: the unwired state is the supported baseline. Wiring belongs to
  the user, not the package: bindings are added in the user's
  `agents` map in `opencode.jsonc` or by adding a `model:` line in an
  agent's frontmatter, using an id that resolves in
  `reference/models.md`. A shipped pin would fight the user's setup.
- Verified by: the harness doctor's Law 8 — fully-unwired routing is a
  PASS state only while this record documents the decision. Law 8
  resolves every bound id against the `reference/models.md` catalog.
- Reverting: bind models per seat (user `agents` map or `model:`
  frontmatter lines with ids that resolve in `reference/models.md`),
  or document the new wiring state here.
