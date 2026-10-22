#!/usr/bin/env node
/**
 * Pack every workspace package and verify the artifact that ships.
 *
 * For each package: `npm pack`, then (with the real `tar`) assert
 *   - no .gitignore / .npmignore / node_modules / .env* / lockfile / test tree,
 *   - the manifest inside the tarball is byte-equal to the built manifest,
 *   - every declared entry point (main, bin, exports targets) is present,
 *   - every `files` entry exists in the tarball (catches a dist-less pack).
 *
 * The sanctioned path is `npm run pack:check`, which runs check + build first;
 * a bare `npm pack` can still produce a dist-less tarball (this guard only
 * reports it, it cannot intercept a direct npm invocation).
 *
 * Fail-closed: zero discovered workspaces, or a workspace missing from the
 * shared plan (scripts/workspace-plan.mjs), exits 1 instead of verifying
 * nothing and reporting success.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PLAN, ROOT, checkPlan, workspaceDirs } from "./workspace-plan.mjs"

const dirs = workspaceDirs(ROOT)
if (dirs.length === 0) {
  console.error("pack-check FAILED: no workspace packages found")
  process.exit(1)
}
if (!checkPlan(PLAN.check, dirs, "pack-check")) {
  console.error("pack-check FAILED: workspace plan mismatch")
  process.exit(1)
}

const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oc-collections-pack-check-"))
const failures = []

function npm(args) {
  const npmCli = process.env.npm_execpath
  return npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: ROOT, encoding: "utf8" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd: ROOT,
        encoding: "utf8",
        shell: process.platform === "win32",
      })
}

function tar(args) {
  return spawnSync("tar", args, { encoding: null })
}

function exportTargets(value, out = []) {
  if (typeof value === "string") {
    if (value.startsWith("./")) out.push(value.slice(2))
    return out
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) exportTargets(nested, out)
  }
  return out
}

function isForbidden(entry) {
  const base = path.posix.basename(entry)
  if (base === ".gitignore" || base === ".npmignore") return true
  if (entry.split("/").includes("node_modules")) return true
  if (/(^|\/)\.env($|\.)/.test(entry)) return true
  if (["package-lock.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"].includes(base)) return true
  if (/^package\/(test|tests)\//.test(entry)) return true
  return false
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

try {
  for (const dir of dirs) {
    const pkgPath = path.join(dir, "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
    const destination = path.join(outRoot, path.basename(dir))
    fs.mkdirSync(destination, { recursive: true })

    console.log(`\n[pack] ${pkg.name}@${pkg.version}`)
    const packed = npm(["pack", "--workspace", pkg.name, "--pack-destination", destination])
    if (packed.status !== 0) {
      console.log(`  FAIL npm pack (exit ${packed.status})`)
      failures.push(pkg.name)
      continue
    }
    const filename = packed.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
    const tgz = path.join(destination, filename)

    const listing = tar(["-tzf", tgz])
    if (listing.status !== 0) {
      console.log("  FAIL tar -tzf")
      failures.push(pkg.name)
      continue
    }
    const entries = listing.stdout.toString("utf8").split(/\r?\n/).filter(Boolean)
    const forbidden = entries.filter(isForbidden)

    const extracted = tar(["-xzf", tgz, "-O", "package/package.json"])
    const packedManifest = extracted.status === 0 ? extracted.stdout : Buffer.alloc(0)
    const builtManifest = fs.readFileSync(pkgPath)
    const manifestEqual = sha256(packedManifest) === sha256(builtManifest)

    const declared = new Set()
    if (pkg.main) declared.add(pkg.main)
    const bins = typeof pkg.bin === "string" ? { bin: pkg.bin } : (pkg.bin ?? {})
    for (const binRel of Object.values(bins)) declared.add(binRel)
    for (const target of exportTargets(pkg.exports)) declared.add(target)
    const missingEntries = [...declared]
      .map((target) => target.replace(/^\.\//, ""))
      .filter((target) => !entries.includes(`package/${target}`))

    const missingFiles = (pkg.files ?? []).filter((file) => {
      const clean = file.replace(/\/+$/, "")
      return !entries.some((entry) => entry === `package/${clean}` || entry.startsWith(`package/${clean}/`))
    })

    const ok = forbidden.length === 0 && manifestEqual && missingEntries.length === 0 && missingFiles.length === 0
    console.log(`  tarball: ${filename} (${entries.length} entries)`)
    console.log(`  forbidden entries: ${forbidden.length ? forbidden.join(", ") : "none"}`)
    console.log(`  manifest byte-equal: ${manifestEqual}`)
    console.log(`  entry points present: ${missingEntries.length ? "MISSING " + missingEntries.join(", ") : `yes (${declared.size})`}`)
    console.log(`  files entries present: ${missingFiles.length ? "MISSING " + missingFiles.join(", ") : `yes (${(pkg.files ?? []).length})`}`)
    console.log(`  ${ok ? "PASS" : "FAIL"}`)
    if (!ok) failures.push(pkg.name)
  }
} finally {
  fs.rmSync(outRoot, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\npack-check FAILED: ${failures.join(", ")}`)
  process.exit(1)
}
console.log("\npack-check: all workspace tarballs verified")
