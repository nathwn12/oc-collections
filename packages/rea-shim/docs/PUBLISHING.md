# Publishing rea-shim (owner only)

`npx rea-shim@latest` ships the launcher only. It carries no upstream code and no install-time script. The pinned Craft Anything archive is verified and downloaded by the launcher on first run, never by a package hook.

Do not publish, tag or release from an automated session. Publication is an owner act.

## Release lane

`rea-shim` is released from the `nathwn12/oc-collections` monorepo. A merge to `main` runs `scripts/derive-release.mjs`, which derives the next version from the conventional commits since the package's highest tag. The release workflow gates, publishes over OIDC with provenance and creates the tag at the pushed commit. A `v<version>` tag does nothing; the workflow does not trigger on tags.

`rea-shim` is one of the allowlisted packages in `scripts/release-target.mjs`, and the dispatch choice list in `.github/workflows/release.yml` matches it. The trusted-publisher binding names `nathwn12/oc-collections` and that workflow. Self-hosted runners are not trusted publishers.

## Version checklist

A release requires `packages/rea-shim/package.json` and a `CHANGELOG.md` entry on the same commit. Bump the root index version cell in the same change; a manifest bump without that cell fails the structural index check.

The upstream pin is data in `lib/sources.js`: tag, filename, byte count, SHA-256 and the native config key. A new upstream version needs its own independently verified hash before the pin moves. There is no scheduled bump and no background updater.

`repository.url` names `https://github.com/nathwn12/oc-collections` with `directory: packages/rea-shim`; provenance requires it. The manifest has no install-time lifecycle hook. Its development scripts are `test` and `check`; `prepublishOnly` runs `node ../../scripts/check-version-cell.mjs .` only at publish time as a version guard, never during an npx install. The `files` list ships `bin/`, `lib/`, the two docs and the assets.

## Version reconciliation

The historical tag `rea-shim@0.2.4` carried a manifest declaring 0.2.3. This release moves the manifest to 0.3.0, derived from the highest tag under the 0.x breaking rule, and names that drift in the changelog. The owner resolves the live registry tag pair before tagging.

## Release evidence

`npm test` is an offline contract suite: small local archives and injected runners, no download and no third-party process. `npm run check` syntax-checks every shipped source file. The package test also guards the manifest: no runtime dependency and an `engines` range.

These checks are not runtime proof. First-run window reachability, reuse with zero fetch and recovery from a damaged payload need an isolated native run with a staged or fixture artifact, recorded separately with timestamps and an image. Do not describe a contract-suite pass as a window start.

Before publishing, verify that the packed contents carry no old launcher, no server block and no bootstrap command. Publishing from any other tree may silently redeploy the former behaviour under the same package name.
