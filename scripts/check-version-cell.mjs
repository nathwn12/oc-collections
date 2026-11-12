#!/usr/bin/env node
// check-version-cell.mjs - the manifest and its index cell must agree.
//
// A version bump touches two artifacts: packages/<pkg>/package.json and that
// package's row in the root README's table. Bumping only the manifest leaves a
// stale cell, and scripts/check-index.ps1 --structural then fails every leg of
// the package matrix over one package. This is that same assertion, narrowed to
// the packages this monorepo publishes and runnable from a package directory, so
// a publish stops before it ships the drift instead of finding it in CI.
//
// The grammar is scripts/index-table.mjs, which restates check-index.ps1's own
// rules; the parity test beside it proves the two name the same failure.
//
// Which packages are checked: scripts/release-target.mjs's ALLOWED, the set this
// repo releases. A package absent from this tree is not checked, and neither is
// one this repo does not publish (its row carries no pin by design).
//
// Usage:
//   node scripts/check-version-cell.mjs              every publishable package
//   node scripts/check-version-cell.mjs .            one package directory
//   node scripts/check-version-cell.mjs ../../packages/oc-talk   a path
//
// OC_INDEX_ROOT points the check at a fixture tree. Unset in every real run.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ALLOWED } from "./release-target.mjs"
import { ROOT, cellPin, cellVersion, packageLabel, readInventory, readReadme } from "./index-table.mjs"

export class CheckError extends Error {}

/**
 * Compare every publishable package's manifest version with its Version cell.
 * Returns the lines to print plus the counts; never prints and never exits, so
 * a test can assert both. `packages` narrows the run to those directories.
 */
export function checkVersionCells({ root = process.env.OC_INDEX_ROOT || ROOT, packages = null } = {}) {
  const readmePath = path.join(root, "README.md")
  if (!fs.existsSync(readmePath)) throw new CheckError(`no index table at ${readmePath}`)
  const { rows } = readReadme(readmePath)
  if (rows.length === 0) throw new CheckError(`no index rows recognised in ${readmePath}`)

  const inventory = readInventory(root)
  const scope = ALLOWED.map((name) => packageLabel(name)).filter((label) => inventory.has(label))

  const failures = []
  const passes = []
  let checked = 0
  let skipped = 0

  for (const label of scope) {
    const entry = inventory.get(label)
    if (packages && !packages.includes(entry.dir)) {
      skipped++
      continue
    }
    checked++
    const row = rows.find((candidate) => candidate.name === label)
    if (!row) {
      failures.push(`FAIL ${label.padEnd(20)} missing from the table`)
      continue
    }
    const pin = cellPin(cellVersion(row))
    if (typeof entry.version !== "string" || entry.version.length === 0) {
      failures.push(`FAIL ${label.padEnd(20)} manifest names no version`)
      continue
    }
    if (!pin) {
      failures.push(`FAIL ${label.padEnd(20)} version cell names no version (manifest ${entry.version})`)
      continue
    }
    if (pin !== entry.version) {
      failures.push(`FAIL ${label.padEnd(20)} version ${pin} does not match manifest ${entry.version}`)
      continue
    }
    passes.push(`PASS ${label.padEnd(20)} version ${pin} matches its manifest`)
  }

  // A run that matched nothing proves nothing: a narrowed invocation naming no
  // publishable package is a mistake, not a green.
  if (checked === 0) {
    throw new CheckError(
      packages
        ? `none of the given directories (${packages.map((dir) => path.relative(root, dir)).join(", ")}) is a package this repo publishes`
        : `no publishable package found under ${root}`,
    )
  }

  return { passes, failures, checked, skipped }
}

/** Resolve a CLI argument (directory or manifest name) to a package directory. */
export function resolvePackageDir(arg, root = process.env.OC_INDEX_ROOT || ROOT) {
  const dir = path.resolve(arg)
  if (fs.existsSync(path.join(dir, "package.json"))) return dir
  for (const entry of readInventory(root).values()) {
    if (entry.name === arg || entry.label === arg) return entry.dir
  }
  throw new CheckError(`unknown package "${arg}": not a directory with a package.json and not a manifest name`)
}

function main(argv) {
  try {
    const packages = argv.length > 0 ? argv.map((arg) => resolvePackageDir(arg)) : null
    const result = checkVersionCells({ packages })
    for (const line of result.passes) console.log(line)
    for (const line of result.failures) console.log(line)
    console.log(`version-cell: checked=${result.checked} failed=${result.failures.length}`)
    process.exitCode = result.failures.length === 0 ? 0 : 1
  } catch (error) {
    console.error(`check-version-cell: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
