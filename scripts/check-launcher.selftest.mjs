#!/usr/bin/env node
/**
 * Offline red/green proof for scripts/check-launcher.mjs.
 *
 * Every fixture keeps a benign, nonsecurity layout: one printed-line bin, a
 * placeholder sha256, no engine bytes, no download, no remote binary execution.
 *
 * Each fixture also carries a COMPETING stale npm/package.json whose name and
 * version differ from the workspace root. That is the exact shape that once
 * made a checker report the nested engine name instead of the workspace
 * package identity: release.yml packs the workspace root, not the nested npm/
 * directory. The self-test proves the checker reports the root package
 * identity, keeps the engine identity separate, and goes red when only stale
 * nested metadata could be selected.
 *
 * Run from anywhere: node scripts/check-launcher.selftest.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = path.resolve(import.meta.dirname, "..")
const CHECKER = path.join(ROOT, "scripts", "check-launcher.mjs")
const failures = []

function verify(label, ok, detail) {
  if (ok) {
    console.log(`PASS ${label}`)
  } else {
    console.error(`FAIL ${label}: ${detail}`)
    failures.push(label)
  }
}

function runChecker(dir) {
  const result = spawnSync(process.execPath, [CHECKER, dir], { encoding: "utf8" })
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" }
}

function makeFixture(root, { rootVersion = "1.2.3", engineVersion = "1.2.3", withRootPkg = true, withManifest = true } = {}) {
  const npmDir = path.join(root, "npm")
  fs.mkdirSync(path.join(npmDir, "bin"), { recursive: true })
  fs.writeFileSync(path.join(npmDir, "bin", "fixture-mcp.js"), "console.log('benign fixture')\n")
  fs.writeFileSync(path.join(npmDir, "LICENSE"), "benign fixture license\n")

  if (withRootPkg) {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "oc-fixture",
          version: rootVersion,
          bin: { "oc-fixture": "./npm/bin/fixture-mcp.js" },
          files: ["npm/bin/", "npm/engine-manifest.json", "npm/LICENSE"],
        },
        null,
        2,
      ),
    )
  }
  // Competing stale source metadata: distinct name AND version from the root.
  fs.writeFileSync(
    path.join(npmDir, "package.json"),
    JSON.stringify({ name: "fixture-mcp", version: "9.9.9" }, null, 2),
  )

  const manifest = {
    package: "fixture-mcp",
    serverVersion: engineVersion,
    runtime: {
      source: "https://github.com/example/fixture/releases/download/v1.2.3",
      archive: { name: "fixture-v1.2.3-windows-x86_64.zip", sha256: "RELEASE_WORKFLOW_FILLS_THIS", size: 0 },
      server: { name: "fixture.exe", sha256: "RELEASE_WORKFLOW_FILLS_THIS", size: 0 },
    },
  }
  const manifestPath = path.join(npmDir, "engine-manifest.json")
  if (withManifest) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return { manifestPath }
}

function main() {
  const roots = []
  try {
    const greenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "check-launcher-selftest-"))
    roots.push(greenRoot)
    makeFixture(greenRoot)
    let result = runChecker(greenRoot)
    verify(
      "fixture green: root package selected, engine identity separate",
      result.code === 0 &&
        result.out.includes("package oc-fixture@1.2.3") &&
        result.out.includes("engine fixture-mcp@1.2.3") &&
        !result.out.includes("package fixture-mcp@"),
      `exit ${result.code}: ${result.err}${result.out}`,
    )

    const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "check-launcher-selftest-"))
    roots.push(staleRoot)
    makeFixture(staleRoot, { withRootPkg: false })
    result = runChecker(staleRoot)
    verify(
      "fixture red: stale nested metadata cannot stand in for root",
      result.code !== 0 && /FAIL package\.json/.test(result.err),
      `exit ${result.code}: ${result.err}`,
    )

    const driftRoot = fs.mkdtempSync(path.join(os.tmpdir(), "check-launcher-selftest-"))
    roots.push(driftRoot)
    makeFixture(driftRoot, { rootVersion: "2.0.0" })
    result = runChecker(driftRoot)
    verify(
      "fixture red: root version drift beats agreeing stale manifest",
      result.code !== 0 && /serverVersion 1\.2\.3 != package\.json version 2\.0\.0/.test(result.err),
      `exit ${result.code}: ${result.err}`,
    )

    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "check-launcher-selftest-"))
    roots.push(missingRoot)
    const missing = makeFixture(missingRoot)
    fs.rmSync(missing.manifestPath, { force: true })
    result = runChecker(missingRoot)
    verify(
      "fixture red: nested engine manifest missing",
      result.code !== 0 && /engine-manifest\.json/.test(result.err),
      `exit ${result.code}: ${result.err}`,
    )

  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    process.exitCode = 1
    console.error(`selftest FAILED: ${failures.length} case(s): ${failures.join(", ")}`)
  } else {
    console.log("selftest PASS: 4 benign fixture cases")
  }
}

main()
