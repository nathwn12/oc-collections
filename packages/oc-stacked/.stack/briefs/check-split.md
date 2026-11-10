# check-split

## Out

`scripts/check.mjs` is 1,844 lines asserting the entire tree from one file, which makes it the collision point for every parallel seam - two workers could not run tonight because both needed this file. It becomes one runner plus one file per subject.

1. **`scripts/check/index.mjs`** - the runner. Defines `check(name, fn)`, `checkAsync(name, fn)`, `assert`, the counters, the coloured `pass`/`FAIL` lines, the summary line, the exit code, and the shared helpers that more than one subject file genuinely needs (`tmpRepo`, `configuredRepo`, `runIn`, `commitAll`). It then imports and runs each subject module in order.
2. **One file per subject**, each exporting `register({ check, checkAsync, assert, ...helpers })` and containing only its own assertions:
   - `agents.mjs` - agent files, roster, permissions ordering (the three assertions added by `permission-truth` and `employee-permissions` live here)
   - `content.mjs` - skills register, ids, front matter, bootstrap shape and char budget
   - `state.mjs` - atomic writes, lock, ledger, digest, seed
   - `exec.mjs` - the runner, tokenizer, timeout, UTF-16, `.cmd` refusal
   - `git.mjs` - porcelain `-z`, rename pairing, committed paths
   - `tools.mjs` - the seven tools and their refusals
   - `gate.mjs` - `ready`/`scope`/`check`/`clean` behaviour, GO/NO-GO, forged records
   - `plugin.mjs` - load surface, imports, marker, registration wiring
3. **`scripts/check.mjs` stays**, as a three-line entry point that imports the runner. It is not a pass-through module: it is the documented command in `README.md`, `package.json`, `scripts/install.mjs` and three skills, and moving the command would be a separate, larger change.
4. **The count does not move.** Whatever `node scripts/check.mjs` prints before the split, it prints after - same number, same names. Nothing deleted, nothing weakened, no assertion "temporarily" skipped. Paste the before and after summary lines.

Divide by subject, not by line count. A subject file may be 80 lines or 400; what matters is that a future seam touching agent permissions edits exactly one file.

## Check

```text
node scripts/check.mjs
```

Exit 0, summary line identical to the pre-split run except for timing. Paste both lines verbatim in the report.

Also paste the `wc -l` (or `Measure-Object -Line`) for every file you created, so the split is visible as made rather than claimed.

## Owns

`scripts/check.mjs`, `scripts/check/**`

## Do not touch

`lib/**`, `agents/**`, `skills/**`, `commands/**`, `bin/**`, `scripts/install.mjs`, `README.md`, `CHANGELOG.md`, `package.json`. If an assertion needs a helper that lives in another subject file, put the helper in the runner rather than importing across subjects.

## Read first

- `scripts/check.mjs` in full. All of it. You cannot divide a file you have only skimmed, and a missed assertion is the one failure this seam must not produce.
- `.stack/reports/permission-truth.md` and `.stack/reports/employee-permissions.md` for the assertions added most recently.

## Tier

Refactor. Zero behaviour change, zero assertions lost. The count is the contract.
