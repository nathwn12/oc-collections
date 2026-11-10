# permission-truth

## Context you can trust (checked against the docs, not inferred)

`https://opencode.ai/docs/agents/` says: agents use `permissions`, an **ordered list** of `{ action, resource, effect }`, wildcards allowed, **last matching rule wins**, so broad rules go first and exceptions after. `action` includes `edit` ("edit, write, and patch tools"), `subagent`, `skill`, `shell`, `read`. The page explicitly says not to use the legacy `permission` and `tools` fields in V2. The `config.json` schema's singular `permission` is the deprecated config-level form - do not "fix" the agent files toward it.

## Out

The lead's edit boundary is drawn at `.stack/`, and every other agent's spawn boundary is closed. Four changes:

1. **`agents/lead.md`** keeps `permissions:` but rescopes edit. Broad rule first, exception second, because the last match wins:

   ```yaml
   permissions:
     - action: edit
       resource: "*"
       effect: ask
     - action: edit
       resource: ".stack/**"
       effect: allow
     - action: subagent
       resource: "*"
       effect: allow
   ```

   Also allow the write side of the same boundary if the docs name a distinct action for creating files; if `edit` covers write and patch (it does), add nothing.

2. **Every non-lead agent** denies spawning: append `{ action: subagent, resource: "*", effect: deny }` after its existing rules, so nothing can widen it later. Do not delete rules it already has.

3. **`agents/auditor.md`** also denies `edit` to anything outside its own report path if it carries an edit rule; an auditor that can edit what it judges is not an auditor. If its rules do not mention edit, leave it and say so in the report.

4. **`scripts/check.mjs` gains assertions** in the existing style:
   - `lead.md` contains a `.stack/**` allow rule and a broad `"*"` ask rule **in that order** (the allow must come after the ask, or it never applies).
   - no agent file uses the legacy singular `permission:` key at top level.
   - every agent whose name is not `lead` has a `subagent` deny.
   - the count of agents still matches the roster assertion that already exists.

5. **One section in the body of `lead.md`**, three or four lines, stating the hard boundary: the lead writes only `.stack/`; every source change is a seam with a brief, including a one-line fix; the ask rule exists so a crossing is a decision, not an accident.

## Check

```text
node scripts/check.mjs
```

Exit 0 with the new assertions visible. Paste the final line verbatim. If the four new assertions are not in the output, the seam is not done.

## Owns

`agents/**`, `scripts/check.mjs`

## Do not touch

`lib/**`, `skills/**`, `bin/**`, `README.md`, `CHANGELOG.md`, `package.json`, and `lead.md`'s existing body beyond the one added section.

## Read first

- `https://opencode.ai/docs/agents/` - the Permissions section. Last matching rule wins is the whole trick; get the order right.
- `agents/lead.md`, `agents/auditor.md`, `agents/backend.md`
- `scripts/check.mjs`, the region that reads `agents/` - match its assertion style

## Tier

Implementation. One seam. If the docs and this brief disagree, the docs win and you say so in the report.
