# oc-stacked

A three-rung agent stack for OpenCode: **one lead, a fresh employee per seam, and an auditor that wrote none of it.**
Local-first, zero MCP, eight tools, no runtime dependencies.

![oc-stacked](preview/readme-hero.png)

A static preview lives at [`preview/index.html`](preview/index.html). Open it in any browser; it needs no server and no network.

## Terms

| Term | Means |
|---|---|
| **BARE** | the host harness as it ships, no plugins |
| **OC-STACKED** | this plugin — the only thing installed into the harness |
| **`.stack/`** | the plugin's per-project memory, created and maintained by the plugin, never by hand |

---

## Why this exists

A single agent doing everything holds context it does not need, approves its own work, and forgets what it finished the moment context compacts. Two failures follow, and both are expensive:

1. **The author's green is an opinion.** The same context writes the code, runs the check it chose, and declares victory.
2. **Finished work gets redone.** After a compaction, nothing on disk says what was already landed, so a controller re-dispatches a completed sequence.

oc-stacked answers both with structure rather than exhortation: **seats** with hard prohibitions, a **brief** that is a refused-if-incomplete contract on disk, a **check** bound to a specific git HEAD, and a **digest** derived from an append-only ledger.

---

## The three seats

| Seat | Agent id | Owns | May never |
|---|---|---|---|
| **LEAD** | `lead` | deciding everything reversible: cutting seams, writing briefs, dispatching, reconciling, landing, the digest | take a seam it already dispatched, land on a worker's word alone, decide what the owner owns |
| **EMPLOYEE** | `employee` | one seam, one brief, one check, one report | merge, push a shared branch, widen scope, dispatch anyone |
| **AUDIT** | `auditor` | the verdict on work it did not write | edit what it judges, accept the author's check as the verdict |

The owner is the CEO; the lead speaks for them. The lead decides everything reversible and asks only for the five stops.

Each seat gets its model from the session unless it is a delegated seat measured in its own right:

| Seat | Model |
|---|---|
| LEAD | the session model — no pin, whatever you pick in the TUI |
| EMPLOYEE | opencode-go/deepseek-v4.1-flash |
| AUDIT | openai/gpt-6.1-terra |

The TUI selection always wins for the lead. EMPLOYEE pins `deepseek-v4.1-flash` because a seam is mechanical enough to standardise; AUDIT pins `gpt-6.1-terra` so the verdict comes from a different family than the code it judges. Those pins are applied, not shipped: every agent file in the repository carries no `model:` line, and `scripts/install.mjs` writes the routing from `routing.json` onto the copies it installs, with `lead` always inheriting.

The prohibitions are enforced, not suggested: the employee agent denies the `subagent` action outright, and the auditor agent denies `edit`.

The lead writes only `.stack/`. Every source change is a seam, even a one-line fix: one file and one edit is still dispatched, two or more files are seamed and ranked, work with no file yet goes to the department that owns it, and only a question about the stack itself is answered directly. A lead reaching for an editor dispatches instead, because a lead that does the work grades its own writing.

---

## The loop

| # | Step | What actually happens |
|---|---|---|
| 1 | **Intake** | The objective is restated in one sentence. Constraints, unknowns, and out-of-scope are named before anything is cut. |
| 2 | **Rank** | The work is cut into seams and scored value × risk ÷ effort. Every genuinely disjoint seam stays live, up to ten; the rest are parked in the ledger with a reason. |
| 3 | **Brief** | `brief` writes `.stack/briefs/<id>.md`. A brief missing **Out**, **Check**, or **Owns** is refused and nothing is written. |
| 4 | **Dispatch** | One employee per seam, all dispatched in one response. Ownership is proved disjoint on exact files first; `swarm` refuses a shared file. The prompt carries a brief path and three fields, never session history. |
| 5 | **Reconcile** | The report is read before chat. `scope` proves the diff stayed inside the brief. `check` is re-run by the lead. |
| 6 | **Land** | `ready` gates it. One commit, plain words, the check output in the body. The seam is marked landed in the ledger. |
| 7 | **Digest** | `.stack/digest.md` is rewritten from the ledger: **Needs you / New / In progress**, every row aged. |
| 8 | **Audit** | A context that wrote none of the work gives `PASS` / `PASS WITH NOTES` / `FAIL`, with each reason named. |

Rulings, not stalls. A running stack decides and records `RULING · what — why — cost if wrong`. Five things still stop it: an irreversible act, money above the standing cap, a security-sensitive act, a side effect outside the worktree that norms say you ask about, and a brief so broken every path is a guess.

### Closing a pass

A pass is not closed until it is swept and written down: `clean` `sweep` removes the stack's own leftovers, `clean` `report` names junk it did not create and deletes none of it, `ledger` `digest` refreshes the digest from the record, and one lesson goes to the ledger for the next session.

### Session status and the close

| Prefix | Means | Set when |
|---|---|---|
| `[active]` | work is moving in this session | a new session starts, any `stack_*` tool runs, or a new normal prompt resumes |
| `[parked]` | work exists but is not moving | the owner says stop/halt/freeze/pause/park, an execution is interrupted, or the session idles with no valid receipt |
| `[done]` | genuinely finished, closing remarks written | the sealed report is present: a `close` op=run returned GO and the idle gate applied `[done]` |

The plugin owns the prefix. A close intent ("close session", "wrap it up", "we're done", "seal it") is optional: it appends one directive to run `close` op=preflight, settle every ticket it names (land, kill, answer, or record an ASK and park), then `close` op=run with one lesson of at least 8 characters. `op=run` refuses while a ticket is open, and a hand-typed `[done]` without a GO receipt is refused. The receipt lives at `state/close.json` (`op=show` reads it back). A session that cannot clear a ticket parks instead of closing. The gate is bounded: the intent persists until the tool prints `SEALED <sha>`, and the final message ends with that exact token — no tools run after it. An attempt to end with "done" or a bare summary while the intent is open gets the next exact action injected and the same execution continues; after 6 failed continuations the session parks and an ASK is recorded. The gate never says done.

A `close` op=run that returns GO arms the close itself: it writes a one-shot arm record, and the idle gate then applies `[done]` from the sealed report with no phrase. `show`, `preflight`, and a refused `run` arm nothing. Before this, a `close` run from the command line wrote the arm record and nothing consumed it, so a sealed session never compacted and never got `[done]`, and the owner had to hand-write an intent file. One invoke is enough now: `op=run` returns GO, the idle gate consumes the record when the turn ends on the sealed report, one compaction fires, and `[done]` follows. A bare `SEALED` token is not the seal; the report is.

The receipt is signed. It binds the full 40-hex HEAD it was written at (`sealed` is its first 7 characters), a uuid `receipt_id`, a check run at that HEAD whose every result is `ok` with exit 0, a passing `preflight` criterion, an `at` inside the commit's window, and a lesson of at least 8 characters. `sig` is HMAC-SHA256 over the body, keyed by `~/.config/opencode/oc-stacked.secret`. The signature stops a typed receipt; it does not stop someone with read access to the secret.

Every NO-GO writes a tombstone: `close.json` becomes `{ go: false, ... }`. Nothing is deleted, because Windows refuses a delete while a handle is open. A refused close therefore destroys an earlier GO on purpose — including a `close` run typed with no lesson. A receipt older than the run is never overwritten by a later refusal; a newer refusal replaces an older GO; two simultaneous runs end with the later receipt.

Sealing fires one real session compaction (`ctx.session.compact`) with a 15-second deadline; a failed or timed-out compaction does not stop the seal. The digest is rewritten from the ledger before the report, and is not the compaction. The ceremony order is checks, sweep, junk report, lesson, digest, atlas.

All four spellings reach the same tool: `stack_close`, `stack.close`, `oc_stack_close`, `oc.stack.close` (plus the bare `close` where the surface omits the namespace).

---

## The eight tools

All local. Files and `git` only; no network call, no daemon, no MCP handshake.

| Tool | Operations | What it does | The refusal |
|---|---|---|---|
| `ledger` | `log` `tail` `digest` | Append one stamped line; read the tail; rewrite the digest from the record. | Never edits. A correction is a new line. |
| `brief` | `new` `list` `get` `status` | Write one seam contract, index it, move its state. | Missing Out, Check, or Owns: no file, no dispatch. |
| `swarm` | one call | Write 2 to 10 briefs atomically; return one dispatch prompt per employee. | Two seams naming one file, a duplicate id, a hole, or an eleventh seam: nothing is written. |
| `check` | `init` `run` `show` | Detect or run the repo's proving commands, bind the result to HEAD. | Reports `RED` on failure and marks a result stale when HEAD moved. |
| `scope` | — | Compare every touched path with the brief's `Owns`. | Names every path that left the seam. |
| `ready` | — | Gate a seam for landing. | `NO-GO` with one named reason per failure: no report, red check, stale check, dirty tree, out-of-scope path. |
| `clean` | `sweep` `report` | Remove the stack's own leftovers, then name junk it did not create. | Never deletes outside `.stack`, never follows a symlink, never deletes a path it cannot claim as its own. |
| `close` | `preflight` `run` `show` | Seal the session: list open tickets, run the closing ceremony, read the receipt. | Refuses while a ticket is open; a failed close writes a refusal record (`go: false`) that destroys the earlier GO. |

`check init` looks for the obvious manifests (`package.json` scripts, `pyproject.toml`, `go.mod`, `Cargo.toml`, a `Makefile` `test` target) and writes the four cheapest honest checks, so the first run is not an empty config. `Cargo.toml` yields `cargo test` only when there is code for it to run: a `[package]` with a `src/` directory (or a `[lib]`/`[[bin]]` path that exists), or a `[workspace]` member that resolves to a directory with its own manifest. An empty virtual workspace, a member that does not exist, and a manifest with no code all add nothing — the detector asks what is on disk, not whether the file parses, so a garbage manifest with no `src/` adds nothing either. Until at least one check exists, readiness is `UNPROVEN`, not green.

---

## The skills

Seventeen. They are ordinary `SKILL.md` files with front matter; the plugin registers them natively at startup. One is the hub, the rest are seats, discipline lenses, and the shelf you pull when the moment matches.

| Skill id | Loads when |
|---|---|
| `stacked` | Always. It is also the injected bootstrap: which rung you are on and what it may not do. |
| `stacked-soul` | The four laws. Registered from the single canonical [`SOUL.md`](SOUL.md) at the repo root, not a copy. |
| `stacked-pls` | The request is half-shaped: decide the gaps as the owner would, deepen the goal one rung, then work it to green. |
| `stacked-lead` | Work spans files, decisions, or more than one sitting. |
| `stacked-employee` | You were dispatched a seam and have a brief path. |
| `stacked-audit` | A seam is ready to land, or a branch needs a verdict from outside. |
| `stacked-deepen` | The complaint is about the code, not a feature. |
| `stacked-plan` | The design is not obvious, or the ask is a feature. |
| `stacked-swarm` | More than one seam can run at once. |
| `stacked-debug` | Something throws, hangs, slows, or lies. |
| `stacked-tdd` | Behaviour changes and a test surface exists. |
| `stacked-review` | You are asking for, receiving, or looping on a review. |
| `stacked-ship` | The seam is ready to commit, close, or release. |
| `stacked-wizard` | oc-stacked is installed but not behaving: seats missing, models unpinned, `.stack/` unseeded, a ghost seat, a check green on a stale tree. Aligns a host that already has its own opinions, by adding only. |
| `stacked-oftb` | You are blocked. Names which kind of rule is in the way - owner gate, doctrine default, or physics - then climbs six rungs (invert, confine, split, other door, witness, shrink) to reach the same goal without an authorization nobody gave. |
| `stacked-loop` | "Don't stop until", "keep going", a vague ask that should still land, or any multi-turn job with a check. The goal lives in `.stack/goal.md`; every turn ends with a verdict from a context that did none of the work. |
| `stacked-close` | The session is ending, the work is done, or you say close, wrap up, seal, we're done. The fixed closing order: settle every ticket, sweep, align the docs to the diff, one lesson, the report, then the sealed receipt and the compaction. |

**Commands are the owner's.** `/stack` and friends are manual by design: the route table decides which seat handles an ask, and the loop never types a command for itself.

---

## The commands

| Command | Does |
|---|---|
| `/stack <objective>` | Enters the loop: restate, rank, brief the first seam. |
| `/stack-check [name]` | Runs the proving checks and binds the result to HEAD. |
| `/stack-ready <id>` | Gates a seam and restates every failing reason as an action. |
| `/stack-digest` | Rewrites the digest and names the single next action. |

---

## State on disk

Conversation memory does not survive compaction. `.stack/` does.

```text
.stack/
  ledger.md            append-only, one stamped line per event
  digest.md            derived: Needs you / New / In progress
  briefs/<id>.md       the seam contract (Out, Check, Owns, tier, report shape)
  reports/<id>.md      what was found and proved (Outcome, Evidence, Unverified, Scope, Lesson)
  state/checks.json    the last real check, bound to a HEAD
  config.json          this repo's checks and ownership
```

`config.json`, created on first use and seeded by `check init`:

```json
{
  "checks": [
    { "name": "unit", "command": "npm test", "timeout": 240000 },
    { "name": "lint", "command": "npm run lint", "timeout": 60000 }
  ],
  "ownership": { "ignore": [".stack/**", "dist/**"] }
}
```

There is no dispatch knob: `swarm` enforces the host's hard ceiling of ten seams, and the lead decides how many it can actually reconcile.

---

## Install

Windows-first, no admin rights, no per-file symlinks.

```powershell
cd Q:\PROJECTS\PERSONAL\oc-stacked
node scripts/install.mjs
```

The installer:

1. Junctions the repository to `%USERPROFILE%\.config\opencode\plugins\oc-stacked`. Edits here are live after a restart; there is no copy step for the plugin.
2. Copies the three agents into `%USERPROFILE%\.config\opencode\agents\`.
3. Copies the four commands into `%USERPROFILE%\.config\opencode\commands\`.
4. Runs the self-test and fails loudly if anything is wrong.

It does not rewrite your `opencode.jsonc`. To wire it by hand instead, add the directory:

```jsonc
"plugins": ["Q:\\PROJECTS\\PERSONAL\\oc-stacked"]
```

On first sight of a real project (a repository or a build manifest), the plugin seeds `.stack/` and detects the repo's proving commands. Detected checks are installed once, when the config is created or corrupt — never appended afterwards, so a trimmed list stays trimmed. A hand-written check survives every re-seed; a new test script in an existing valid config is not picked up on the next start. Delete or corrupt the config to re-detect from scratch.

Restart OpenCode, then prove it loaded:

```powershell
node scripts/check.mjs
opencode run --print-logs "say OK" 2>&1 | Select-String "oc-stacked"
```

Undo everything it added:

```powershell
node scripts/install.mjs --remove
```

---

## Fallback CLI

The gate has to work when the plugin does not load, so four commands run without OpenCode:

```text
node bin/stack.js check init|run|show
node bin/stack.js ready --id <seam> [--lean]
node bin/stack.js clean [--op sweep|report]
node bin/stack.js ledger digest
```

`--dir <path>` picks the repository; exit codes are 0 success, 1 refusal, 2 bad usage. The CLI and the plugin tools share one implementation in `lib/`, so the CLI never reimplements a rule.

## First run

```text
/stack stop the webhook delivery loop from retrying forever
```

1. The lead restates the objective, lists constraints and unknowns, and cuts seams.
2. `brief` writes `.stack/briefs/retry-budget.md` with Out, Check, and Owns. If the check is not obvious, the lead proposes the cheapest honest one instead of inventing a green.
3. An employee is dispatched with `Seam`, `Brief`, and the report path. It reads the brief, makes the smallest change, runs the check, and writes `.stack/reports/retry-budget.md`.
4. `/stack-check` runs the configured commands and records the result against HEAD.
5. `/stack-ready retry-budget` answers:

   ```text
   ## GO — seam retry-budget

   - pass · brief: .stack/briefs/retry-budget.md
   - pass · report declares nothing unverified
   - pass · checks green at 4f2c1ab: unit, lint
   - pass · tree clean at 4f2c1ab on retry-budget
   ```

6. `/stack-digest` rewrites the digest and names the next action.

---

## How the guarantees are actually kept

| Guarantee | Mechanism |
|---|---|
| A brief cannot be vague | `brief` validates Out, Check, and Owns and writes nothing when one is missing. |
| Green means green *here* | `check` stores the HEAD; `ready` refuses a result from another HEAD and names both shas. |
| No quiet scope creep | `scope` maps every changed path against `Owns`; `ready` fails on anything outside it. |
| No two workers touch one file | `swarm` and `brief` compare exact `files` across every live seam and refuse a collision; same folder is allowed, same file is not. |
| One proof at a time | `brief` and `swarm` run the file-disjointness check inside the state lock, so two writers cannot both pass against different indexes. |
| A seam cannot take a device or the seal | `con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9` are refused as seam ids, and no seam may claim `.stack/state/**`. |
| An override is explicit or absent | `force` is `true` or absent; any other value is refused. Statuses are a closed set: `briefed`, `building`, `ready`, `landed`, `killed`. |
| A check runs where it was written | An unquoted absolute path with a space in a configured check command is refused rather than silently split. |
| A shim still starts on Windows | `npm`, `npx`, `pnpm`, `yarn`, `corepack` route through the shell; a failed direct spawn falls back to the shell. |
| A busy file still writes | `writeAtomic` retries `EPERM`/`EACCES`/`EBUSY`; a lock records its pid so a dead holder is recovered immediately. A leading BOM in a JSON state file is ignored, not treated as corruption. |
| A worker cannot multiply | The employee agent's permissions deny `subagent`; the dispatch template forbids it. |
| Verdicts are independent | The auditor runs the check itself and may not edit; its skill forbids fixing the code it judges. |
| Nothing is lost to compaction | The ledger is append-only and the digest is derived from it, not hand-maintained. |

---

## Requirements and limits

- **OpenCode 2.0.4 or newer**, verified on 2.2.6. A V1-compatible export is kept for older hosts (skills and bootstrap; the tool domain does not exist there).
- **Node 20 or newer.** No build step, no transpiler, no dependencies.
- **git is optional.** Without a repository, `scope` says it cannot audit and `ready` gates on brief, report, and checks only. It says so rather than assuming clean.
- **Two pins, no surprises.** The lead inherits the session model, so the TUI selection always wins. EMPLOYEE is pinned to `deepseek-v4.1-flash` and AUDIT to `gpt-6.1-terra`; a brief records a tier (`cheap`, `standard`, `expert`) and the delegated seat supplies the model.
- **No GitHub coupling.** Nothing reads or writes a remote, a PR, or an issue.
- **No telemetry.** The only files written are inside the project's `.stack/` and the OpenCode config directory at install time.
- **`check` is code execution by design.** It runs the shell commands in `.stack/config.json`. That file is repo-controlled, so treat a cloned project's config the way you treat a `Makefile` or a `package.json` script: read it before you run it. `check` prints every command and its exit code, and refuses to run at all when `OC_STACKED_NO_EXEC=1`.
- **Three environment flags**, for hosts with strict process rules: `OC_STACKED_NO_EXEC=1` (never spawn; print the commands instead), `OC_STACKED_NO_SEED=1` (never create `.stack/`), `OC_STACKED_TRACE=1` (log every child process to stderr).

---

## License

MIT. Lineage and inspiration: [`SOURCES.md`](SOURCES.md).
