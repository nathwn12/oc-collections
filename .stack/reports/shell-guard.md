# shell-guard

## Outcome

Every archetype's shell deny now evaluates. In all 22 non-lead, non-auditor agents the broad `shell * allow` is the first shell rule and the four denies follow it, each bounded by `*` on both sides, so `evaluate()`'s `findLast` returns the deny for `git push`, `git merge`, `git reset --hard` and `opencode run` wherever they sit on the command line. Each of the 22 files also carries a two-line YAML comment above the block stating the limit. `scripts/check.mjs` gained exactly two assertions and runs 106/106 at exit 0 on the tree above `5e9b1a6`.

The limit, stated plainly: **a shell deny matches the raw command string. A command assembled at runtime — a variable, an alias, a script whose contents are not the command line — evades it, and always will. This is a fence that catches the honest mistake and the obvious move, not a sandbox.** The result is not "employees cannot push"; it is "the obvious push is caught, and the dishonest one is not".

Out of scope and untouched: `agents/lead.md` (its shell rules stay absent) and `agents/auditor.md` (`shell * allow` is an open owner decision).

## Evidence

Red first. Assertions added to `scripts/check.mjs`, all 22 agent files reverted to `HEAD`, `node scripts/check.mjs` (exit 1, the suite ran to the count):

```text
  FAIL  every archetype puts a shell deny after its broad allow
        backend.md ends its shell rules on * allow, so every deny written above it is dead
  FAIL  every shell deny is bounded by a wildcard on both sides
104/106 passed

Failed:
  - every archetype puts a shell deny after its broad allow: backend.md ends its shell rules on * allow, so every deny written above it is dead
  - every shell deny is bounded by a wildcard on both sides: backend.md denies shell "git push*"; the matcher anchors the pattern, so it only catches a command that starts or ends with it
```

Both failed for the defect the brief names, not for a parse or a typo.

Green. `node scripts/check.mjs` at HEAD `5e9b1a6` with the working tree above it (exit 0):

```text
  pass  every archetype puts a shell deny after its broad allow  (22 archetypes end on a shell deny)
  pass  every shell deny is bounded by a wildcard on both sides  (88 denies bounded on both sides)
106/106 passed
```

The second assertion counts 88 = 22 archetypes x 4 denies; it sweeps all 24 agents and finds no shell deny in lead or auditor.

Before and after, `agents/backend.md`, shell rules in file order (the same 5-rule block in all 22 files):

```text
before                                                after
deny   git push*                                      allow  *
deny   git merge*                                     deny   *git push*
deny   git reset --hard*                              deny   *git merge*
deny   opencode run*                                  deny   *git reset --hard*
allow  *                                              deny   *opencode run*
```

The diff is one rule moved and four patterns widened: `git diff --numstat` is `9 7` for every archetype (2 comment lines + the 3-line `allow *` inserted at `permissions:`, the same 3 lines deleted from below the edit block, and 4 `resource:` lines changed). `scripts/check.mjs` is `29 0`.

The frontmatter, after the change (backend):

```yaml
permissions:
  # A shell deny matches the raw command string only; a variable, alias or script evades it, and always will.
  # It fences the honest mistake and the obvious move. It is not a sandbox.
  - action: shell
    resource: "*"
    effect: allow
  - action: shell
    resource: "*git push*"
    effect: deny
  ...
```

Effect, computed with a transcription of `wildcard.ts:3-14` and `permission.ts:94-104` (`findLast`), reading `HEAD:agents/backend.md` against the working copy on this win32 machine:

```text
command                              before    after
git push origin main                 allow     deny   <-- changes
cd repo && git push origin main      allow     deny   <-- changes
git push --force origin feat         allow     deny   <-- changes
git merge main                       allow     deny   <-- changes
cd repo && git merge main            allow     deny   <-- changes
git reset --hard HEAD~1              allow     deny   <-- changes
echo done && git reset --hard        allow     deny   <-- changes
opencode run build                   allow     deny   <-- changes
git status                           allow     allow
node scripts/check.mjs               allow     allow
npm test                             allow     allow
```

Mutation probes, each made in `agents/backend.md`, suite run, file restored, SHA-256 checked identical before and after (`A755B185…094BCA`):

```text
# broad allow moved back after the denies (the dead shape the brief fixes)
  FAIL  every archetype puts a shell deny after its broad allow
  pass  every shell deny is bounded by a wildcard on both sides  (88 denies bounded on both sides)
105/106 passed

# one deny left anchored on the left only: resource "git push*"
  pass  every archetype puts a shell deny after its broad allow  (22 archetypes end on a shell deny)
  FAIL  every shell deny is bounded by a wildcard on both sides
105/106 passed
```

So each assertion can go red alone, and each names the file and the reason.

Frontmatter still parses with the comment in place: all 24 agent files loaded with js-yaml 4.3.1 plus a transcription of the host's `sanitize()` fallback (`packages/core/src/config/markdown.ts:22-38`, which preserves `#` lines verbatim), asserting for each archetype: 5 shell rules, `allow *` first, the other four deny with a `*` at both ends, `subagent deny` last. Output: `22 archetype frontmatters parse … 24 agent files parsed, comments are inert`. The plain `agentPermissions()` line-regex in `check.mjs` is unaffected because comment lines do not start with `- action:`.

## Unverified

- The host engine is transcribed, not invoked. `wildcard.ts` and `permission.ts` were read from the checkout (`Q:\PROJECTS\INSPIRATION\opencode`, reported as 2.2.5 in the prior seam) while the installed binary reports 2.2.6; no live shell call was run through the permission service.
- The YAML parse used js-yaml 4.3.1 from bun's global install plus my transcription of the host fallback, not `gray-matter` itself (not installed here). gray-matter delegates to js-yaml, and a YAML comment is the least invasive line YAML allows, but the module boundary is unexercised.
- The deny's false-positive rate is not measured. `*git push*` also denies `echo "remember: git push is forbidden"`. The brief asked for the embedded case, and a deny that is broad is the safe direction, but the breadth is real.
- Aliases, variables and scripts are not tested, by definition of the limit. Nothing here claims they are blocked.
- Session-level rules can still override an agent rule (`permission.ts:169-174`); that merge is outside this seam and untested.
- `check.mjs` is both the instrument and one of the changed files, so the suite is not independent of this edit. The mutation probes above are the answer to that; an auditor should still re-derive the two assertions from the brief.
- No commit was made; the suite is green at the tree above `5e9b1a6`, not at a committed head. Landing is the lead's step.

## Scope

- `agents/backend.md`, `data-analyst.md`, `data-engineer.md`, `design-reviewer.md`, `design-system.md`, `devops.md`, `docs.md`, `fact-checker.md`, `frontend.md`, `product-manager.md`, `project-manager.md`, `qa.md`, `release-manager.md`, `researcher.md`, `reviewer.md`, `scout.md`, `security.md`, `sre.md`, `technical-writer.md`, `tester.md`, `ui-designer.md`, `ux-researcher.md` — **22 files**, each the same 9/7 transformation. LF preserved (verified: 0 CRLF in all 22; `lead.md` was already CRLF and is untouched).
- `scripts/check.mjs` — two `check()` blocks inserted after `every archetype may edit its own handbook`, before `the permission sweep covers the roster`. No existing assertion edited.
- `.stack/reports/shell-guard.md` — this report, required by the dispatch, outside `Owns` by nature.
- Not touched: `agents/lead.md`, `agents/auditor.md` (`git diff --quiet` exits 0 for both), `lib/**`, `skills/**`, `bin/**`, `README.md`, `CHANGELOG.md`, `package.json`.
- Tools for the transformation, probes and transcription lived in `AppData\Local\Temp\opencode`, not in the repo.

Every touched path is inside `Owns` (`agents/*.md` except `agents/lead.md` and `agents/auditor.md`, `scripts/check.mjs`) with the single report exception named above.

## Lesson

The previous seam fixed edit rules by reordering them; this one proves the same bug recurs per action and must be swept per action. Two facts make a deny real here and they are independent: position (`findLast` means the rule must come after the broad allow) and reach (an anchored matcher means the pattern needs `*` on both ends). Assertion 1 alone would bless a dead pattern, assertion 2 alone would bless a deny below the allow; only both, plus a mutation probe each, prove the fence. The most valuable line in this seam is the comment, because the pattern shape reads like security when it is only a fence: the next person to add `*git rebase*` should copy the block and keep the caveat with it.
