# employee-permissions

## Outcome

Every archetype's edit rules now take effect: the broad `* allow` is first, the three denies are anchored as `**/...` so they match the absolute paths the engine sends, and each archetype's own-handbook allow is the last edit rule. `scripts/check.mjs` gained three assertions and runs 104/104 at exit 0. Changed: 22 archetype files (`agents/*.md` minus `lead.md`, `auditor.md`). `agents/lead.md` and `agents/auditor.md` were not modified; the auditor's `edit * deny` is already correct and the brief says leave it.

The brief says "all 23 non-lead agents" and "23 files with the same transformation", but its own Read-first says the auditor is out of scope for edit rules. I applied the transformation to the 22 archetypes and left the auditor byte-identical. The three assertions still sweep all 23 non-lead agents, and the auditor passes all three as written (`* deny` is the last edit rule, its resource is `*`, and it is not an archetype). If the intent was literally 23 files, the only possible edit to the auditor would break the thing the brief calls correct.

## Evidence

Red first (assertions added, no agent touched, `exit 1`):

```text
  FAIL  every non-lead agent puts its edit exceptions after the broad allow
        backend.md ends its edit rules on * allow, so every exception written above it is dead
  FAIL  every edit deny names a path the engine can actually send
        backend.md denies edit to ".stack/config.json" with no **/ prefix; edit resources are absolute, so it never matches
102/104 passed
```

Green at HEAD `4dac0cd`, working tree carrying this seam (`exit 0`):

```text
  pass  every non-lead agent puts its edit exceptions after the broad allow  (23 agents end on an exception)
  pass  every edit deny names a path the engine can actually send  (67 denies anchored)
  pass  every archetype may edit its own handbook  (22 archetypes own one handbook each)
104/104 passed

The plugin does what it says. Install it, then restart OpenCode.
```

Mutation probes, to prove each assertion can go red (each mutation made in `agents/backend.md`, suite run, file restored, SHA-256 checked identical before and after: `0D0F54D4…F014C8`):

```text
# own-handbook allow renamed to references/wrong.md
  FAIL  every archetype may edit its own handbook
        backend.md has no edit allow for its own handbook references/engineering.md as its last edit rule; a deny below it would win
103/104 passed

# own-handbook allow moved before the references deny (the dead shape the brief warns about)
  pass  every non-lead agent puts its edit exceptions after the broad allow
  pass  every edit deny names a path the engine can actually send
  FAIL  every archetype may edit its own handbook
        backend.md has no edit allow for its own handbook references/engineering.md as its last edit rule; a deny below it would win
103/104 passed
```

The second probe is why assertion 3 asserts the *position* of the own-handbook allow rather than its mere existence: with the brief's literal wording it would have passed a rule that is dead, and the other two assertions are also blind to that placement. The count of assertions is still the three the brief asked for.

Before and after, `agents/backend.md` (`git diff`):

```diff
   - action: edit
-    resource: ".stack/config.json"
-    effect: deny
+    resource: "*"
+    effect: allow
   - action: edit
-    resource: ".stack/state/**"
+    resource: "**/.stack/config.json"
     effect: deny
   - action: edit
-    resource: "skills/stacked-employee/references/**"
+    resource: "**/.stack/state/**"
     effect: deny
   - action: edit
-    resource: "skills/stacked-employee/references/engineering.md"
-    effect: allow
+    resource: "**/skills/stacked-employee/references/**"
+    effect: deny
   - action: edit
-    resource: "*"
+    resource: "**/skills/stacked-employee/references/engineering.md"
     effect: allow
```

The edit rule list, in file order, before → after (backend):

```text
before                                                after
deny   .stack/config.json                             allow  *
deny   .stack/state/**                                deny   **/.stack/config.json
deny   skills/stacked-employee/references/**          deny   **/.stack/state/**
allow  skills/stacked-employee/references/engineering.md  deny   **/skills/stacked-employee/references/**
allow  *                                             allow  **/skills/stacked-employee/references/engineering.md
```

Effect, computed with a transcription of `wildcard.ts:3-14` and the `findLast` in `permission.ts:94-104` (this win32 machine):

```text
edit   C:/proj/src/a.ts                                           -> allow
edit   C:/proj/.stack/config.json                                 -> deny
edit   C:/proj/.stack/state/lock.json                             -> deny
edit   C:/proj/.stack/briefs/x.md                                 -> allow
edit   C:/proj/skills/stacked-employee/references/engineering.md  -> allow
edit   C:/proj/skills/stacked-employee/references/quality.md      -> deny
edit   C:\proj\skills\stacked-employee\references\engineering.md  -> allow
edit   C:/proj/README.md                                          -> deny   (auditor)
shell  git push origin main                                       -> allow  (see findings)
```

Per-file shape after the change (every non-lead agent, one line each): the 22 archetypes each carry exactly five edit rules in the order above with their own handbook last; `auditor.md` carries one, `d:*`; `lead.md` is untouched at three. Handbook assignment was derived from each body's `references\X.md` reference, not guessed: engineering ×4, quality ×4, product ×2, design ×3, platform ×3, knowledge ×3, research ×3 = 22.

Diff shape: 22 agent files at 7 insertions / 7 deletions each (the five-rule block reordered and re-anchored; no rule added or deleted, no non-edit rule touched); `scripts/check.mjs` +45 lines (one `check()` per assertion, after the subagent-deny assertion). `agents/lead.md` and `agents/auditor.md` absent from `git status`.

## Unverified

- The host engine is transcribed, not invoked. The installed binary reports 2.2.6 while the checkout reports 2.2.5; I did not run a live edit through the permission service.
- `agentPermissions()` is a line regex, not a YAML parser. Flow-style rules, or extra keys between `action`, `resource` and `effect`, are invisible to all three assertions. That fails loudly rather than passing silently, but the failure would be about parsing, not the rule.
- I did not test session- or global-level rule merging; `permission.ts:169-174` lets a session rule override an agent rule, which is outside this seam.
- The wildcard table asserts outcomes for paths under `C:/proj`. `**/` allows any `.stack` or `skills/stacked-employee` directory on the machine, not only this project's, because agent frontmatter has no project-root variable. Breadth, paid for portability.
- No commit was made; the suite is green at the dirty tree above HEAD `4dac0cd`, not at a committed head. Landing is the lead's step.
- I did not confirm that `C:/proj/.stack` (the directory itself, no trailing segment) is denied; no edit rule targets a directory, and edit resources are files.

## Scope

- `agents/backend.md`, `data-analyst.md`, `data-engineer.md`, `design-reviewer.md`, `design-system.md`, `devops.md`, `docs.md`, `fact-checker.md`, `frontend.md`, `product-manager.md`, `project-manager.md`, `qa.md`, `release-manager.md`, `researcher.md`, `reviewer.md`, `scout.md`, `security.md`, `sre.md`, `technical-writer.md`, `tester.md`, `ui-designer.md`, `ux-researcher.md` — **22 files**, each the same five-rule edit block (broad allow first, three `**/` denies, own-handbook allow last). Line endings stayed LF; the transformation ran from a scratch script under `AppData\Local\Temp\opencode`, not in the repo.
- `scripts/check.mjs` — three `check()` blocks after `every non-lead agent ends on a subagent deny`. No existing assertion touched.
- `.stack/reports/employee-permissions.md` — this report, required by the dispatch, outside `Owns` by nature. `.stack/briefs/employee-permissions.md` was already untracked and is not mine.
- Not touched: `agents/lead.md`, `agents/auditor.md`, `lib/**`, `skills/**`, `bin/**`, `README.md`, `CHANGELOG.md`, `package.json`.

Every touched path is inside `Owns` (`agents/*.md` except `agents/lead.md`, `scripts/check.mjs`) with the single report exception named above.

## Findings outside the seam

1. **Every archetype's four shell denies are dead in the same way this brief fixed edit.** `shell "git push*" / "git merge*" / "git reset --hard*" / "opencode run*"` each deny, then `shell * allow` comes later; `findLast` returns allow. The transcription proof shows `shell git push origin main -> allow`. The brief told me to preserve those rules, so I did; the class fix (move `shell * allow` first, anchor the four denies) is its own seam. Severity is high: the worker that is supposed to be unable to push or reset can.
2. The auditor still allows `shell *`, so its `edit * deny` is bypassable with a redirect, as the prior seam reported. Unchanged here.
3. `.stack/briefs/**` remains agent-writable by design (reports and records live there); only `config.json`, `state/**` and other handbooks are denied. If briefs are a protected input, that is a separate decision.

## Lesson

Anchoring and position are two separate facts, and this seam needed both. `**/.stack/state/**` is what makes the pattern capable of matching; putting it after `edit * allow` is what makes it the rule the engine finds. A check for the exception's existence is not a check for its effect: the third assertion only earns its name because it asserts the own-handbook allow is the *last* edit rule, and the mutation probe showed the literal wording would have blessed a dead rule. When a brief enumerates assertions, read them against the Out — an assertion that cannot fail for the defect being fixed is documentation, not proof.
