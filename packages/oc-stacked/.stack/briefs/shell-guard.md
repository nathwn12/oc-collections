# shell-guard

## Out

The archetypes' shell denials actually evaluate. Today, in all 22 archetypes:

```yaml
- { action: shell, resource: "git push*", effect: deny }   # before the broad allow
- { action: shell, resource: "*",        effect: allow }   # findLast -> allow wins
```

So "never push a shared branch" is doctrine only. Fix it in the same shape the edit rules just took:

1. **Broad allow first, denies after**, because `evaluate()` is `findLast`:
   ```yaml
   - { action: shell, resource: "*", effect: allow }
   - { action: shell, resource: "*git push*",        effect: deny }
   - { action: shell, resource: "*git merge*",       effect: deny }
   - { action: shell, resource: "*git reset --hard*", effect: deny }
   - { action: shell, resource: "*opencode run*",    effect: deny }
   ```
2. **Wildcards on both sides.** The matcher anchors the pattern (`^...$`), so `git push*` only catches a command that *starts* with it. `cd repo && git push` would pass. `*git push*` catches the embedded case. Keep the command meanings identical; change only the pattern shape and the order.
3. Leave `agents/lead.md` and `agents/auditor.md` untouched - the lead's shell stays as it is, and the auditor's shell is an open owner decision, not yours to pre-empt.
4. `scripts/check.mjs` gains two assertions: for each non-lead, non-auditor agent, the **last** `shell` rule is not `* allow`; and every `shell` deny resource starts and ends with `*`.

## The limit, which goes in the report and in a comment in the files

A shell deny matches the raw command string. A command assembled at runtime - a variable, an alias, a script whose contents are not the command line - evades it, and always will. This is a fence that catches the honest mistake and the obvious move, not a sandbox. Say exactly that in the report; do not describe the result as "employees cannot push".

## Check

```text
node scripts/check.mjs
```

Exit 0 with both new assertions named in the output. Paste the final count line verbatim. Show one archetype's shell rules before and after.

## Owns

`agents/*.md` except `agents/lead.md` and `agents/auditor.md`, `scripts/check.mjs`

## Do not touch

`agents/lead.md`, `agents/auditor.md`, `lib/**`, `skills/**`, `bin/**`, `README.md`, `CHANGELOG.md`, `package.json`.

## Read first

- `packages/core/src/permission.ts` (`evaluate` -> `findLast`), `packages/core/src/util/wildcard.ts` (anchored, `si` flags on win32), both under `Q:\PROJECTS\INSPIRATION\opencode`.
- `.stack/reports/employee-permissions.md` - this is the follow-up it named.
- `agents/backend.md` for the current shape.

## Tier

Implementation, one transformation across 22 files. Report the count.
