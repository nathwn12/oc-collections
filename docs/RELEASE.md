# Release lane

A merge to `main` is the release. `.github/workflows/release.yml` derives every
package version from the commits since its highest `<package>@<version>` tag, so
nothing here takes a version from a human and nothing is committed.

## Push

On every push to `main`, `node scripts/derive-release.mjs --all` lists each
package whose history has a releasable commit, with its derived version and tag.
A package with no releasable commit is skipped; when every package is skipped
the run prints `nothing to release` and exits 0.

Per package, in its own job, in this order:

1. derive the version from the commits since its highest tag,
2. refuse a version that moved since the plan,
3. skip the package when `<package>@<version>` already exists (a tag is never
   moved),
4. install, then close the package changelog at the derived version,
5. write the derived version into the package manifest, the root index cell and
   the lockfile workspace entry,
6. build, test, pack and cleanroom-install the tarballs,
7. assert the three version cells,
8. tag `<package>@<version>` at the pushed commit,
9. publish over OIDC with provenance,
10. verify the version on the registry,
11. restore every tracked file and prove `git status --porcelain` is empty.

Steps 4-5 run only in the runner: the tarball carries the closed changelog and
the derived version, but the commit, the index and the lockfile on `main` are
byte-identical to the pushed commit. No commit, no PR, no dispatch.

A refusal at the derivation, a version mismatch with the plan, or an existing
tag stops that package only: the job records the outcome and the other packages
carry on. The run's summary names every package as `released`,
`would release (dry run)`, `skipped (tag exists)` or `refused`. A failure past
the refusal - a broken build, a failed publish - still fails the run.

Legs run one at a time, because each one pushes a tag.

## Dispatch

`workflow_dispatch` is the escape hatch, not the normal lane:

- no package releases every package with a pending release (the same plan as a
  push),
- a package name forces that single package,
- `dry_run` (default on) runs the whole lane through the pack and a
  `npm publish --dry-run`, and stops before the tag and the publish.

## Cleanroom install

`node scripts/cleanroom.mjs` packs every workspace tarball with
`--ignore-scripts`, installs them into an empty project as `file:` dependencies,
and probes each installed copy from `node_modules/<name>`: every declared entry
point exists and every `files` entry landed. `npm run cleanroom` runs it;
`npm run cleanroom:check` proves the harness itself in both directions on
fixtures, including one that must be refused.

## Proving it locally

```bash
node scripts/derive-release.mjs --check    # derivation, writer and tag fixtures
node scripts/derive-release.mjs --all      # what a push to main would release
node scripts/derive-release.mjs --tag-exists '@nathwn12/janua@0.3.1'  # 0: exists, skip
node scripts/cleanroom.mjs --check         # harness green and red-on-broken
npm run build && node scripts/cleanroom.mjs
```
