# Seam readme-truth: make the README describe the product that exists

**Owner of this seam:** one employee. **Written by:** the lead. **State:** briefed.

## Why now

The README still describes an older shape: four seats including a CEO, `stacked-*` agent names, and a tool count that predates `clean`. A front page that lies is the cheapest way to lose trust in everything behind it.

## Out

The README states the current product and nothing that is not true:

- three seats — `lead` (decides and dispatches), `employee` (builds), `auditor` (judges); no CEO anywhere;
- six-plus-one tools: `ledger`, `brief`, `swarm`, `check`, `scope`, `ready`, `clean`;
- the skills list matches the `skills/` directory exactly, and `stacked-soul` is described as registered from `SOUL.md`;
- the model policy: lead inherits the session model, employee pins `opencode-go/deepseek-v4.1-flash`, auditor pins `openai/gpt-6.1-terra`;
- a three-row glossary: **BARE** = the host harness with no plugins, **OC-STACKED** = this plugin, **`.stack/`** = the plugin's per-project memory;
- the close ceremony: `clean` sweep, `clean` report, digest refresh, one lesson;
- every count you state must match the filesystem at the moment you write it.

## Check

```text
node scripts/check.mjs
```

It must exit 0. Its README-related assertions are the minimum; read the file you wrote and confirm each stated count against `agents/`, `skills/` and the tool list in `lib/tools.js`.

## Owns

- `README.md`

## Do not touch

- `lib/`, `scripts/`, `skills/`, `agents/`, `commands/`, `SOUL.md`, `preview/` — another seam owns them or has just closed them.
- Anything that is not the README.

## Read first

- `README.md`
- `lib/skills.js` (the registered skill list)
- `lib/tools.js` (the registered tools)
- `agents/*.md` (the three seats and their model lines)

## Tier

standard. Prose against a filesystem: cheap to verify, easy to get subtly wrong.

## Rules that bind this seam

1. Name the unknown before writing. If the README's intent disagrees with what exists, the filesystem wins.
2. The smallest change that makes every claim true. Do not rewrite voice or structure that is already correct.
3. Every changed line traces to Out. Orphans you created, you delete.
4. Paste the command and its output in the report. A claim without a command is `Unverified`.
5. Never merge, never push, never dispatch. Two failures of the same command: stop and report.

## Report

Write `.stack/reports/readme-truth.md` with the five headings, then return one paragraph: outcome, files touched, check result, concerns.
