# Changelog

One entry per landed pass. Written in plain words; internals live in the commit bodies.

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
