# oc-stacked

A three-rung agent stack for OpenCode: one lead, a fresh employee per seam, and an auditor that wrote none of it. Local-first, zero MCP, eight tools, no runtime dependencies.

## Quick start

To work on it, from this package's directory (`packages/oc-stacked` in the monorepo):

```sh
node scripts/check.mjs
```

`node scripts/check.mjs` runs the suite. It must be green before a PR. It takes minutes; the close-ceremony and title-gate checks dominate.

## Layout

- `index.js` — plugin entry: hooks, the close loop, the idle gate, the title gate.
- `lib/close.js` — the ceremony: preflight, the ordered run, the signed receipt, the refusal tombstone, the arm record.
- `lib/tools.js` — the eight local tools: `ledger`, `brief`, `swarm`, `check`, `scope`, `ready`, `clean`, `close`.
- `lib/checks.js` — what is configured, one run bound to its HEAD, what a record proves.
- `lib/state.js` — seeding, atomic writes, the state lock, the ledger, the digest.
- `lib/exec.js` — the command runner: direct spawn first, shell only when the syntax or a Windows shim needs one.
- `lib/git.js`, `lib/text.js`, `lib/title.js`, `lib/content.js`, `lib/bootstrap.js` — one concern each, behind the files above.
- `scripts/check/` — the suite, one module per concern; `scripts/check.mjs` is the documented command.
- `bin/stack.js` — the fallback CLI for when the plugin does not load.
- `skills/`, `agents/`, `commands/` — the seats and the owner's commands.
- `README.md` — the user record; `CHANGELOG.md` — release history, one entry per landed pass.

## Conventions

- The document follows the artifact. A behaviour change updates `README.md` in the same seam; the sentence is fixed, never corrected by appending.
- A changelog entry is written for the person deciding whether to upgrade, in their words — never in commit language.
- A number has its definition and its source. Never paste check output the script did not print; never claim a count, a run count, or a date you cannot read from the repo.
- Land only through a pull request, squash-merged, then delete the branch.

## Guardrails

- The receipt is signed: full 40-hex HEAD, `sealed` as its first 7 characters, a uuid `receipt_id`, a check run at that HEAD with every result `ok` and exit 0, a passing `preflight` criterion, an `at` inside the commit's window, a lesson of at least 8 characters, and an HMAC-SHA256 `sig` keyed by `~/.config/opencode/oc-stacked.secret`. The signature stops a typed receipt, not someone with read access to the secret.
- Every NO-GO writes a tombstone (`{ go: false, ... }`); nothing is deleted. A refused close destroys an earlier GO on purpose. A receipt older than the run is never overwritten by a later refusal; a newer refusal replaces an older GO; two simultaneous runs end with the later receipt.
- A `close` op=run that returns GO writes the one-shot arm record; the idle gate then applies `[done]` from the sealed report with no phrase. `show`, `preflight`, and a refused `run` arm nothing.
- Sealing fires one `ctx.session.compact` with a 15-second deadline; a failed or timed-out compaction never stops the seal. The digest is rewritten from the ledger and is not the compaction.
- `brief` and `swarm` prove file-disjointness inside the state lock. Reserved Windows device names are refused as seam ids; no seam may claim `.stack/state/**`; `force` is `true` or absent; statuses are `briefed`, `building`, `ready`, `landed`, `killed`; an unquoted absolute path with a space in a check command is refused rather than silently split.
- Detected checks are installed once — when the config is created or corrupt — never appended. `cargo test` is detected only for a real `[package]` or a non-empty `[workspace]` members list.
- On Windows, `npm`/`npx`/`pnpm`/`yarn`/`corepack` route through the shell with fallback when a direct spawn fails. `writeAtomic` retries `EPERM`/`EACCES`/`EBUSY`; the lock records its pid; a leading BOM in JSON state is ignored.
- Never touch `lib/`, `index.js`, or `scripts/` to fix a doc sentence. The document follows the artifact.

## Speed

- A chokepoint is a defect. Time the command before and after with a real timer; guessing is not measuring.
- Verify surgically: run the subject a change can break, not every subject. The full suite is for the seal and for CI, and for nothing else.
- When something is slow, build the faster path: a filter, a cache keyed on exact inputs, a parallel worker, a narrower command, a fixture that skips a subprocess. Name the measurement that proves it is faster.
- A change that makes a default path slower carries its written reason in the same seam, or it does not land.
- A budget that cannot be met is stated as a number, never as "slow". The number becomes a test, so the regression cannot return silently.
