import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Packaging-contract tests.
 *
 * These guard a class of defect that cost real debugging time and is invisible
 * in every functional test: the package can work perfectly as a bare npm entry
 * and fail completely as a directory entry — silently.
 *
 * OpenCode resolves a configured local plugin entry through that directory's
 * package.json using path-based (legacy) resolution: `main`, then an `index`
 * fallback. The `exports` map only applies to BARE specifiers, so it is invisible
 * here. When nothing resolves, the host drops the plugin with no log at all
 * (`packages/core/src/config/plugin/source.ts:167` returns an empty list).
 */

const require = createRequire(import.meta.url)
const rawRoot = fileURLToPath(new URL("..", import.meta.url))
const root = rawRoot.replace(/[\\/]+$/, "")
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))

test("packaging: the package declares `main` so PATH-BASED resolution finds an entrypoint", () => {
  // `exports` is only consulted for BARE specifiers. A directory/as-path lookup uses
  // legacy `main` (then an `index` fallback) — with neither, resolution finds nothing.
  // Verified in Bun (the host runtime) as well as Node.
  assert.equal(typeof pkg.main, "string", "package.json must declare `main` for path-based resolution")
  const resolved = require.resolve(root)
  assert.ok(
    /index\.js$/.test(resolved),
    `a directory lookup must resolve to an entrypoint; got ${resolved}`,
  )
})

test("packaging: exports keeps a condition-agnostic default", () => {
  assert.ok(pkg.exports["."].default, "exports['.'] needs a `default` condition")
  assert.ok(pkg.exports["."].import, "exports['.'] needs an `import` condition")
})

test("packaging: files ships everything the README links to", () => {
  for (const entry of [
    "dist",
    "vendor",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "CHANGELOG.md",
    "INSTALL.md",
    "PROOF.md",
    "VERIFIED-PLUGINS.md",
    "CONTRIBUTING.md",
    "skills",
  ]) {
    assert.ok(pkg.files.includes(entry), `files must include "${entry}"`)
  }
})

test("packaging: INSTALL.md documents the bare entry, not a version pin", () => {
  // INSTALL.md ships inside the tarball and is the page users copy the entry
  // from. A pinned entry names a version that does not exist between a bump
  // and its publish, so the page must use the bare name.
  const install = fs.readFileSync(new URL("../INSTALL.md", import.meta.url), "utf8")
  assert.match(install, /"@nathwn12\/oc-bifrost"/, "INSTALL.md must show the bare plugin entry")
  const pins = [...install.matchAll(/@nathwn12\/oc-bifrost@(\d+\.\d+\.\d+)/g)].map((m) => m[1])
  assert.deepEqual(pins, [], `INSTALL.md must not pin a version, found ${pins.join(", ")}`)
})

test("packaging: the vendored preset entry exists where the preset points", () => {
  // preset.ts builds `new URL("../vendor/rtk.ts", import.meta.url)`; from dist/
  // that is the package-root vendor/rtk.ts. Prove the target really exists.
  const vendored = new URL("../vendor/rtk.ts", import.meta.url)
  assert.ok(fs.existsSync(vendored), `missing vendored entry: ${fileURLToPath(vendored)}`)
  assert.ok(pkg.files.includes("vendor"), "vendor/ must be published or the preset 404s")
})

test("packaging: only the 2.x generation is named, in src AND in the emitted types", () => {
  // A compat bridge must declare one generation. The V1 contract is vendored
  // (src/v1-contract.ts) precisely so the 1.x scope never re-enters the
  // manifest or the published surface: a host on the 2.x line cannot resolve a
  // 1.x type import, and every consumer of the package's d.ts would get TS2307.
  // Checked in the sources, the manifest, and dist/ - the strings a consumer
  // actually receives.
  const oneX = /@opencode-ai\//

  const manifest = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  assert.doesNotMatch(manifest, oneX, "package.json must not name the 1.x scope")

  const srcDir = fileURLToPath(new URL("../src", import.meta.url))
  const sources = fs
    .readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
  assert.ok(sources.length > 0, "expected TypeScript sources under src/")
  for (const name of sources) {
    const text = fs.readFileSync(path.join(srcDir, name), "utf8")
    assert.doesNotMatch(text, oneX, `src/${name.split(path.sep).join("/")} must not name the 1.x scope`)
  }

  const distDir = fileURLToPath(new URL("../dist", import.meta.url))
  assert.ok(fs.existsSync(distDir), "dist/ must exist: the test script compiles before it runs")
  const declarations = fs.readdirSync(distDir, { recursive: true }).map(String).filter((name) => name.endsWith(".d.ts"))
  assert.ok(declarations.length > 0, "expected emitted declarations under dist/")
  for (const name of declarations) {
    const text = fs.readFileSync(path.join(distDir, name), "utf8")
    assert.doesNotMatch(text, oneX, `dist/${name.split(path.sep).join("/")} must not name the 1.x scope`)
  }
})

test("packaging: the plugin peer range admits the 2.2.0 line and is not an exact pin", () => {
  const peer = pkg.peerDependencies["@opencode/plugin"]
  assert.equal(typeof peer, "string", "a peer on @opencode/plugin is required")
  // An exact pin makes the bridge mountable on one patch only; that is how the
  // previous manifest both pinned 2.1.1 and left 2.2.0 unsatisfied.
  assert.ok(!/^\d+\.\d+\.\d+$/.test(peer), `peer must be a range, got "${peer}"`)
  const floor = />=(\d+)\.(\d+)\.(\d+)/.exec(peer)
  assert.ok(floor !== null, `peer "${peer}" must state a floor`)
  const dev = pkg.devDependencies["@opencode/plugin"]
  const [devMajor = 0, devMinor = 0] = dev.split(".").map(Number)
  const [floorMajor = 0, floorMinor = 0] = floor.slice(1, 3).map(Number)
  assert.ok(
    floorMajor < devMajor || (floorMajor === devMajor && floorMinor <= devMinor),
    `peer floor "${floor[1]}.${floor[2]}.${floor[3]}" must not exceed the dev pin "${dev}"`,
  )
  assert.match(peer, /<3/, `peer "${peer}" must cap the major line so 3.x is not claimed`)
})
