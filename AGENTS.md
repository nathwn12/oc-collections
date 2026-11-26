# oc-collections

## Landmines / do-not-touch

- The root is private and never installed: never add an install-time lifecycle script (`install`, `postinstall`, `preinstall`, `prepare`, `prepack`) to the root manifest. No check enforces this, and the index must not execute on install.
- Updating from npm: delete the npm lockfile and `node_modules` before installing with bun; a second lockfile is a source of truth no check reads.
  ```sh
  rm -f package-lock.json && rm -rf node_modules
  bun install
  ```

## Scope & routing

- `packages/<name>/AGENTS.md` travels with its package: read it before changing that package's manifest.

## Reporting

- Never paste check output the script did not print. There is no captured output block in `README.md`; run the script and quote its real output.
