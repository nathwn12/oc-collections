# Release lane

One dispatch, many packages. `.github/workflows/release.yml` derives every
version from the commits, so nothing here takes a version from a human.

## Batch or single

- Dispatch with **no package** and the run releases every package whose history
  has a pending release: `node scripts/derive-release.mjs --all` lists each one
  with its derived version and the refusal codes it would hit.
- Dispatch with **a package name** and the run is the single-package lane: the
  plan enforces every refusal and a refusal fails the dispatch.

Both modes fan out over one matrix, so a single package is a matrix of one.

## Per package

Each package gets its own job, in this order:

1. derive the version from the commits since its highest `<package>@<version>` tag,
2. refuse a version that moved since the plan,
3. close the package changelog at the derived version,
4. install, build, test, pack and cleanroom-install,
5. assert the manifest, the index cell and the lockfile,
6. commit the closed changelog to `main`,
7. tag `<package>@<version>`,
8. publish over OIDC with provenance,
9. verify the version on the registry.

A refusal at the derivation or at the version check stops that package only: the
job records `refused` and the other packages carry on. The run's summary names
every package as `released`, `would release (dry run)` or `refused`. A failure
past the refusal — a broken build, a failed publish — still fails the run.

Legs run one at a time, because each one commits to `main` and pushes a tag.

## Cleanroom install

`node scripts/cleanroom.mjs` packs every workspace tarball with
`--ignore-scripts`, installs them into an empty project as `file:` dependencies,
and probes each installed copy from `node_modules/<name>`: every declared entry
point exists and every `files` entry landed. `npm run cleanroom` runs it;
`npm run cleanroom:check` proves the harness itself in both directions on
fixtures, including one that must be refused.

## Proving it locally

```bash
node scripts/derive-release.mjs --check    # derivation fixtures
node scripts/derive-release.mjs --all      # today's pending release set
node scripts/cleanroom.mjs --check         # harness green and red-on-broken
npm run build && node scripts/cleanroom.mjs
```
