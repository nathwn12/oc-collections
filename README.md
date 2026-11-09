# oc-stacked

A three-rung agent stack for OpenCode: one CEO, one lead, a fresh employee per seam, and an auditor that wrote none of it.

## The problem

One agent doing everything holds context it does not need, approves its own work, and forgets what it finished when the context compacts. Context is spent on coordination instead of the seam in front of it, and the green it reports is its own opinion. The result is the most expensive failure in agent work: a finished seam redone because nothing on disk remembered it.

## The shape

| Seat | Owns | May never |
|---|---|---|
| **CEO** | direction, priority, spend, irreversible calls, the verdict on what ships | write code, run a build, approve without evidence |
| **LEAD** | cutting seams, writing briefs, dispatching, reconciling, landing, the digest | take a seam it already dispatched, land on a worker's word alone |
| **EMPLOYEE** | one seam, one brief, one check, one report | merge, push a shared branch, widen scope, dispatch anyone |
| **AUDIT** | the verdict on work it did not write | edit the work it judges, accept the author's own check as the verdict |

## What you get

- **Five tools:** `ledger`, `brief`, `check`, `scope`, `ready`.
- **Six skills:** `stacked`, `stacked-soul`, `stacked-ceo`, `stacked-lead`, `stacked-employee`, `stacked-audit`.
- **Four agents:** `stacked-ceo`, `stacked-lead`, `stacked-employee`, `stacked-auditor`.
- **Four slash commands:** `/stack`, `/stack-check`, `/stack-ready`, `/stack-digest`.
- **State on disk:** `.stack/` holds the ledger, the digest, briefs, reports, and the last check bound to a HEAD.
- **No infrastructure:** zero MCP servers, zero runtime dependencies, no network calls, no daemons. ESM, Node 20+, Windows-first.

## Install

```powershell
cd Q:\PROJECTS\PERSONAL\oc-stacked
node scripts/install.mjs
```

The installer junctions the repository into `%USERPROFILE%\.config\opencode\plugins\oc-stacked`, so edits here are live on the next restart with no copy step, and copies the four agents and four commands into the config directory. No admin rights, no per-file symlinks, and it does not rewrite your `opencode.jsonc`.

Restart OpenCode so the plugin loads, then verify:

```powershell
node scripts/check.mjs
```

To wire it by hand instead, add the directory to `plugins` in `opencode.jsonc`:

```jsonc
"plugins": ["Q:\\PROJECTS\\PERSONAL\\oc-stacked"]
```

Undo everything it added:

```powershell
node scripts/install.mjs --remove
```

## First run

1. `/stack ship the retry budget for webhook delivery` — intake, restated in one sentence, cut into seams.
2. The lead writes one brief per seam: Out, Check, Owns. A brief with a hole is refused, and nothing is written.
3. Dispatch one employee per seam, at most `dispatch.live` at once; the prompt carries the brief path and three fields.
4. `/stack-check` — the configured commands run and the result binds to the current HEAD.
5. `/stack-ready retry-budget` — the gate answers in this exact shape:

   ```text
   ## GO — seam retry-budget

   - pass · brief: .stack/briefs/retry-budget.md
   - pass · report declares nothing unverified
   - pass · checks green at 4f2c1ab: unit, lint
   - pass · tree clean at 4f2c1ab on retry-budget
   ```

6. `/stack-digest` — `.stack/digest.md` rewritten: Needs you / New / In progress, every row aged.

## The five tools

| Tool | What it does | Reach for it when |
|---|---|---|
| `ledger` | appends one stamped line, reads the tail, rewrites the digest from the record | an event happened worth remembering after compaction |
| `brief` | writes a seam contract, lists seams, moves state, refuses an incomplete brief | before dispatching anyone |
| `check` | runs the repo's proving commands, binds pass/fail to a HEAD, names a stale result | before you claim anything is green |
| `scope` | lists touched paths, compares them with the brief's `Owns`, names what is out of bounds | before reporting a seam done |
| `ready` | gates a seam: GO or NO-GO with each reason named | immediately before landing |

## Configuration

`.stack/config.json`, created on first tool use:

```json
{
  "checks": [
    { "name": "unit", "command": "npm test", "timeout": 180000 },
    { "name": "lint", "command": "npm run lint --silent", "timeout": 60000 }
  ],
  "ownership": { "ignore": [".stack/**", "dist/**"] },
  "dispatch": { "live": 4, "cap": 10 }
}
```

`checks` is the only green that counts: a name, a shell command, a timeout in milliseconds, an optional `cwd`. `ownership.ignore` lists paths `scope` and `ready` do not audit. `dispatch.live` is how many employees may run at once; `dispatch.cap` is the ceiling it may never exceed.

## The rules the system enforces

- A brief needs Out, Check, and Owns. `brief` refuses the rest and writes nothing.
- A seam lands only on a green check at the HEAD being landed; a result from another head fails with both shas named.
- Scope is audited. Every touched path must fall inside the brief's `Owns`, or it needs its own brief.
- A worker never dispatches, never merges, and never pushes a shared branch.
- A verdict comes from a context that wrote none of the work. The author's check is smoke.

## Requirements and limits

- OpenCode 2.0.4 or newer, verified on 2.2.6. A V1-compatible export is kept.
- Node 20 or newer. No build step, no transpiler, no dependencies.
- git is optional: without a repository, `scope` says it cannot audit and `ready` gates on brief, report, and checks only. It says so rather than assuming clean.
- No GitHub coupling. Nothing reads or writes a PR, an issue, or a remote.
- No model pinning by default. A brief records a tier (`cheap`, `standard`, `expert`); which model backs it is your call.

## License

MIT. Lineage and inspiration: see SOURCES.md.
