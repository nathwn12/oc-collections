# Gate allowlist: check-2 keyword residuals

Check 2 of the repo quality gate (the seven-check pre-publication gate) greps
the public `HEAD` tree for eight marker tokens (task markers, an `X`-triple, and
placeholder wording). Every match in this repo is either fixed in-tree or listed
below with its reason. This file is deliberately written without any of those
tokens, so the allowlist itself adds no matches.

## Residuals

| file | matched text | why it stays |
| --- | --- | --- |
| `bun.lock` | the `X`-triple appears inside the base64 `sha512-…` integrity hash of `@opentelemetry/api-logs@0.219.0` | false positive: it is hash data, not a marker. Editing it would corrupt the lockfile and break `bun install --frozen-lockfile`. |
| `bun.lock` | `X`-triple inside the `sha512-…` integrity hash of `safer-buffer@2.1.2` | same: base64 hash data, not a marker. |
| `bun.lock` | `X`-triple inside the `sha512-…` integrity hash of `socks@2.8.10` | same: base64 hash data, not a marker. |

Verification: re-run the deciding command from a fresh `--depth 1` clone; the only
remaining matches are the three base64 hash substrings above. All other matches
found at scoring time were removed in-tree (see `CHANGELOG.md`).

Note: the fixtures' `fakeContext` helper is a test double used only by
`fixtures/run.ts`; it is test scaffolding, not shipped plugin behaviour, and its
name is descriptive rather than a placeholder.
