# Publishing rea-shim (owner only)

`npx rea-shim@latest` installs the launcher only. Upstream `rea-agents` is
resolved at RUN time via npx (always at latest unless pinned with
`REA_SHIM_AGENTS_VERSION`) — never at install, never bundled. Do NOT
publish, tag, or release from any automated session: the tag push is a
human act.

## Release lane

rea-shim is released from the `nathwn12/oc-collections` monorepo, not from
its original repo. The root `release` workflow triggers on `**@*` and
publishes over OIDC with provenance; the workflow is statically validated
but has never executed, so OIDC trust is unproven (see the monorepo root
`MIGRATIONS.md`).

1. Push `rea-shim@<version>` (e.g. `rea-shim@0.1.2`). The tag version must
   equal `packages/rea-shim/package.json` and be strictly newer than every
   published version; `scripts/release-target.mjs` refuses anything else.
2. A `v<version>` tag does nothing — it does not match the trigger.
3. `rea-shim` is one of the four allowlisted packages. `gladius-mcp` and
   `puppet-mcp` stay on their original release lanes; `oc-unified` and
   `oc-todo` are not releasable from here.

The trusted-publisher binding, when configured, must name
`nathwn12/oc-collections` and `.github/workflows/release.yml`.

## Version checklist

A release tag `rea-shim@X.Y.Z` requires, on that commit:
`packages/rea-shim/package.json` version `X.Y.Z` and a `CHANGELOG.md`
entry. There is no Cargo crate, no engine manifest, and no pinned runtime:
upstream `rea-agents` resolves at run time, so it never appears in the
version checklist.

`repository.url` in `package.json` names
`https://github.com/nathwn12/oc-collections` with
`directory: packages/rea-shim`; provenance requires it. `package.json` has
no `scripts` field at all: a postinstall download would silently never run
under npx, so upstream is acquired on first RUN by the launcher instead.
The workflow runs on a GitHub-hosted runner with `id-token: write` (OIDC
requirement); self-hosted runners are not trusted publishers.

## No monthly bump workflow

The gladius `browser-update` workflow exists only because gladius pins an
external Chromium build that drifts monthly. rea-shim pins no external
runtime — upstream `rea-agents` resolves at `@latest` on every run — so
there is nothing scheduled to bump.
