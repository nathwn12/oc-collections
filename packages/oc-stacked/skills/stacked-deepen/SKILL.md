---
name: Stacked Deepen
description: Use when the complaint is about the code rather than a feature — "this is hard to change", "clean this up", "why is this a mess", a module that fights every edit, or a refactor with no behaviour change intended. Starts from the code, names the seam of pain, and proves the shape got better without moving the behaviour.
license: MIT
---

# The Deepen

Every other skill in this shelf starts from a request. This one starts from the code.

That matters because the four laws point the other way: Law 3 says touch only your seam, and a codebase that has become hard to change has no seam to hold on to. This is the skill that creates one. It is not a licence to wander; it is a licence to move a boundary deliberately and prove the move.

**The seat:** the lead, or an employee dispatched with a deepen brief. Behaviour does not change. If behaviour must change, that is a feature, and it gets its own brief.

---

## When this is the right tool

| The signal | This is the tool |
|---|---|
| "Every change here touches six files" | Yes |
| "Nobody knows where this lives" | Yes |
| "This module has three jobs" | Yes |
| "We need to add a fourth job to it" | No — that is a feature with a design problem |
| "The tests are slow" | No — that is a test seam, brief it separately |
| "The code is ugly" | No — ugly is not a measurement |

The last row is the important one. "Ugly" is a feeling; "adding one field requires editing four files in three layers" is a measurement.

## 1. Read before you measure

Read the code that hurts, not the code you like. Follow one real change end to end: pick something the team did last month and count the files the diff touched. That count is your baseline, and it is the number you will beat.

Write it down in the brief as `Out: adding a field to X touches 1 file instead of 4`. A deepen with no before-number cannot fail, which means it cannot succeed.

## 2. Name the seam of pain

Not "the architecture". One seam. Candidates:

- **The duplicated decision.** The same rule is written in three places, and they will drift.
- **The leaky boundary.** A caller knows the internals of what it calls.
- **The god module.** One file that changes for unrelated reasons.
- **The implicit contract.** Two things agree by convention, and nothing tests the agreement.

Pick the one whose fix makes the other three cheaper or unnecessary. That is the whole of the ranking method; do not build a matrix.

## 3. Choose the smallest structural move

| Move | It buys | It costs |
|---|---|---|
| **Extract** a module along an existing seam | A name, and a place for the next change | One import graph change |
| **Move** a boundary inward or outward | The caller stops knowing what it should not | Every caller edits once |
| **Invert** a dependency so the policy owns the detail | Tests without the world | One interface, and the discipline to keep it |
| **Collapse** two things that were never two | Less code, fewer names | Someone's mental model breaks |
| **Delete** a layer that forwards calls | Everything | Nothing, if it truly only forwards |

One move per deepen. Two moves in one commit is two seams, and the second one will not be reviewed properly.

## 4. Keep behaviour byte-identical

- The existing tests run before and after, unchanged. If you must edit a test to make it pass, you changed behaviour: stop and reclassify.
- Where there is no test, write a characterization test **first**, against the current behaviour, warts included. Pin what is, not what should be.
- Paste both runs in the report: the suite at the old shape, the suite at the new shape, same assertions, same result.
- The public surface does not change. If it must, it is a breaking change and needs the owner's words.

## 5. Prove the shape got better

The suite passing proves you did not break it. It does not prove you improved it. Add one number:

- The file count of the change you measured in step 1, now.
- The import count into the module, now.
- The line count of the module, only if it fell for a real reason.
- The number of callers that had to know an internal detail, now zero.

One number, before and after, same method. A deepen that cannot show a number is a rearrange.

## 6. Report the shape, not the journey

```text
Outcome: adding a field to webhook delivery now touches one file, down from four.
Evidence: npm test — 61 passed, 0 failed (before and after, same assertions).
Unverified: none.
Scope: src/webhooks/*, no public surface changed.
Lesson: the retry policy and the storage schema were one module because they landed in the same week, not because they belong together.
```

## What this skill refuses

- A deepen bundled with a feature. Split it; land the deepen first.
- A rewrite justified by taste. Name the number or leave it.
- Deleting pre-existing dead code without a brief. Mention it; let someone own it.
- A structural change whose only proof is a passing suite. That proves preservation, not improvement.

## Voice

Before and after, with the number. No narrative of discovery.

- Bad: "I refactored the webhook module to be much cleaner and more maintainable."
- Good: "Webhook retry policy extracted. Adding a field: 1 file, was 4. Suite green at 61 before and after."
