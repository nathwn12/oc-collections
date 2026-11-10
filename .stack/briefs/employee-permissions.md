# employee-permissions

## Out

Every archetype's permission list is ordered so its exceptions actually take effect, and `scripts/check.mjs` proves it. Right now they are decorative:

```yaml
- { action: edit, resource: ".stack/state/**",  effect: deny }    # relative, never matches
- { action: edit, resource: "*",                effect: allow }   # last match wins -> allow
```

Edit resources are absolute (`C:/proj/.stack/state/x`), the pattern is anchored, and `findLast` means the trailing `* allow` wins anyway. So a worker can edit `.stack/state/**`, `.stack/config.json`, and every other department's handbook. Handbook isolation is currently prose.

**The fix, applied to all 23 non-lead agents:**

1. Emit the broad allow **first**, exceptions **after** - last match wins, so exceptions must be last:
   ```yaml
   - { action: edit, resource: "*",                          effect: allow }
   - { action: edit, resource: "**/.stack/config.json",       effect: deny }
   - { action: edit, resource: "**/.stack/state/**",          effect: deny }
   - { action: edit, resource: "**/skills/stacked-employee/references/**", effect: deny }
   - { action: edit, resource: "**/skills/stacked-employee/references/<its own handbook>.md", effect: allow }
   ```
   The own-handbook allow must come **after** the references deny, or it is dead the same way. Each archetype names exactly one handbook, and it is the one its body already tells it to read - derive it from the file, do not guess.
2. Preserve every existing rule that is not one of these five; do not add a `subagent` rule (the roster already ends on deny and a prior seam verified it).
3. Keep `agents/lead.md` untouched - it is not an archetype and its boundary is already correct.
4. `scripts/check.mjs` gains three assertions:
   - for each non-lead agent, the last `edit` rule is not `* allow` (i.e. exceptions come after the broad allow);
   - every `edit` deny resource starts with `**/` or is `*`;
   - each archetype has at least one `edit` allow whose resource ends in its own handbook file name.

## Check

```text
node scripts/check.mjs
```

Exit 0, with the three new assertions visible by name. Paste the final count line verbatim.

Also write, in the report, the exact `edit` rule list of one archetype before and after, as evidence that ordering changed and not just syntax.

## Owns

`agents/*.md` except `agents/lead.md`, `scripts/check.mjs`

## Do not touch

`agents/lead.md`, `lib/**`, `skills/**`, `bin/**`, `README.md`, `CHANGELOG.md`, `package.json`.

## Read first

- `packages/core/src/permission.ts` (`evaluate` -> `findLast`) and `packages/core/src/util/wildcard.ts` (anchored, backslash-normalised) in `Q:\PROJECTS\INSPIRATION\opencode`.
- `agents/backend.md` (the dead-rule shape), `agents/qa.md`, `agents/auditor.md` (auditor is out of scope for edit rules - leave its `edit deny *` exactly as it is, it is correct).
- `.stack/reports/permission-truth.md`, which found this.

## Tier

Implementation, one seam, 23 files with the same transformation. Report the count you changed.
