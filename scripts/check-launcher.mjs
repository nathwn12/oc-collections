#!/usr/bin/env node
/**
 * Validate an npx launcher package without an engine and without network.
 *
 * Run from the package directory (the workspace plan does this). It checks
 * what is genuinely checkable offline:
 *   - package.json parses and names a version;
 *   - every `bin` target exists and stays inside the package;
 *   - every `files` entry exists on disk;
 *   - engine-manifest.json parses, names the same package and server version,
 *     and points runtime.source at a GitHub release URL;
 *   - runtime archive/server names exist;
 *   - sha256 slots are either the release-workflow placeholder or 64 hex.
 *
 * It never fetches, never spawns the engine, and never writes.
 *
 * Failures set process.exitCode and return; a forced exit can truncate the
 * FAIL lines still queued on stderr when CI pipes them.
 */
import fs from "node:fs"
import path from "node:path"

function main() {
  const dir = process.cwd()
  const failures = []
  const fail = (message) => failures.push(message)

  function readJson(file, label) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))
    } catch (error) {
      console.error(`FAIL ${label}: ${error.message}`)
      process.exitCode = 1
      return undefined
    }
  }

  const pkg = readJson("package.json", "package.json")
  if (!pkg) return
  const manifest = readJson("engine-manifest.json", "engine-manifest.json")
  if (!manifest) return

  if (!pkg.name || typeof pkg.name !== "string") fail("package.json has no name")
  if (!pkg.version || typeof pkg.version !== "string") fail("package.json has no version")
  if (manifest.package !== pkg.name) fail(`manifest package ${manifest.package} != ${pkg.name}`)
  if (manifest.serverVersion !== pkg.version) fail(`manifest serverVersion ${manifest.serverVersion} != ${pkg.version}`)

  const bins = typeof pkg.bin === "string" ? { bin: pkg.bin } : (pkg.bin ?? {})
  if (Object.keys(bins).length === 0) fail("package.json declares no bin")
  for (const [name, relative] of Object.entries(bins)) {
    const target = path.resolve(dir, relative)
    if (!target.startsWith(dir + path.sep)) fail(`bin ${name} escapes the package: ${relative}`)
    else if (!fs.existsSync(target)) fail(`bin ${name} target missing: ${relative}`)
  }

  for (const entry of pkg.files ?? []) {
    const clean = entry.replace(/\/+$/, "")
    if (!fs.existsSync(path.join(dir, clean))) fail(`files entry missing: ${entry}`)
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
  console.log(`PASS launcher: ${pkg.name}@${pkg.version} -> ${runtime.source}`)
}

main()
