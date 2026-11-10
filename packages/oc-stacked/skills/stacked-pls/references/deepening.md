# Pls: deepen, brief, shape or execute

Load this when deepening the goal, locking the brief, or running shape or execute.

## Deepen before you build

Take the request up one rung, then come back down to what you can finish today.

| Rung | What it means |
|---|---|
| 1 | Fix the instance |
| 2 | Remove the class |
| 3 | Prevent the class |

Rung 3 without a check is fantasy. Take the highest rung you can **finish and prove today**, and say in one line which rung you did not take and why. That is the whole of ambition: the standard rises, the permissions do not.

## Lock one brief

One falsifiable sentence. One check. The files it may touch. The exclusions, named. Then build.

- A changed request is a **new** brief, never an edit to the old one.
- Scope does not widen while you are deciding.
- "Do nothing" is a legitimate locked brief, and you say what it saves.

## Shape, or execute

Two exits, and you name which one you are taking in the first line.

- **Shape** — the ask is "help me think", "is this worth doing", "what should this be". Run the three questions and the gap sweep, deepen one rung, then produce the locked brief: outcome sentence, check, files, exclusions, the rung you did not take, and the strongest objection to the plan. Stop. Build nothing.
- **Execute** — the ask is "do it", "sort it out", "take this to green". Same brief, then the Execute section below, to a check that can go red.

Default is execute unless the ask is plainly a question. If you are unsure, shape: a brief is cheap to revise, work is not.

## Execute

1. **Failing proof first.** Write the case that must fail, run it, watch it fail for the right reason. No harness? Invent the cheapest honest check.
2. **Smallest change** that turns it green.
3. **Full check** the brief names, once, on a clean tree.
4. **Reconcile** what you changed against the brief: `scope`, then the diff.
5. **Gate** with `ready`, then land. One commit, plain words, the check output in the body.

When the first approach fails, climb the ladder instead of retrying it:

```text
configuration -> source refactor -> dependency replacement ->
architecture -> data model + migration -> vendor or fork -> replace the artifact
```

Never repeat a class that already failed. Two identical failures means the approach is wrong; a third try is not a strategy.

## The green rule

A green that is not real is worse than red.

Never make a check pass by weakening it, mocking the thing under test, silencing an error, special-casing the test, or raising a timeout until it fits. If the goal cannot be made true, `cannot be done, here is the evidence` is a valid outcome. A fabricated green is not.
