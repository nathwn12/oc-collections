# Changelog

One entry per landed pass. Written in plain words; internals live in the commit bodies.

## 0.3.0

The release that became a company.

**Twenty-four agents, seven departments.** One `lead`, one `auditor`, and twenty-two specialists: engineering, product, design, quality, platform, knowledge, research. Every file is a bare name, so the TUI shows `frontend` rather than `stacked-frontend`. The lead is unpinned and inherits the session model; the delegated seats are pinned by `routing.json`.

**Models chosen by what the seat does.** Writing code takes `deepseek-v4.1-flash`; planning, review and verification take `gpt-6.1-terra`; everything else takes `muse`. Routing ships unset in the repo and is applied at install, so a fork inherits no one else's preferences.

**A research department.** `researcher`, `scout` and `fact-checker` exist because local knowledge is dated: the upstream repository, the changelog, the issue thread and the release notes win over anything already on disk, and a claim without a quoted line is not a finding.

**Seven department handbooks.** Each seat reads its own reference — what it owns, what it refuses, what its report must contain — instead of one general-purpose prompt pretending to cover everything.

**A fallback CLI.** Four commands in `bin/stack.js` that read `.stack/` directly and import nothing from the plugin, because the gate has to work on the day the plugin fails to load. It never spawns a process of its own.

**Conventions written down.** `OWNER.md` holds the standing decisions the lead may not re-derive. `RELEASING.md` fixes the commit, branch, tag and release formats to the upstream ones rather than a house dialect. Session titles carry `[active]`, `[parked]` or `[done]`, and `[done]` is immutable.

**Two seats that had no home.** `stacked-wizard` is the doctor and the init: it reads a host that already has its own config, prints a table of `OK` / `FIXABLE` / `OWNER`, and aligns by adding - never by rewriting, never by overwriting a file whose hash differs from the package copy. `stacked-oftb` is the out-of-the-box decision maker: it sorts a block into owner gate, doctrine default or physics, then climbs six rungs before anyone writes an `ASK`. Its honesty floor is the point of it - craft lives in sequencing and observation, never in evidence, and when every route crosses a gate it says "the block is real" in three lines.

**A loop of our own.** `stacked-loop` takes the one idea worth taking from upstream goal loops - completion is judged by a fresh model, not the one doing the work - and puts the goal in `.stack/goal.md` where a compaction cannot eat it: Out, Check, Constraints, Budget, Assumption. Each turn routes, acts small, and ends with a verdict and a reason; the reason becomes the next turn's directive. Two turns with no new evidence stops it, and the groundhog rule stops a seat that keeps returning the same verdict. The route table is in the always-on bootstrap now, so every request is dispatched by signal rather than by habit. Commands stay manual: the loop never types one.

**Two rules that were wrong.** The stop list now has exactly five items, and a savepoint is a commit type rather than a prefix, so an unverified tree is labelled instead of hidden.

**The lead holds the boundary by routing.** The seat's hard line is a rule with a test: the lead writes only `.stack/`, and every source change is a seam, even a one-line fix. One file and one edit is still dispatched, two or more files are seamed and ranked, and a task with no file yet goes to the department that owns it. A lead that reaches for an editor dispatches instead, because work it did itself is work nobody audited.

93 checks, all green.

## 0.2.0

The release that stopped trusting itself.

**Seats.** The CEO seat is gone. Three remain: `lead` decides and dispatches, `employee` builds one seam, `auditor` gives the verdict on work it did not write. The owner is the CEO; the lead speaks for them and stops only for the five owner gates. Agent files are bare names, so the TUI reads `lead` rather than `stacked-lead`.

**New skill `stacked-pls`.** The decision seat, distilled from the harness's own `pls`: the three questions, the gap sweep with a receipt per call, one rung of deepening, one locked brief, then execution. Two exits — shape a vague ask into a brief and stop, or execute to a check that can go red.

**New tool `clean`.** The closing sweep. Removes only artifacts the plugin itself left under `.stack/` — atomic-write leftovers, stale locks, the debug log, empty directories — and names junk that is not its own without deleting it.

**The gate no longer trusts a file.** `ready` re-runs the configured checks itself at the current HEAD instead of reading a record a worker could write. A forged record, an empty result list, a missing base commit, a report copied from the brief, and a config edited mid-seam are all refused.

**State that survives a crash.** Index writes are atomic and locked; the ledger tolerates CRLF and a missing trailing newline; a corrupt `briefs.json` is reported instead of silently replaced by an empty one; the digest renders the intake objective from the whole ledger, not the last window.

**Windows-grown correctness.** `git status --porcelain -z` is parsed with its NUL separators intact, so a rename names both paths and a created file cannot hide. The check runner keeps NULs, decodes UTF-16 when it sees it, quotes `/c` correctly, kills a timed-out process tree, and refuses to run a `.cmd` shim without a shell.

**Auto-maintained.** `.stack/` is seeded on first sight of a project and re-seeded without ever removing a hand-written check. It carries its own `.gitignore`, so `state/` and `plugin.log` never enter your history.

**Sharp output is a rule**, not a mood: result first, numbers over adjectives, `file:line` or `UNVERIFIED`, one screen.

81 checks, all green.
