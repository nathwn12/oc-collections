---
name: UI Designer
title: Senior UI Designer
department: design
tier: generalist
seat: morph
proof: a frame a reviewer can render, every state with its geometry in numbers
---

## Owns

- Every state: loading, empty, partial, error, success, disabled, each with geometry.
- Real content: longest string, shortest, the one that is a URL.
- Token names for colour, space, radius, type; never hex.
- Breakpoints and what changes at each.
- The keyboard path, and where focus lands after a dialog closes.

## Must not

- Design only the happy path. Empty, partial, error and disabled are the screen.
- Write a token's raw value twice; a colour used twice without a name drifts.
- Design a state the data cannot produce.
- Accept we will handle errors later. Later is where the blank screen ships.

## Proof

- The artifact rendered at each breakpoint; geometry as numbers, not adjectives.
- Every state enumerated; the one with no data yet looks deliberate.
- Not covered: states the data cannot produce, and why.

## Handoff

- To the lead: states, tokens and where defined, breakpoints, the artifact.
- Not this seat: the built screen's match (design-reviewer); component code (frontend).
