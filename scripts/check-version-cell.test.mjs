// check-version-cell.test.mjs - the manifest and the index row agree, proven.
//
// The fixture is a miniature of this repo: a root manifest, one publishable
// package under packages/, and the README table in the shape
// scripts/check-index.ps1 parses. OC_INDEX_ROOT points the checker at it, so
// the exit code is asserted, not merely the return value.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import { checkVersionCells } from "./check-version-cell.mjs"

const CHECKER = path.join(import.meta.dirname, "check-version-cell.mjs")

function fixture({ manifest = "0.3.0", pin = "0.2.2", row = true, rows = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-version-cell-"))
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "oc-collections", version: "0.2.6", private: true }, null, 2),
  )
  fs.mkdirSync(path.join(root, "packages", "oc-talk"), { recursive: true })
  fs.writeFileSync(
    path.join(root, "packages", "oc-talk", "package.json"),
    JSON.stringify({ name: "oc-talk", version: manifest }, null, 2),
  )
  const lines = ["# fixture", ""]
  if (rows) {
    lines.push("| Package | Kind | Version | What it does | Install |", "| --- | --- | --- | --- | --- |")
    if (row) lines.push(`| oc-talk | plugin | \`${pin}\` | Cross-session talk. | Add \`oc-talk\` to your \`plugins\`. |`)
    lines.push("| oc-collections | repo | — | This index. | — |")
  }
  fs.writeFileSync(path.join(root, "README.md"), lines.join("\n") + "\n")
  return root
}

function run(args, cwd, root = cwd) {
  return spawnSync(process.execPath, [CHECKER, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OC_INDEX_ROOT: root },
  })
}

test("red: manifest 0.3.0 with a README cell of 0.2.2 fails", () => {
  const root = fixture({ manifest: "0.3.0", pin: "0.2.2" })
  const result = checkVersionCells({ root })
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /^FAIL oc-talk\s+version 0\.2\.2 does not match manifest 0\.3\.0$/)
  assert.equal(run([], root).status, 1)
})

test("red: the narrowed run from a package directory fails the same way", () => {
  const root = fixture({ manifest: "0.3.0", pin: "0.2.2" })
  const result = run(["."], path.join(root, "packages", "oc-talk"), root)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /version 0\.2\.2 does not match manifest 0\.3\.0/)
})

test("green: a matching cell passes", () => {
  const root = fixture({ manifest: "0.3.0", pin: "0.3.0" })
  const result = checkVersionCells({ root })
  assert.deepEqual(result.failures, [])
  assert.equal(result.checked, 1)
  assert.equal(run([], root).status, 0)
})

test("red: a publishable package with no table row fails", () => {
  const root = fixture({ row: false })
  const result = checkVersionCells({ root })
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /oc-talk\s+missing from the table/)
  assert.equal(run([], root).status, 1)
})

test("red: a table that cannot be parsed is a failure, never a pass", () => {
  const root = fixture({ rows: false })
  const result = run([], root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no index rows recognised/)
})

test("a version cell for a package this repo does not publish is not its business", () => {
  const root = fixture({ manifest: "0.3.0", pin: "0.3.0" })
  const readme = path.join(root, "README.md")
  fs.writeFileSync(
    readme,
    fs.readFileSync(readme, "utf8").replace(
      "| oc-collections | repo | — |",
      "| oc-collections | repo | `9.9.9` |",
    ),
  )
  assert.deepEqual(checkVersionCells({ root }).failures, [])
})

// The two checkers must not disagree about what a stale cell says: this is the
// grammar-parity proof, and it is skipped where pwsh is absent, as it is on the
// Linux publish path.
test("this checker and check-index.ps1 name the same failure for the same cell", (t) => {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" })
  if (probe.error || probe.status !== 0) return t.skip("pwsh is not installed")

  const root = fixture({ manifest: "0.3.0", pin: "0.2.2" })
  const mine = checkVersionCells({ root }).failures[0]

  // Hand the PowerShell half this repo's own README, with one stale cell in it.
  const repo = path.resolve(import.meta.dirname, "..")
  const stale = fs
    .readFileSync(path.join(repo, "README.md"), "utf8")
    .replace(/(\| oc-talk \| plugin \| `)[^`]+(`)/, "$10.2.2$2")
  const readmePath = path.join(root, "stale.md")
  fs.writeFileSync(readmePath, stale)

  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-File", path.join(repo, "scripts", "check-index.ps1"), "--structural", "-Path", readmePath],
    { cwd: repo, encoding: "utf8" },
  )
  assert.equal(result.status, 1)
  assert.ok(result.stdout.includes(mine), `expected check-index.ps1 to print:\n${mine}\ngot:\n${result.stdout}`)
})
