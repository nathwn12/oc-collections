#!/usr/bin/env node
/**
 * Validate an npx launcher package without an engine and without network.
 *
 * Run from the launcher workspace directory (the workspace plan does this), or
 * pass that directory as the first argument. The published package root is
 * <dir>/npm and its engine manifest is nested there as npm/engine-manifest.json.
 * package.json is read from the published root when present, else from the
 * workspace root: that is the owning-data fallback the launcher itself uses
 * while the release lane has not written npm/package.json into the checkout.
 *
 * What is genuinely checkable offline:
 *   - the published root and the nested manifest exist and parse;
 *   - package.json parses and names a version;
 *   - every `bin` target exists and stays inside the package;
 *   - every `files` entry exists on disk;
 *   - the manifest names an engine package and the same server version;
 *   - runtime.source is a GitHub release URL, runtime names exist, and sha256
 *     slots are either the release placeholder or 64 hex.
 *
 * The package name and the engine name are separate values read from their own
 * files; no alias between them is assumed. Version agreement uses the two
 * existing version fields, not a derived or undocumented name.
 *
 * It never fetches, never spawns the engine, and never writes.
 *
 * Failures set process.exitCode and return; a forced exit can truncate the
 * FAIL lines still queued on stderr when CI pipes them.
 */
import fs from "node:fs"
import path from "node:path"

function main() {
  const launcherDir = path.resolve(process.argv[2] ?? process.cwd())
  const publishedRoot = path.join(launcherDir, "npm")
  const failures = []
  const fail = (message) => failures.push(message)

  function readJson(file, label) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"))
    } catch (error) {
      console.error(`FAIL ${label}: ${error.message}`)
      process.exitCode = 1
      return undefined
    }
  }

  if (!fs.existsSync(publishedRoot)) fail(`published package root missing: ${publishedRoot}`)

  const manifestPath = path.join(publishedRoot, "engine-manifest.json")
  const manifest = readJson(manifestPath, "npm/engine-manifest.json")
  if (!manifest) return

  const publishedPkg = path.join(publishedRoot, "package.json")
  const pkgPath = fs.existsSync(publishedPkg) ? publishedPkg : path.join(launcherDir, "package.json")
  const pkgLabel = path.relative(launcherDir, pkgPath) || path.basename(pkgPath)
  const pkg = readJson(pkgPath, pkgLabel)
  if (!pkg) return
  const dataRoot = path.dirname(pkgPath)

  // Two names from two owning files. They describe different things and are
  // never collapsed into one or inferred from a workspace-name alias.
  const packageName = pkg.name
  const engineName = manifest.package
  if (typeof packageName !== "string" || !packageName) fail(`${pkgLabel} has no name`)
  if (typeof pkg.version !== "string" || !pkg.version) fail(`${pkgLabel} has no version`)
  if (typeof engineName !== "string" || !engineName) fail("npm/engine-manifest.json has no engine package name")
  if (manifest.serverVersion !== pkg.version) {
    fail(`manifest serverVersion ${manifest.serverVersion} != ${pkgLabel} version ${pkg.version}`)
  }

  const bins = typeof pkg.bin === "string" ? { [packageName]: pkg.bin } : (pkg.bin ?? {})
  if (Object.keys(bins).length === 0) fail(`${pkgLabel} declares no bin`)
  for (const [name, relative] of Object.entries(bins)) {
    const target = path.resolve(dataRoot, relative)
    if (!target.startsWith(dataRoot + path.sep)) fail(`bin ${name} escapes the package: ${relative}`)
    else if (!fs.existsSync(target)) fail(`bin ${name} target missing: ${relative}`)
  }

  for (const entry of pkg.files ?? []) {
    const clean = entry.replace(/\/+$/, "")
    if (!fs.existsSync(path.join(dataRoot, clean))) fail(`files entry missing: ${entry}`)
  }

  const runtime = manifest.runtime
  if (!runtime || typeof runtime !== "object") {
    fail("manifest has no runtime block")
  } else {
    const sourcePattern = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v[^/]+$/
    if (typeof runtime.source !== "string" || !sourcePattern.test(runtime.source)) {
      fail(`runtime.source is not an immutable GitHub release URL: ${runtime.source}`)
    }
    if (!runtime.archive || typeof runtime.archive.name !== "string" || !runtime.archive.name.endsWith(".zip")) {
      fail("runtime.archive.name is missing or not a zip")
    }
    if (!runtime.server || typeof runtime.server.name !== "string" || runtime.server.name.length === 0) {
      fail("runtime.server.name is missing")
    }
    for (const slot of [runtime.archive?.sha256, runtime.server?.sha256]) {
      const placeholder = slot === "RELEASE_WORKFLOW_FILLS_THIS"
      if (!placeholder && !/^[0-9a-fA-F]{64}$/.test(String(slot))) {
        fail(`sha256 slot is neither the release placeholder nor 64 hex: ${slot}`)
      }
    }
  }

  if (pkg.os || pkg.cpu) {
    console.log("note: os/cpu are set (upstream leaves them unset; adding them changes published behaviour)")
  } else {
    console.log("note: os/cpu are unset (known pre-existing upstream gap; not changed by the import)")
  }

  if (failures.length > 0) {
    for (const message of failures) console.error(`FAIL ${message}`)
    process.exitCode = 1
    return
  }
  console.log(
    `PASS launcher: package ${packageName}@${pkg.version} | engine ${engineName}@${manifest.serverVersion} -> ${runtime.source}`,
  )
}

main()
