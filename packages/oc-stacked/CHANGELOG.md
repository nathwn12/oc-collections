# Changelog

One entry per landed pass. Written in plain words; internals live in the commit bodies.

## Unreleased

The close seals itself, and the receipt is evidence.

**Added.** Closing a session is a fixed ceremony a skill owns now: `stacked-close` settles every open ticket, sweeps the leftovers, aligns the docs to the diff, records one lesson, writes the report, then seals the receipt and compacts. The last thing a session does is loaded, not remembered — a step skipped is named in the report, and the session ends on evidence, not on a summary.

**Added.** A `close` op=run that returns GO arms the close itself: the idle gate applies `[done]` from the sealed report, so no typed phrase is needed. `show`, `preflight`, and a refused run arm nothing.

**Fixed.** A `close` that returns GO now finishes the session by itself, including the compaction, without a typed phrase or a hand-armed intent. Run it from the command line, end on the sealed report, and the session compacts once and takes `[done]`. Before this, a command-line close wrote the arm record and nothing consumed it, so a sealed session never compacted and never got `[done]`.

**Changed.** The receipt is signed now. It binds the full 40-hex HEAD, a uuid receipt id, a check run at that HEAD with every result green and exit 0, a passing preflight, a timestamp inside the commit's window, and a lesson of at least 8 characters. The signature is an HMAC-SHA256 keyed by a secret outside the repository. It stops a typed receipt; it does not stop someone who can read the secret.

**Changed.** Every NO-GO writes a refusal record (`go: false`) over the old GO; nothing is deleted. A refused close destroys an earlier GO on purpose. A receipt older than the run is never overwritten by a later refusal; a newer refusal replaces an older GO; two simultaneous runs end with the later receipt.

**Changed.** Sealing fires one real session compaction with a 15-second deadline; a failed or timed-out compaction does not stop the seal. The digest is rewritten from the ledger before the report, and is not the compaction. The ceremony order is checks, sweep, junk report, lesson, digest, atlas.

**Changed.** All four spellings reach the same tool (`stack_close`, `stack.close`, `oc_stack_close`, `oc.stack.close`). `brief` and `swarm` prove file-disjointness inside the state lock. Reserved Windows device names are refused as seam ids, and no seam may claim `.stack/state/**`. `force` is `true` or absent; statuses are a closed set; an unquoted absolute path with a space in a check command is refused rather than silently split.

**Changed.** Detected checks are installed once, when the config is created or corrupt — never appended afterwards, so a trimmed list stays trimmed. `Cargo.toml` yields `cargo test` only when there is Rust code to test — a package with a `src/` directory or a declared lib/bin path that exists, or a workspace member that resolves to a real manifest — so an empty virtual workspace, a member that does not exist, and a manifest with no code all add nothing. The manifest syntax validator is gone: two audits showed that shape validation could not be trusted, and a filesystem fact cannot be spelled wrong.

**Fixed.** On Windows, `npm`/`npx`/`pnpm`/`yarn`/`corepack` route through the shell, and a failed direct spawn falls back to the shell. Atomic writes retry on a busy file, a lock names its holder so a dead one is recovered at once, and a leading BOM in a JSON state file is ignored instead of treated as corruption.

## 0.4.0

The close is a command, not advice.

**Added.** The session title carries the live status: `[active]` while work moves, `[parked]` when the owner says stop (or a run is interrupted), `[done]` only when the close returns GO. Say "close session", "wrap it up", "we're done" or "seal it" and the plugin appends the directive: `close` op=preflight first — it lists every open ticket (unanswered ASK, unlanded brief, missing audit, dirty tree, no checks, failing atlas) — settle each one, then op=run with one lesson. It runs the checks, the sweep, the junk report, the lesson, the digest and the atlas at the final tree, and seals the GO receipt in `state/close.json`; op=show reads it back. A hand-typed `[done]` without a valid receipt is refused. If the close goes green, you don't need to say any magic words — the session seals itself with `[done]` after the final report.

**The receipt is signed.** It binds the full 40-hex HEAD, a uuid, a check run at that HEAD with every result green, a passing preflight, a lesson of at least 8 characters, and an HMAC signature keyed outside the repo. A typed-up receipt no longer passes; someone holding the machine's secret still could.

**A refused close leaves a tombstone, not a hole.** Every NO-GO writes `{ go: false, ... }` over `state/close.json`, so an earlier GO cannot survive a later failure. Two closes racing each other end with the later receipt.

**The seal compacts the session.** Sealing fires one real session compaction with a 15-second deadline; a compaction that fails or hangs never stops the seal. The digest file is separate — rewritten from the ledger, not the compaction.

**Changed.** The `stacked-pls` Close is one fixed path now: preflight, settle, run — a NO-GO names the reason to fix, and only a GO makes `[done]` possible. All four spellings of a stack tool work (`stack_close`, `stack.close`, `oc_stack_close`, `oc.stack.close`). Node-package-manager checks (`npm`, `npx`, `pnpm`, `yarn`, `corepack`) run through the shell on Windows instead of failing to start, with a shell fallback when a direct spawn fails. Your `.stack/config.json` is yours after the first seed: detected checks are installed once and never appended over your choices — delete or corrupt the config to re-detect. Rust repos only get a `cargo test` check when the manifest can actually build tests; an empty virtual workspace adds none. A seam cannot take a reserved device name or claim `.stack/state/**`, `force` is `true` or absent, and a check command with an unquoted absolute path containing a space is refused rather than silently split.

**Changed.** The `stacked-pls` Close is one fixed path now: preflight, settle, run — a NO-GO names the reason to fix, and only a GO makes `[done]` possible.

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

**Windows-grown correctness.** `git status --porcelain -z` is parsed with its NUL separators intact, so a rename names both paths and a created file cannot hide. The check runner keeps NULs, decodes UTF-16 when it sees it, quotes `/c` correctly, kills a timed-out process tree, and routes `npm`/`npx`/`pnpm`/`yarn`/`corepack` through the shell on Windows, treating status `-4058`/`9009` as a failed start with shell fallback. Atomic writes retry `EPERM`/`EACCES`/`EBUSY`, a lock records its pid so a dead holder is recovered immediately, and a leading BOM in a JSON state file is ignored rather than treated as corruption.

**Auto-maintained.** `.stack/` is seeded on first sight of a project and re-seeded without ever removing a hand-written check. It carries its own `.gitignore`, so `state/` and `plugin.log` never enter your history.

**Sharp output is a rule**, not a mood: result first, numbers over adjectives, `file:line` or `UNVERIFIED`, one screen.

81 checks, all green.
