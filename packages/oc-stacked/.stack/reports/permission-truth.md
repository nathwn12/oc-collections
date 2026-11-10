# permission-truth

## Outcome

The lead's edit boundary is now last-match-correct: a broad `edit *` ask, then `**/.stack/**` and `**/.stack` allows, written as absolute-path patterns because edit resources are absolute. Every non-lead agent now ends its permission list on `subagent * deny` (relocated from the top in 22 files; the auditor already had it last). The auditor already denied `edit` to everything, including its own report path, so it was not modified. `scripts/check.mjs` gained four assertions and the suite runs 101/101 at exit 0.

## Evidence

Host receipts (the mechanism is authoritative; checkout reports 2.2.5, installed binary is 2.2.6):

- `packages/core/src/permission.ts:94-104` — `evaluate()` is `rulesets.flat().findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? { effect: "ask" }`. Last matching rule wins; no match at all means ask.
- `packages/core/src/util/wildcard.ts:3-14` — anchors `^...$`, converts `*` to `.*`, normalises `\` to `/`, and uses the `si` flags on win32.
- `packages/core/src/plugin/plan.ts:38-40` — the built-in Plan agent pushes `{ action: "edit", resource: "*", effect: "deny" }` then `{ action: "edit", resource: path.join(directory, "*"), effect: "allow" }`; edit resources are absolute paths.
- `packages/core/src/file-write.ts:74-78` — `permission.assert({ action: "edit", resources: [target.resource] })`. The docs' action table says `edit` covers edit, write and patch, so no separate write rule was added.

Red first — four assertions added, no agent file touched yet (`exit 1`):

```text
  FAIL  the lead edits only .stack, and the exception comes after the ask
        lead.md has no **/.stack/** edit allow rule
  FAIL  every non-lead agent ends on a subagent deny
        backend.md ends on skill * allow; a later rule can widen the spawn deny
99/101 passed
```

Green — final run after the agent changes (`exit 0`):

```text
  pass  twenty-four agents exist with valid V2 frontmatter  (24 agents)
  pass  the lead edits only .stack, and the exception comes after the ask  (ask, then **/.stack and **/.stack/**)
  pass  no agent uses the legacy singular permission key  (24 agents use permissions:)
  pass  every non-lead agent ends on a subagent deny  (23 agents cannot delegate)
  pass  the permission sweep covers the roster the agent check asserts  (24 of 24 agents carry permissions:)
101/101 passed
The plugin does what it says. Install it, then restart OpenCode.
```

Wildcard proof — verbatim transcription of `wildcard.ts:3-14` and the `findLast` in `evaluate()`, run on this win32 machine:

```text
C:/proj/.stack/briefs/a.md -> allow
C:\proj\.stack\briefs\a.md -> allow
C:/proj/.stack -> allow
C:/proj/src/a.ts -> ask
C:/proj/.stack/BRIEFS/A.MD -> allow

before correction, old rule .stack/**:
C:/proj/.stack/briefs/a.md vs .stack/** -> false (effect ask)
.stack/briefs/a.md vs .stack/** -> true (effect allow)
```

Diff shape: 22 non-lead agent files reordered the same three-line triad (6 changed lines each); `lead.md` 12 insertions / 2 deletions; `check.mjs` one helper and four checks. No permission rule was added or deleted anywhere — the existing subagent deny moved to the end rather than being duplicated, because all 23 files already carried it.

## Unverified

- The host checkout reports 2.2.5 while the installed binary is 2.2.6. I did not run the binary to observe a live ask/allow; the wildcard proof transcribes the source functions rather than invoking the compiled engine.
- `agentPermissions()` is a line regex, not a YAML parser. A rule written in flow style or with extra keys between `action`, `resource` and `effect` is invisible to the sweep. That fails the assertion loudly rather than passing silently, but the failure would be about parsing, not about the rule.
- I did not test global or session-level merging. `permission.ts:169-174` merges agent rules then session rules, so a session rule can still override an agent rule; that is outside this seam.
- `**/.stack/**` allows any `.stack` directory on the machine, not only this project's. Agent frontmatter has no project-root variable — the docs only expand `~` and `$HOME` for edit resources — so this is the portable choice, at the cost of breadth.
- No OpenCode restart was performed, so the loaded configuration is unverified end to end.
- The working tree is not clean: another seam's uncommitted changes are present (see Scope), so the green is at a dirty tree, not at a committed head.

## Scope

- `agents/lead.md` — replaced the `permissions:` block and added the one `## The edit boundary` section. The existing body is otherwise untouched. File stayed CRLF.
- `agents/*.md` (22 files: every non-lead agent except the auditor) — moved the existing `subagent / * / deny` triad from first to last in the list. No rule changed value.
- `agents/auditor.md` — **not modified**. It already has `edit / * / deny` first and no later edit rule, so it denies edits to everything, including its own report path. Its verdict is recorded with the `ledger` tool, not a file, so it needs no edit exception. It also already ended on the subagent deny.
- `scripts/check.mjs` — added `agentPermissions()` plus four `check()` blocks after the twenty-four-agents assertion. Existing assertions untouched. The pre-existing uncommitted hunks in this file (skill count 16, bootstrap ceiling 3600) belong to another seam, not this one.
- `.stack/reports/permission-truth.md` — this report, required by the dispatch and outside `Owns` by nature.

No commit was made: the tree carries another seam's uncommitted work (`skills/stacked-loop/`, README/CHANGELOG/lib/skills/install, `.stack/briefs/delegation-duty.md`), and a commit here would land files I did not author. Leaving the commit to the lead.

## Findings outside the seam

1. Every archetype's narrow edit denies are dead twice over. `edit` resources such as `.stack/config.json`, `.stack/state/**` and `skills/stacked-employee/references/**` have no leading `**/`, so they can never match an absolute path; and a later `edit / * / allow` in the same list would win anyway. Recommendation: a follow-up brief that normalises those resources and orders the broad allow before the narrow denies, or deletes the denies in favour of a boundary that can match.
2. `agents/auditor.md` denies `edit` but allows `shell *`. The audit is independent of the diff only if shell cannot write one, so the edit deny is bypassable with a redirect. Out of scope here; worth its own seam.

## Lesson

A permission rule is two facts: the pattern and its position. `.stack/**` reads like the project's boundary but is anchored, so it matches only a relative path the engine never sends — edit resources arrive absolute, so the pattern needs `**/` in front. And a deny at the top of a last-match-wins list is a default, not a boundary; only the last rule the engine finds exists. Write the pattern against what the engine actually passes, then put it where it still matches.
