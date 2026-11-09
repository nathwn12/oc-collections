---
name: Stacked Review
description: Use when asking for a review, receiving one, or running a review loop to convergence. Covers the request, the three valid responses to a finding, severity that means something, and the three-round budget. Load on "review this", "address the findings", "another round", or a PR with comments.
license: MIT
---

# The Review

A review is a request for evidence about a claim, not a request for approval. Both sides have a job, and neither of them is "be agreeable".

## The seat

**The lead** requests the review and adjudicates what comes back — which findings are real, who owns each, what waits.
**The auditor** reviews only work it did not write. **The employee** receives the findings and answers every one of them.

## Asking well

A good request makes the reviewer's first minute productive. It carries four things:

| Field | Why it is there |
|---|---|
| The brief path | The requirement, not your memory of it. |
| The diff range | `<base>..<head>` with SHAs, so the verdict binds to code. |
| The exact command you ran | So the reviewer re-runs it instead of trusting your summary. |
| The one thing you are least sure about | It aims the review at the real risk. |

Never write "please review". It names no artifact, no range, and no doubt. The reviewer reconstructs the request from memory, and guesses wrong in the expensive direction.

| Bad ask | Good ask |
|---|---|
| "Can you review my changes when you get a chance?" | "Review seam `upload-retry`: brief `.stack/briefs/upload-retry.md`, diff `9c02a1f..4f2c1ab`, check `npm test -- upload` (green at 4f2c1ab). Least sure about the retry count — the brief says "retry" and never names a number." |
| "Here is the diff, thoughts?" | "Two files in the diff, one outside the brief I already flagged in the report. Least sure the backoff does not stack with the client's own timeout." |

## Receiving

Do not defend. Do not obey blindly. A finding is a claim, and claims get answers, not feelings.

Three responses only:

1. **Fix it** — and name the commit that fixed it.
2. **Park it** — with a reason and a named owner, in the report or the ledger. Parking is a decision, not a delay.
3. **Refute it** — with evidence: the line, the command, the output. "I disagree" is not a refutation.

Every finding gets one of the three, in the reply, by number. A finding with no response is an unowned defect. A reply that answers four of six is not a reply.

Keep the numbers. The reviewer said "3"; you answer "3". Renumbering loses the thread and reads as evasion.

## Severity that means something

| Severity | Meaning | What happens |
|---|---|---|
| **Critical** | Wrong or unsafe | Must fix before landing. |
| **Important** | Right, but it will cost later | Should fix before landing, or be parked with a reason. |
| **Minor** | Taste or hygiene | May land. Brief it if it recurs. |

Severity describes the work, not the reviewer's mood. A Critical with no location is a feeling. "The whole approach is wrong" is not a finding unless it breaks the brief — then it is a Critical with the brief line quoted and the smallest fix named.

## Convergence

A review loop has a budget: **three rounds**.

- Round 1 is the full diff against the brief.
- Every later round re-reviews only the new diff since the last round. Re-reading unchanged code produces unchanged opinions.
- After round three, whatever is left is parked with a ruling: the finding, why it will not be fixed now, and who owns it.

A fourth round on the same finding means the seam is wrong, not the reviewer. Either the brief never settled the question, or the code cannot satisfy it. Re-cut the seam; do not ask a fifth time.

Convergence is not "every finding closed". It is "every finding has one of the three responses, and none is Critical".

## What is never a finding

| Not a finding | Because |
|---|---|
| Formatting the repo does not enforce | No rule, no cost. That is a formatter's job, not a comment. |
| A preference the brief did not ask for | The brief is the requirement. Taste is not. |
| A rewrite of adjacent code | Outside the seam. File it or leave it. |
| "I would have done it differently" | True of every diff ever written. Name the cost or drop it. |

If you cannot tie a comment to the brief or to the house style, it is an observation at most. Say it once under Minor, or do not say it.

## The verdict

The auditor's answer has a fixed shape: `PASS`, `PASS WITH NOTES`, or `FAIL`; both axes named — spec and standards; and the list of what it could not verify. A verdict with no axes is a mood.

The method lives in `stacked-audit`: binding to a SHA, re-deriving the requirement before reading the diff, and trying to break the check. Do not restate it here. Load it.

What the lead does next is mechanical. A `FAIL` re-opens the seam or kills it. `PASS WITH NOTES` lands, with each note parked and owned. `PASS` lands. None of the three is renegotiated by asking the same reviewer the same question again.

## Voice

Findings first, by number and severity, each with a location. No encouragement sandwich, no restating the diff, no thanks for the review.

- Bad: "Thanks for the thorough review! I have addressed most of the comments — let me know if this looks good now."
- Good: "1 fixed in a3f91c2. 2 parked: the retry cap is a policy call, owner lead, logged. 3 refuted: the null path is covered at `upload.test.ts:88`, output below. 4 and 5 are style the repo does not enforce. Nothing Critical remains."
