#!/usr/bin/env node
/**
 * Offline red/green proof for scripts/check-launcher.mjs.
 *
 * Builds benign, nonsecurity fixtures in a temp prefix: a complete launcher,
 * one with the nested manifest removed (missing metadata), and one with a
 * serverVersion that disagrees with the package version (packaging drift).
 * No download, no engine bytes, no remote binary execution: the fixture bin is
 * one printed line and every archive hash is the release placeholder.
 *
 * It also runs the checker against both real launchers at their actual paths,
 * so a silent path drift in the workspace plan cannot hide behind the fixtures.
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

function makeFixture(root) {
  const npmDir = path.join(root, "npm")
  fs.mkdirSync(path.join(npmDir, "bin"), { recursive: true })
  fs.writeFileSync(path.join(npmDir, "bin", "fixture-mcp.js"), "console.log('benign fixture')\n")
  fs.writeFileSync(path.join(npmDir, "LICENSE"), "benign fixture license\n")
  fs.writeFileSync(
    path.join(npmDir, "package.json"),
    JSON.stringify(
      {
        name: "fixture-mcp",
        version: "1.2.3",
        bin: { "fixture-mcp": "./bin/fixture-mcp.js" },
        files: ["bin/", "engine-manifest.json", "LICENSE"],
      },
      null,
      2,
    ),
  )
  const manifest = {
    package: "fixture-mcp",
    serverVersion: "1.2.3",
    runtime: {
      source: "https://github.com/example/fixture/releases/download/v1.2.3",
      archive: { name: "fixture-v1.2.3-windows-x86_64.zip", sha256: "RELEASE_WORKFLOW_FILLS_THIS", size: 0 },
      server: { name: "fixture.exe", sha256: "RELEASE_WORKFLOW_FILLS_THIS", size: 0 },
    },
  }
  const manifestPath = path.join(npmDir, "engine-manifest.json")
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return { manifestPath, manifest }
}

function main() {
  const roots = []
  try {
    const goodRoot = fs.mkdtempSync(path.join(os.tmpdir(), "check-launcher-selftest-"))
    roots.push(goodRoot)
    makeFixture(goodRoot)
    let result = runChecker(goodRoot)
    verify("fixture green: complete metadata", result.code === 0, `exit ${result.code}: ${result.err}${result.out}`)

    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "check-launcher-selftest-"))
    roots.push(missingRoot)
    const missing = makeFixture(missingRoot)
    fs.rmSync(missing.manifestPath, { force: true })
    result = runChecker(missingRoot)
    verify(
      "fixture red: nested manifest missing",
      result.code !== 0 && /engine-manifest\.json/.test(result.err),
      `exit ${result.code}: ${result.err}`,
    )

    const driftRoot = fs.mkdtempSync(path.join(os.tmpdir(), "check-launcher-selftest-"))
    roots.push(driftRoot)
    const drift = makeFixture(driftRoot)
    fs.writeFileSync(drift.manifestPath, JSON.stringify({ ...drift.manifest, serverVersion: "9.9.9" }, null, 2))
    result = runChecker(driftRoot)
    verify(
      "fixture red: packaging drift on version",
      result.code !== 0 && /serverVersion/.test(result.err),
      `exit ${result.code}: ${result.err}`,
    )

    for (const name of ["oc-gladius", "oc-puppet"]) {
      result = runChecker(path.join(ROOT, "packages", name))
      verify(`real launcher green: ${name}`, result.code === 0, `exit ${result.code}: ${result.err}${result.out}`)
    }
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    process.exitCode = 1
    console.error(`selftest FAILED: ${failures.length} case(s): ${failures.join(", ")}`)
  } else {
    console.log("selftest PASS: 3 benign fixture cases + 2 real launchers")
  }
}

main()
