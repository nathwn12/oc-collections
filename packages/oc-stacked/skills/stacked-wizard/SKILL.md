---
name: Stacked Wizard
description: Align an existing harness to oc-stacked - doctor, repair, init, re-align after an upgrade. Use when oc-stacked is installed but not behaving (agents missing, models unpinned, .stack unseeded, plugin loaded twice, a stale seat, a check that passes on a stale tree), or before a first run on a machine that already has its own config.
license: MIT
---

# Stacked Wizard

One job: take a host that already has opinions and make oc-stacked work there without breaking a single one of them.

This is an init, a doctor and a repair pass in the same seat. It is not a walkthrough for a human - every step is executed by you. If a step can only be done by the owner, it is reported as `OWNER`, not attempted.

## The rule that outranks the others

**Align by adding, never by rewriting.** The owner's config, `AGENTS.md`, MCP entries, model choices and permissions are data, not a draft. You may append a missing line. You may not reformat, reorder, "tidy", or decide a setting was a mistake. If something must change rather than be added, it becomes an `OWNER` row with the exact edit quoted.

## Phase 1 - Read, write nothing

Gather all of it before touching anything. Each line is a command, not a feeling.

| Probe | Command |
|---|---|
| host version | `opencode --version` |
| config parses | strip `//` lines, `JSON.parse` the rest - a JSONC file that fails to parse is silently ignored by the host |
| plugin loaded | `opencode run --print-logs "say OK" 2>&1 \| Select-String -i oc-stacked` |
| registered plugins | the `plugins` array in the host config (V2) or `plugin` (V1) |
| agents shipped vs installed | `agents/` file count in the package against `~/.config/opencode/agents/*.md` |
| models pinned | `routing.json` against a `model:` line in any installed agent |
| `.stack/` state | `.stack/config.json`, `.stack/ledger.jsonl`, `.stack/state/checks.json` |
| check green | `node scripts/check.mjs` in the package - the package's own suite, not the host's |
| `stack` on PATH | `Get-Command stack` - must resolve, or the fallback gate is a story you tell |

## Phase 2 - Diagnose

Print one table. No prose paragraph above it.

| Symptom | Verdict | Fix |
|---|---|---|
| fewer agent files installed than `agents/` holds | `FIXABLE` | run the package's install; it prunes ghosts and writes the missing seats |
| `model:` line inside an installed agent | `OWNER` | routing is `routing.json`'s job; quote the line and the intended id |
| plugin listed twice, or under both keys | `FIXABLE` | leave one, in the key the host version reads |
| `.stack/` missing in the project | `FIXABLE` | seed it; never remove a hand-written check while seeding |
| stale seat present (a file for a seat the package deleted) | `FIXABLE` | the install prunes it; confirm by name in the report |
| config does not parse after comment stripping | `OWNER` | the host is ignoring this file entirely; quote the failing offset |
| `stack` resolves to nothing | `FIXABLE` | link the bin, then `Get-Command` again - an unverified install is not an install |
| check passes but the tree is older than the claim | `FIXABLE` | re-run at the exact HEAD and report the verbatim line |

Every row ends `OK`, `FIXABLE` (you did it), or `OWNER` (you did not).

## Phase 3 - Align

Order matters. Each step reversible, each named in the report.

1. **Seed `.stack/`** in the project. It writes its own `.gitignore`; `state/` and `plugin.log` never enter history. A hand-written check in `config.json` is preserved.
2. **Install the seats.** Only files whose hash differs from the package copy are written; anything that differs gets `.oc-stacked.bak` beside it and an `OWNER` row, because a hand-edited agent is the owner's file.
3. **Register the plugin once.** Add the spec if absent; if present, change nothing.
4. **Pin the models** from `routing.json` at install time, in the copies, never in the package.
5. **Prove the gate.** `node bin/stack.js check run` in the aligned project. Not `check show` - `show` reads a record, `run` executes.

Do not restart anybody's host mid-flight. Change the config, prove with a handshake in a throwaway process, and let the next start be the replug - a live server swapped under a session is a tool surface that dies silently.

## Phase 4 - Prove, then report

Two receipts, both verbatim:

```text
node scripts/check.mjs            -> <the last line, with its count>
node bin/stack.js check run       -> <the last line, with its exit code>
```

If a command that matters cannot be run, write `Unverified: <what> - <why>`. A wizard that reports success without the line is the exact failure it was hired to prevent.

Report shape:

```text
Aligned. <n> changed, <n> already correct, <n> for the owner.
- agents: 3 installed -> 24, 1 ghost pruned (ceo.md)
- routing: 22 pinned, lead unpinned
- .stack: seeded, 1 hand-written check preserved
- OWNER: agents/frontend.md carries `model: ...`; routing.json says `...`. Pick one.
- rollback: node scripts/install.mjs --remove
```

## Hard rules

1. **A user's config is data.** Add, never rewrite. Quote what you would have changed.
2. **Never overwrite a differing file.** Hash it, back it up, report it.
3. **Never prune a file you cannot name** in the report. "Cleaned some stale files" is a confession.
4. **One runtime per variable.** If you are also changing a version, changing the runtime in the same pass makes both results ambiguous - say so, or do them in two passes.
5. **Crafty about sequencing, never about evidence.** The clever move is the order of operations: unplug, swap, handshake, replug. The moment "clever" means a green you did not run, it is a false green and this skill has failed.
6. **The owner's five stops still stop you.** Alignment is reversible and local. Publishing, credentials, money and irreversible edits are still `OWNER`, no matter how well the plan fits.
