#!/usr/bin/env node
// set-version.mjs - one command, both artifacts, at the moment of the bump.
//
// The manifest version and the root README's Version cell are the same claim
// about published bytes, so they are set together: bumping only the manifest is
// the stale cell that reddened every leg of the package matrix. This writes
// both, prints what it changed, and then runs scripts/check-version-cell.mjs on
// the package it just touched, so the bump proves itself instead of trusting
// that two edits agreed.
//
// Semver is the release guard's own grammar: VERSION_RE in release-target.mjs,
// reached through compareVersions rather than copied, so a version this tool
// accepts is a version that file accepts.
//
// Usage:
//   node scripts/set-version.mjs <package-dir-or-name> <version>
//
// OC_INDEX_ROOT points it at a fixture tree. Unset in every real run.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { compareVersions } from "./release-target.mjs"
import { checkVersionCells } from "./check-version-cell.mjs"
import { ROOT, cellPin, cellVersion, readInventory, readReadme } from "./index-table.mjs"

export class SetVersionError extends Error {}

/** Valid iff the release guard's parser accepts it. */
function assertSemver(version) {
  try {
    compareVersions(version, version)
  } catch {
    throw new SetVersionError(`"${version}" is not a semver version`)
  }
}

function resolveTarget(root, arg) {
  const wanted = path.resolve(arg)
  const inventory = readInventory(root)
  for (const entry of inventory.values()) {
    if (path.resolve(entry.dir) === wanted) return entry
  }
  for (const entry of inventory.values()) {
    if (entry.name === arg || entry.label === arg) return entry
  }
  throw new SetVersionError(`unknown package "${arg}": no workspace manifest names it`)
}

function lineDiff(relPath, before, after, eol = "\n") {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  const out = [`--- ${relPath}`]
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] === b[index]) continue
    out.push(`@@ line ${index + 1} @@`)
    if (a[index] !== undefined) out.push(`-${a[index]}`)
    if (b[index] !== undefined) out.push(`+${b[index]}`)
  }
  return out.join(eol)
}

/**
 * Set the manifest and the index cell. Both edits are computed and validated
 * before either file is written, so a refusal never leaves half a bump behind.
 */
export function setVersion({ root = process.env.OC_INDEX_ROOT || ROOT, target, version }) {
  const to = String(version ?? "").trim()
  assertSemver(to)
  const entry = resolveTarget(root, target)

  const manifestPath = path.join(entry.dir, "package.json")
  const manifestRel = path.relative(root, manifestPath).replace(/\\/g, "/")
  const manifestBefore = fs.readFileSync(manifestPath, "utf8")
  const manifestAfter = manifestBefore.replace(/("version"\s*:\s*")[^"]*(")/, `$1${to}$2`)
  if (manifestAfter === manifestBefore && entry.version !== to) {
    throw new SetVersionError(`${manifestRel} has no top-level "version" field to set`)
  }
  const written = JSON.parse(manifestAfter)
  if (written.name !== entry.name || written.version !== to) {
    throw new SetVersionError(`${manifestRel} did not take version ${to}; refusing to guess at its shape`)
  }

  const readmePath = path.join(root, "README.md")
  const readmeRel = path.relative(root, readmePath).replace(/\\/g, "/")
  const readme = readReadme(readmePath)
  const row = readme.rows.find((candidate) => candidate.name === entry.label)
  let readmeAfter = readme.text
  if (row) {
    const pin = cellPin(cellVersion(row))
    if (!pin) {
      throw new SetVersionError(
        `${readmeRel} row for ${entry.label} names no version pin; add one by hand and re-run`,
      )
    }
    // Only the pin inside the Version cell moves: the row's own columns and
    // padding are left exactly as the file had them. cells[2] is parts[3] for
    // a line whose first character is `|`.
    const parts = row.line.split("|")
    parts[3] = parts[3].replace(/`[^`]+`/, `\`${to}\``)
    const lines = [...readme.lines]
    lines[row.index] = parts.join("|")
    readmeAfter = lines.join(readme.eol)
  }

  const diffs = []
  if (manifestAfter !== manifestBefore) {
    diffs.push({ path: manifestPath, after: manifestAfter, text: lineDiff(manifestRel, manifestBefore, manifestAfter) })
  }
  if (readmeAfter !== readme.text) {
    diffs.push({ path: readmePath, after: readmeAfter, text: lineDiff(readmeRel, readme.text, readmeAfter) })
  }
  for (const { path: file, after } of diffs) fs.writeFileSync(file, after)

  return {
    label: entry.label,
    name: entry.name,
    from: entry.version,
    to,
    changed: diffs.length > 0,
    hasRow: Boolean(row),
    diffs,
    writtenFiles: diffs.map(({ path: file }) => file),
  }
}

function main(argv) {
  if (argv.length !== 2) {
    console.error("usage: set-version.mjs <package-dir-or-name> <version>")
    process.exitCode = 2
    return
  }
  try {
    const result = setVersion({ target: argv[0], version: argv[1] })
    if (!result.changed) {
      console.log(`set-version: ${result.label} is already ${result.to} in its manifest and the index`)
      return
    }
    console.log(`set-version: ${result.label} ${result.from} -> ${result.to}`)
    for (const { text } of result.diffs) console.log(text)
    console.log(`wrote ${result.writtenFiles.length} file(s)`)
    if (!result.hasRow) console.log(`note: no index row for ${result.label}, so only the manifest changed`)

    const verify = checkVersionCells({ packages: result.writtenFiles.length > 0 ? [path.dirname(result.writtenFiles[0])] : null })
    for (const line of verify.failures) console.log(line)
    if (verify.failures.length > 0) {
      console.error("set-version: wrote the files, but the check still fails: fix the row by hand")
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`set-version: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
