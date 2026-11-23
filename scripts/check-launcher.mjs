#!/usr/bin/env node
/**
 * Validate the SOURCE metadata of an npx launcher workspace, offline.
 *
 * Run from the launcher workspace directory (the workspace plan does this), or
 * pass that directory as the first argument. npm publishes the workspace root:
 * release.yml uses `npm publish --workspace <name>`, and pack-check.mjs packs
 * the same root. So package identity, bin and files paths all come from
 * <dir>/package.json and resolve against <dir>. This checks the source tree the
 * publish path packs, not an already-packed tarball artifact.
 *
 * The runtime engine manifest is nested at <dir>/npm/engine-manifest.json. Its
 * `package` and `serverVersion` own the engine identity and pin, which are
 * separate from the package identity. A legacy <dir>/npm/package.json may still
 * exist from the old single-directory publication; it is stale source metadata,
 * is deliberately NOT read here, and is not removed or republished by this check.
 *
 * What is genuinely checkable offline:
 *   - the workspace root package.json and the nested manifest exist and parse;
 *   - the package names a version and declares bin and files that exist;
 *   - the manifest names an engine package and the same server version;
 *   - runtime.source is a GitHub release URL, runtime names exist, and sha256
 *     slots are either the release placeholder or 64 hex.
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

  // The workspace root is the published root. Never substitute the legacy
  // nested npm/package.json: it names the old gladius-mcp/puppet-mcp packages,
  // while this workspace publishes oc-gladius/oc-puppet from the root.
  const pkg = readJson(path.join(launcherDir, "package.json"), "package.json")
  if (!pkg) return
  const manifest = readJson(path.join(launcherDir, "npm", "engine-manifest.json"), "npm/engine-manifest.json")
  if (!manifest) return

  const packageName = pkg.name
  const engineName = manifest.package
  if (typeof packageName !== "string" || !packageName) fail("package.json has no name")
  if (typeof pkg.version !== "string" || !pkg.version) fail("package.json has no version")
  if (typeof engineName !== "string" || !engineName) fail("npm/engine-manifest.json has no engine package name")
  if (manifest.serverVersion !== pkg.version) {
    fail(`manifest serverVersion ${manifest.serverVersion} != package.json version ${pkg.version}`)
  }

  const bins = typeof pkg.bin === "string" ? { [packageName]: pkg.bin } : (pkg.bin ?? {})
  if (Object.keys(bins).length === 0) fail("package.json declares no bin")
  for (const [name, relative] of Object.entries(bins)) {
    const target = path.resolve(launcherDir, relative)
    if (!target.startsWith(launcherDir + path.sep)) fail(`bin ${name} escapes the package: ${relative}`)
    else if (!fs.existsSync(target)) fail(`bin ${name} target missing: ${relative}`)
  }

  for (const entry of pkg.files ?? []) {
    const clean = entry.replace(/\/+$/, "")
    if (!fs.existsSync(path.join(launcherDir, clean))) fail(`files entry missing: ${entry}`)
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
  if (fs.existsSync(path.join(launcherDir, "npm", "package.json"))) {
    console.log("note: npm/package.json is stale legacy source metadata; not read by this check")
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
