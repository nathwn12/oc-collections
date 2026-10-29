import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import { ALLOWED, compareVersions, guardRegistry, parseTag, resolvePackage } from "./release-target.mjs"

test("parseTag: unscoped name", () => {
  assert.deepEqual(parseTag("oc-flight-deck@0.20.2"), { name: "oc-flight-deck", version: "0.20.2" })
})

test("parseTag: scoped name keeps both @ characters correctly", () => {
  assert.deepEqual(parseTag("@nathwn12/oc-bifrost@1.6.10"), { name: "@nathwn12/oc-bifrost", version: "1.6.10" })
})

test("parseTag: prerelease version", () => {
  assert.deepEqual(parseTag("oc-harness-setup@0.6.0-beta.1"), { name: "oc-harness-setup", version: "0.6.0-beta.1" })
})

test("parseTag: malformed tags are rejected", () => {
  const malformed = [
    "",
    "oc-flight-deck",
    "oc-flight-deck@",
    "@nathwn12/oc-bifrost",
    "@1.2.3",
    "oc-flight-deck@1.2",
    "oc-flight-deck@1.2.3.4",
    "oc-flight-deck@v1.2.3",
    "oc-flight-deck@@1.2.3",
    "scope/name@1.2.3",
    "oc-flight-deck@1.2.3-",
  ]
  for (const tag of malformed) {
    assert.throws(() => parseTag(tag), undefined, `expected rejection: ${JSON.stringify(tag)}`)
  }
})

test("compareVersions: numeric ordering", () => {
  assert.equal(compareVersions("1.6.9", "1.6.10"), -1)
  assert.equal(compareVersions("1.6.10", "1.6.9"), 1)
  assert.equal(compareVersions("1.6.9", "1.6.9"), 0)
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1)
  assert.equal(compareVersions("0.0.1", "0.0.1"), 0)
})

test("compareVersions: prerelease ordering", () => {
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1)
  assert.equal(compareVersions("1.0.0", "1.0.0-beta"), 1)
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1)
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1)
})

test("guardRegistry: a newer target passes", () => {
  assert.equal(guardRegistry(["1.6.8", "1.6.9"], "1.6.10"), 2)
})

test("guardRegistry: an empty version list passes", () => {
  assert.equal(guardRegistry([], "0.1.0"), 0)
})

test("guardRegistry: an existing version is refused", () => {
  assert.throws(() => guardRegistry(["1.6.9"], "1.6.9"), /refusing to republish/)
})

test("guardRegistry: an older target is refused", () => {
  assert.throws(() => guardRegistry(["1.6.9", "2.0.0"], "1.7.0"), /refusing to republish/)
})

test("guardRegistry: a target below the newest is refused even if never published", () => {
  assert.throws(() => guardRegistry(["2.0.0"], "1.9.9"), /refusing to republish/)
})

test("allowlist: exactly the four releasable packages", () => {
  assert.deepEqual(ALLOWED, ["@nathwn12/oc-bifrost", "oc-flight-deck", "oc-harness-setup", "rea-shim"])
})

test("resolvePackage: rea-shim resolves to its workspace package", () => {
  const target = resolvePackage("rea-shim")
  assert.equal(target.name, "rea-shim")
  assert.match(target.version, /^\d+\.\d+\.\d+/)
  assert.equal(path.basename(target.dir), "rea-shim")
})

test("resolvePackage: a package outside the allowlist is refused", () => {
  assert.throws(() => resolvePackage("oc-collections"), /not a releasable package/)
})
