# Publishing rea-shim (owner only)

`npx rea-shim@latest` installs the launcher only. Upstream `rea-agents` is
resolved at RUN time via npx (always at latest unless pinned with
`REA_SHIM_AGENTS_VERSION`) - never at install, never bundled. The explicit
`--bootstrap` run can install an exact upstream `rea-agents` release plus the
official Ghidra and JDK that release requires into a per-user install root;
that happens only when the user asks for it, never from a postinstall script.
Do NOT publish, tag, or release from any automated session: the tag push is a
human act.

## Release lane

`rea-shim` is released from the `nathwn12/oc-collections` monorepo, not from
its original repo. The root `release` workflow triggers on `**@*` and
publishes over OIDC with provenance. The lane has executed four runs, one
package per run, every one publishing successfully over OIDC with provenance,
so the trust is proven rather than assumed (see the monorepo root
`MIGRATIONS.md`). One step is still unproven: the post-publish registry verify
lost npm's propagation race in all four runs, and its retry has not yet been
exercised by a real release.

1. Push `rea-shim@<version>` (e.g. `rea-shim@0.2.2`). The tag version must
   equal `packages/rea-shim/package.json` and be strictly newer than every
   published version; `scripts/release-target.mjs` refuses anything else.
2. A `v<version>` tag does nothing - it does not match the trigger.
3. `rea-shim` is one of the four allowlisted packages in
   `scripts/release-target.mjs`; the dispatch choice list in
   `.github/workflows/release.yml` matches it.

The trusted-publisher binding, when configured, must name
`nathwn12/oc-collections` and `.github/workflows/release.yml`.

## Version checklist

A release tag `rea-shim@X.Y.Z` requires, on that commit:
`packages/rea-shim/package.json` version `X.Y.Z` and a `CHANGELOG.md` entry.
There is no Cargo crate. There is no shim-side Ghidra or JDK version table to
update: bootstrap reads the accepted Ghidra line from the exact `rea-agents`
release it installs and the Java minimum from that Ghidra's
`application.properties`. Upstream `rea-agents` still resolves at run time, so
it never appears in the version checklist.

`repository.url` in `package.json` names
`https://github.com/nathwn12/oc-collections` with
`directory: packages/rea-shim`; provenance requires it. `package.json` carries no lifecycle hook (`postinstall`/`prepare`/`prepublishOnly`): a
postinstall download would silently never run under npx, so upstream is
acquired on first RUN by the launcher instead. The only scripts are the
development pair `test` and `check`, which are never invoked by an install,
plus a `files` list that ships `bin/`, `lib/`, the two docs and the assets.
The workflow runs on a GitHub-hosted runner with `id-token: write` (OIDC
requirement); self-hosted runners are not trusted publishers.

## Release evidence

The package's `npm test` suite is an offline contract suite: fixtures and
injected runners, no downloads and no real engine. It is required, but the
part that spawns the launcher drives a stub upstream, so it proves the stdio
channel, never upstream's inventory. `npm run check` syntax-checks every
`bin/` and `lib/` file, and `test/package.test.js` guards the manifest
(no runtime dependency, no `@opencode/*` dependency, an `engines` range).
Runtime proof is still the clean Windows Sandbox run documented in
`docs/GUIDE.md`.

Before calling a release proven, run the clean Windows Sandbox acceptance
recipe in `docs/GUIDE.md` from the candidate checkout
(`node packages/rea-shim/bin/rea-shim.js --bootstrap`): no Java and no Ghidra
installed, one bootstrap command, then the upstream doctor, MCP tool
inventory and a Ghidra analysis with an observed evidence id. Record the
date, the exact upstream version, the official Ghidra version, the Temurin
version and the captured output. Do not describe a contract-suite pass as a
runtime proof.

## No monthly bump workflow

There is no scheduled bump workflow. rea-shim pins no external runtime -
upstream `rea-agents` resolves at `@latest` on every run and bootstrap
resolves official archives from release data at run time - so there is
nothing scheduled to bump.
