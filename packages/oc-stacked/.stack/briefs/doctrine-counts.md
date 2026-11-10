# Seam doctrine-counts: one stop list, one owner sentence

**Owner:** one employee. **Written by:** the lead. **State:** briefed.

## Why now

Removing the CEO left three contradictions: a `package.json` description and a skill line that still say "The owner is the CEO", and documents that say both "five stops" and "four things stop it". A rule stated twice with two numbers is a rule that will be followed zero times.

## Out

One stop list, stated once per document, always five:

1. an irreversible act
2. money above the standing cap
3. a security-sensitive act
4. a side effect outside the worktree that norms say you ask about
5. a request so broken that every path is a guess

And one owner sentence: **the owner is the CEO; the lead speaks for them.** No document may claim the agent `ceo` exists.

Applies to `README.md`, `package.json` (`description` only), `skills\stacked\SKILL.md`.

## Check

```text
node scripts/check.mjs
```

Exit 0. Additionally, after your edit, grep your three files for `ceo` and paste every hit; each must read as the *owner*, never as an agent or a seat.

## Owns

- `README.md`
- `package.json`
- `skills\stacked\SKILL.md`

## Do not touch

`lib\`, `scripts\`, `agents\`, `commands\`, `SOUL.md`, `preview\`, `.stack\briefs\` owned by another seam.

## Read first

`README.md`, `skills\stacked\SKILL.md`, `SOUL.md` (the five, as written there), `agents\lead.md`.

## Tier

standard.

## Report

`.stack\reports\doctrine-counts.md` with Outcome, Evidence, Unverified, Scope, Lesson. Then one paragraph back.
