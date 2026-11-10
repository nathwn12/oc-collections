#!/usr/bin/env node
// check-launchers.mjs - the two invariants that bit us on 2026-11-10.
//
// 1. A launcher that downloads a pinned engine refuses to run when its own
//    version and `npm/engine-manifest.json`'s serverVersion disagree:
//      "version skew: launcher 0.8.0 vs manifest serverVersion 0.7.1"
//    The release lane bumps the manifest and cannot bump the engine, so the
//    pair must move together or the package ships broken. This catches it in
//    the working tree, before a push, instead of at cleanroom.
//
// 2. A private package inside the release allowlist aborts the entire plan at
//    resolvePackage, so one private package would block every other release.
//
// Scope is the workspace: every packages/<name> with a manifest.
import fs from "node:fs"
import path from "node:path"

import { ALLOWED } from "./release-target.mjs"

const ROOT = path.resolve(import.meta.dirname, "..")
const PACKAGES = path.join(ROOT, "packages")

const packages = fs
  .readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(PACKAGES, entry.name))
  .filter((dir) => fs.existsSync(path.join(dir, "package.json")))

let failed = 0

for (const dir of packages) {
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
  } catch (error) {
    console.error(`FAIL ${path.basename(dir)}: unreadable package.json (${error.message})`)
    failed++
    continue
  }

  const enginePath = path.join(dir, "npm", "engine-manifest.json")
  if (fs.existsSync(enginePath)) {
    let engine
    try {
      engine = JSON.parse(fs.readFileSync(enginePath, "utf8"))
    } catch (error) {
      console.error(`FAIL ${pkg.name}: unreadable engine-manifest.json (${error.message})`)
      failed++
      continue
    }
    if (engine.serverVersion !== pkg.version) {
      console.error(
        `FAIL ${pkg.name}: launcher ${pkg.version} vs engine ${engine.serverVersion}; ` +
          `move the engine pin in the same release or the launcher refuses to run`,
      )
      failed++
    }
  }

  if (pkg.private === true && ALLOWED.includes(pkg.name)) {
    console.error(
      `FAIL ${pkg.name}: private and in the release allowlist; ` +
        `resolvePackage throws and the whole plan fails, not just this package`,
    )
    failed++
  }
}

if (failed > 0) {
  process.exitCode = 1
} else {
  console.log(`launchers: ${packages.length} package(s) consistent`)
}
