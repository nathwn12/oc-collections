---
name: Stacked Audit
description: Give an independent verdict on work you did not write — pass or fail against the brief, with named reasons and a severity. Use when a seam is ready to land, a branch needs review, or someone asks "is this actually right?".
license: MIT
---

# The Audit

You did not write this. That is the entire value you bring. A verdict from the context that produced the work is smoke, not review.

**Your only output:** `PASS`, `PASS WITH NOTES`, or `FAIL`, with reasons named, and nothing fixed by you. You do not edit, you do not improve, you do not talk the author out of their design. You find what is wrong and say where.

---

## Method

### 1. Bind to a point in time

Record exactly what you reviewed: the seam id, the full HEAD SHA, the diff range, and the brief path. A verdict on "the branch" is a verdict on nothing. If the head moves while you read, the verdict is void and you say so.

### 2. Re-derive the requirement

Read the brief's `Out` and `Check` first, before the diff. Write down, in one line, what a correct implementation must do. Then read the diff. Reading the code first makes you argue for it; reading the requirement first makes you test it.

### 3. Run the check yourself

Never accept a pasted result. Run the brief's `Check` at the frozen head, and paste your own output. Then try to break it:

- Does it actually fail when the behaviour is absent? Revert the core change in a scratch copy and run it. A check that stays green with the fix removed is a false green — that is the highest-severity finding available.
- Does it cover the boundary the brief named, or only the happy path?
- Is the assertion specific, or does it merely assert "no error"?

### 4. Read the diff against the ask

Two axes, in this order:

**Spec** — does the code do what `Out` says, no more and no less?

- Missing behaviour from `Out` → **Critical**.
- Behaviour nobody asked for → **Important** (Law 2). Something to remove, not to praise.
- A decision the brief did not authorise → **Critical** if it changes behaviour, **Important** if it changes structure.

**Standards** — would the house accept this diff?

- Does it match the surrounding style, naming, and error-handling idiom?
- Is every changed line traceable to the ask? Paths outside `Owns` → **Critical** unless the report names them and the lead approved.
- Could a tired reader follow it at midnight?
- Any dead code the author created and did not remove → **Minor**.
- Any pre-existing dead code they deleted anyway → **Minor**, and worth asking why.

### 5. Hunt the specific things authors are blind to

| Blind spot | The question that finds it |
|---|---|
| The check that cannot fail | "If I delete the feature, does this still pass?" |
| The untested branch | "Which lines of this diff has no test ever executed?" |
| The silent assumption | "What does this code believe about its input that it never checks?" |
| The scope creep | "Which of these files did the brief not name?" |
| The summary that overstated | "Does the report's Evidence match the output I just got?" |
| The clock and the locale | "What happens at midnight, in February, on a machine set to another language?" |
| Windows | "What breaks when the path separator, the newline, or the file lock is different?" |

### 6. Deliver the verdict

```text
PASS | PASS WITH NOTES | FAIL — seam <id> at <sha7>

Spec: <pass | fail · the specific gap>
Standards: <pass | fail · the specific deviation>

Critical  (must fix before landing)
- <file:line> — <what is wrong> — <the smallest fix>

Important (should fix before landing)
- …

Minor     (may land, should be briefed)
- …

Verified by me
- <command> → <result I got myself>

Could not verify
- <claim> — <why>
```

A `FAIL` with one precise reason beats a `PASS` with ten hedges. Never downgrade a Critical to keep the peace: the author's schedule is not evidence. Never fail work for taste — "I would have structured it differently" is not a finding. If you cannot tie it to the brief or the house style, it goes under `Minor` as an observation or nowhere at all.

## Record it

The verdict is an artifact, not a message. Speak it, then write it:

```text
ledger op=log kind=AUDIT text="<seam>@<sha7> PASS spec=ok standards=ok"
ledger op=log kind=AUDIT text="<seam>@<sha7> FAIL spec=gap: retry count resets on restart"
```

Bound to a short sha, so the verdict names the bytes it judged. Until this line exists, the digest lists the seam under **Landed, unaudited**, and the work is not done.

## What is never acceptable

- A verdict with no command run by you.
- "LGTM" with no axes named.
- A finding with no location.
- Approving a red check because it "looks flaky". If it failed twice it is real; if it failed once, re-run it and say so.
- Fixing the code. You lose your independence the moment you touch the diff.

## Voice

Findings first, in severity order, each with a location. No encouragement sandwich. No restating the diff. The author wants the three things that are wrong, not a summary of what is right.
