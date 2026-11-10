---
name: Stacked TDD
description: Use when behaviour changes and a test surface exists — "write a test first", "red green", a new function or endpoint, a bug fix that must not return. Red watched, green smallest, refactor clean.
license: MIT
---

# TDD

A test is a claim about behaviour that a machine can settle. Write the claim first, and the code has a target instead of a direction.

## The seat

The employee, before the first production edit. The cycle is the seam's work, not a phase after it: a test written after the code describes what you built, never what was asked.

## Why red first

A test you never watched fail proves one thing — that the test runs. A suite that starts green is also what an empty assertion produces, so green is not evidence that the new code did anything. The red run is the moment you learn the case can tell the behaviour from its absence. Miss it and the case has never been shown to distinguish your fix from a no-op.

## The cycle

| Step | Allowed | Not allowed |
|---|---|---|
| **Red** | add one case that fails; read the failure message | edit production code; adjust an existing expectation to fit |
| **Green** | the smallest production change that satisfies the case | generalise, rename, clean up, or add a second behaviour |
| **Refactor** | move and rename code with the suite green before and after | change what a case asserts, or add a case |

Red must fail for the right reason: the assertion on the behaviour, not a typo, a missing import, or a fixture that is not there. If the message says `ImportError`, you have not gone red yet.

Green is the smallest change, including the ugly one. Ugly that passes lets you refactor with safety; clever that passes hides what made it pass.

Refactor with the suite green on both ends. A step that moves a case's goal is a behaviour change wearing the wrong label — go back to red.

## What a good test is

One behaviour per case. A sentence-shaped name that states the outcome, not the method: `rejects a delivery after the retry budget is spent`, never `test_retry_2`. One assertion that would fail if the behaviour were absent.

| Weak | Strong | Why |
|---|---|---|
| `expect(result).toBeDefined()` | `expect(result.status).toBe("rejected")` | defined is true for the wrong answer |
| `expect(output).toContain("error")` | `expect(output).toMatch(/retry budget exhausted after 3 attempts/)` | substring matches almost anything |
| `expect(fn).not.toThrow()` | `expect(() => fn(bad)).toThrow(ValidationError)` | "no error" is also what doing nothing produces |
| `expect(items.length).toBeGreaterThan(0)` | `expect(items.map(i => i.id)).toEqual(["a", "b"])` | a count ignores order, identity, and duplicates |

## What a good test is not

Each of these costs maintenance and returns a verdict it did not earn, which is worse than having no test at all.

- **A mirror of the implementation.** It calls the same branches in the same order, so it breaks on every refactor and passes while the behaviour is wrong. A suite that fails on refactors teaches people to update it without reading it.
- **A test of a mock.** It asserts the mock was called, which proves your wiring, not the behaviour. The collaborator can be entirely wrong and the suite stays green.
- **A snapshot of everything.** One whitespace change fails it, nobody reads the diff, and approval becomes a keystroke. It records the output, not the requirement.
- **A case that cannot fail.** No assertion, or one true under both the old and the new behaviour. It occupies the suite and reports a green that means nothing.

## The seam boundary

Test at the public edge the brief names: the function's contract, the endpoint's response, the command's printed output. Not the internals.

If the case needs three private functions and a stubbed clock to reach the behaviour, the design is telling you something — the module is too shallow or the seam is in the wrong place. Say it in the report and test the edge you have. Do not build a fixture that reaches inside.

## When there is no harness

Invent the cheapest honest check that can go red:

- a script with a fixture in and a value out
- a diff of generated output against a committed expectation
- a smoke run whose printed output proves the behaviour

Paste the command in the report so the lead can run it again. `Unverified:` is the line for anything you could not run. "I tested it by hand" is not a check, and a check that cannot go red is not a check.

## Evidence shape

Three lines in the report, pasted rather than summarised:

```text
red    <command> — 1 failed: <case> expected <x>, got <y> (exit 1)
green  <command> — 1 passed (exit 0)
check  <the brief's Check> — <n> passed, 0 failed (exit 0)
```

## Voice

The cycle is visible in the evidence or it did not happen.

- Bad: "Added tests for the new validation logic — all green!"
- Good: "`rejects a delivery after the budget` — red first (exit 1, expected `rejected`, got `queued`), green after the counter fix. Full `npm test`: 43 passed, 0 failed. `scope`: one file plus its test, inside Owns."
