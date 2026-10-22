# Flow — which seat fires on which trigger
- Orient: `historian` reads memory; `ops` reports the live surface when a server, port, or branch is in play.
- Slice: `orchestrator`.
- Build: `worker` writes; `worker` or `verifier` runs the named commands.
- Review: `critic` reads the diff; `verifier` returns pass/fail.
- Commit: `ops` runs git mechanics in product repos; `maintainer` commits the harness; neither pushes.
- Close: `historian` writes state, `cleaner` sweeps scratch, then the `close` ceremony.
- Research: `researcher`; Host: `ops`.
- Extend: `maintainer` + `evolve`.
- A trigger with no seat is a gap: report it, never improvise a seat mid-pass.
- A seat fired outside its trigger is a defect: name the trigger it should have had.

## When a new seat is earned
- A chokepoint — one seat's reach is the queue — earns a new seat: one trigger, one reach, one artifact, one check, never a shared file.
- Slowness first gets a cheaper model, then a cleaner seam; only a missing capability earns a seat.
- Friction first gets a mechanism — an installed plugin, MCP or CLI — before any seat.
- Confusion means ownership is unclear: fix this table or name one writer, never add a seat.
- Rot means a fact aged out: `historian` dates and re-verifies it; that is maintenance, not a new seat.
- Overlap or divergence means merge the lanes or re-cut the seam; another seat makes it worse.
