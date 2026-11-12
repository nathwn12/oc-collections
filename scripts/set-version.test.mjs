// set-version.test.mjs - one command, both artifacts, proven.
//
// The fixture mirrors check-version-cell.test.mjs: a root manifest, one
// publishable package and the README table. Nothing writes into this repo.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import { setVersion } from "./set-version.mjs"
import { checkVersionCells } from "./check-version-cell.mjs"

const SETTER = path.join(import.meta.dirname, "set-version.mjs")

function fixture({ manifest = "0.2.2", pin = "0.2.2", pinCell = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "set-version-"))
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "oc-collections", version: "0.2.6", private: true }, null, 2) + "\n",
  )
  fs.mkdirSync(path.join(root, "packages", "oc-talk"), { recursive: true })
  fs.writeFileSync(
    path.join(root, "packages", "oc-talk", "package.json"),
    JSON.stringify({ name: "oc-talk", version: manifest, description: "talk" }, null, 2) + "\n",
  )
  const versionCell = pinCell ? `\`${pin}\`` : "—"
  fs.writeFileSync(
    path.join(root, "README.md"),
    [
      "# fixture",
      "",
      "| Package | Kind | Version | What it does | Install |",
      "| --- | --- | --- | --- | --- |",
      `| oc-talk | plugin | ${versionCell} | Cross-session talk. | Add \`oc-talk\` to your \`plugins\`. |`,
      "| oc-collections | repo | — | This index. | — |",
      "",
    ].join("\n"),
  )
  return root
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8")

test("sets the manifest and the index cell in one call", () => {
  const root = fixture({ manifest: "0.2.2", pin: "0.2.2" })
  const result = setVersion({ root, target: path.join(root, "packages", "oc-talk"), version: "0.3.0" })

  assert.equal(result.changed, true)
  assert.equal(result.label, "oc-talk")
  assert.equal(result.from, "0.2.2")
  assert.equal(result.to, "0.3.0")
  assert.equal(JSON.parse(read(root, "packages/oc-talk/package.json")).version, "0.3.0")
  assert.match(read(root, "README.md"), /\| oc-talk \| plugin \| `0\.3\.0` \|/)
  assert.deepEqual(checkVersionCells({ root }).failures, [])
})

test("the diff names both artifacts and both versions", () => {
  const root = fixture()
  const result = setVersion({ root, target: "oc-talk", version: "0.3.0" })
  const diff = result.diffs.map((entry) => entry.text).join("\n")

  assert.match(diff, /--- packages\/oc-talk\/package\.json/)
  assert.match(diff, /- {2}"version": "0\.2\.2",/)
  assert.match(diff, /\+ {2}"version": "0\.3\.0",/)
  assert.match(diff, /--- README\.md/)
  assert.match(diff, /`0\.2\.2`/)
  assert.match(diff, /`0\.3\.0`/)
})

test("a second run changes nothing", () => {
  const root = fixture()
  setVersion({ root, target: "oc-talk", version: "0.3.0" })
  const manifest = read(root, "packages/oc-talk/package.json")
  const readme = read(root, "README.md")

  const again = setVersion({ root, target: "oc-talk", version: "0.3.0" })
  assert.equal(again.changed, false)
  assert.deepEqual(again.diffs, [])
  assert.equal(read(root, "packages/oc-talk/package.json"), manifest)
  assert.equal(read(root, "README.md"), readme)
})

test("refuses a version that is not semver, and writes nothing", () => {
  const root = fixture()
  const before = read(root, "packages/oc-talk/package.json")
  for (const bad of ["0.3", "v0.3.0", "latest", "0.3.0.1", ""]) {
    assert.throws(() => setVersion({ root, target: "oc-talk", version: bad }), undefined, `expected refusal: ${bad}`)
  }
  assert.equal(read(root, "packages/oc-talk/package.json"), before)
})

test("refuses an unknown package", () => {
  const root = fixture()
  assert.throws(() => setVersion({ root, target: "no-such-package", version: "1.0.0" }), /unknown package/)
})

test("refuses a row with no version pin instead of half-writing", () => {
  const root = fixture({ pinCell: false })
  const before = read(root, "packages/oc-talk/package.json")
  assert.throws(() => setVersion({ root, target: "oc-talk", version: "0.3.0" }), /names no version pin/)
  assert.equal(read(root, "packages/oc-talk/package.json"), before)
})

test("the CLI exits 0 on a bump and 1 on a refusal", () => {
  const root = fixture()
  const bump = spawnSync(process.execPath, [SETTER, "oc-talk", "0.3.0"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, OC_INDEX_ROOT: root },
  })
  assert.equal(bump.status, 0)
  assert.match(bump.stdout, /oc-talk 0\.2\.2 -> 0\.3\.0/)

  const refused = spawnSync(process.execPath, [SETTER, "oc-talk", "nope"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, OC_INDEX_ROOT: root },
  })
  assert.equal(refused.status, 1)
})
