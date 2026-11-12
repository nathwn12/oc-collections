#!/usr/bin/env node
/**
 * Green-check cache for `node scripts/workspace-run.mjs check`.
 *
 * A repeat `bun run check` on an unchanged tree should cost seconds. Each
 * workspace's entry lives at `.cache/checks/<workspace>.json` and holds the
 * key of the last green run. The key is a sha256 over, in a stable order:
 * every file path plus its bytes under the package (skipping `node_modules`,
 * `.git` and `.cache` at any depth), the root `package-lock.json`, every file
 * under root `scripts/`, the root `package.json`, the plan steps for that
 * package, `process.platform`, and the `process.versions.node` major.
 *
 * Safety: entries are written only after a workspace's check exited 0. A
 * failure never writes and deletes any entry for that workspace, so a real
 * failure can never read green from a stale entry.
 *
 * Usage: node scripts/check-cache.mjs --check   (hermetic self-test, temp dirs only)
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const ROOT = path.resolve(import.meta.dirname, "..")

const SKIP_DIRS = new Set(["node_modules", ".git", ".cache"])

/** Every regular file under dir, sorted; SKIP_DIRS pruned at any depth. */
function listFiles(dir) {
  const out = []
  function walk(current) {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(current, entry.name))
      } else if (entry.isFile()) {
        out.push(path.join(current, entry.name))
      }
    }
  }
  walk(dir)
  out.sort()
  return out
}

function hashFile(h, tag, absPath, baseDir) {
  const rel = path.relative(baseDir, absPath).replace(/\\/g, "/")
  h.update(`${tag}\0${rel}\0`)
  h.update(fs.readFileSync(absPath))
  h.update("\0")
}

/**
 * Stable sha256 key for one workspace. `root` is overridable so the
 * self-test can run against temp dirs; callers pass (dir, planSteps).
 */
export function workspaceKey(dir, planSteps, root = ROOT) {
  const h = crypto.createHash("sha256")
  const major = String(process.versions.node).split(".")[0]
  h.update(`platform\0${process.platform}\0`)
  h.update(`node-major\0${major}\0`)
  h.update(`steps\0${JSON.stringify(planSteps ?? [])}\0`)
  for (const file of listFiles(dir)) hashFile(h, "pkg", file, dir)
  hashFile(h, "root", path.join(root, "package.json"), root)
  const lock = path.join(root, "package-lock.json")
  if (fs.existsSync(lock)) hashFile(h, "root", lock, root)
  else h.update("root\0package-lock.json\0absent\0")
  const scriptsDir = path.join(root, "scripts")
  if (fs.existsSync(scriptsDir)) {
    for (const file of listFiles(scriptsDir)) hashFile(h, "root", file, root)
  }
  return h.digest("hex")
}

function cacheFile(name, root = ROOT) {
  return path.join(root, ".cache", "checks", `${name}.json`)
}

/**
 * The cached entry when its key matches expectedKey, else null (missing,
 * corrupt, or stale entries are never reused).
 */
export function read(name, expectedKey, root = ROOT) {
  let raw
  try {
    raw = fs.readFileSync(cacheFile(name, root), "utf8")
  } catch {
    return null
  }
  let entry
  try {
    entry = JSON.parse(raw)
  } catch {
    return null
  }
  if (!entry || entry.key !== expectedKey) return null
  return entry
}

/** Record a green run. Call only after the workspace's check exited 0. */
export function write(name, key, root = ROOT) {
  const file = cacheFile(name, root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const entry = {
    version: 1,
    workspace: name,
    key,
    platform: process.platform,
    node: process.versions.node,
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(file, JSON.stringify(entry, null, 2) + "\n")
  return entry
}

/** Delete any entry for a workspace; called when its check fails. */
export function clear(name, root = ROOT) {
  try {
    fs.unlinkSync(cacheFile(name, root))
  } catch {
    /* missing entry is the desired end state */
  }
}

function fail(label, detail = "") {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`)
  process.exitCode = 1
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-cache-"))
  try {
    const root = path.join(tmp, "root")
    const pkg = path.join(root, "pkg")
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true })
    fs.mkdirSync(pkg, { recursive: true })
    const lock = path.join(root, "package-lock.json")
    const indexJs = path.join(pkg, "index.js")
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"t"}\n')
    fs.writeFileSync(lock, '{"lockfileVersion":3}\n')
    fs.writeFileSync(path.join(root, "scripts", "a.mjs"), "export const x = 1;\n")
    fs.writeFileSync(path.join(pkg, "package.json"), '{"name":"pkg"}\n')
    fs.writeFileSync(indexJs, "module.exports = 1;\n")
    const steps = [["script", "check"]]

    const k1 = workspaceKey(pkg, steps, root)
    if (workspaceKey(pkg, steps, root) !== k1) fail("same tree gives same key")
    else console.log("ok: same tree -> same key")

    fs.writeFileSync(indexJs, "module.exports = 2;\n")
    const k2 = workspaceKey(pkg, steps, root)
    if (k2 === k1) fail("one changed byte gives different key")
    else console.log("ok: one changed byte -> different key")
    fs.writeFileSync(indexJs, "module.exports = 1;\n")
    if (workspaceKey(pkg, steps, root) !== k1) fail("restored tree gives original key")

    fs.writeFileSync(lock, '{"lockfileVersion":3,"x":1}\n')
    if (workspaceKey(pkg, steps, root) === k1) fail("changed lockfile gives different key")
    else console.log("ok: changed lockfile -> different key")
    fs.writeFileSync(lock, '{"lockfileVersion":3}\n')

    if (workspaceKey(pkg, [["script", "test"]], root) === k1) fail("changed plan step gives different key")
    else console.log("ok: changed plan step -> different key")

    fs.writeFileSync(path.join(root, "scripts", "a.mjs"), "export const x = 2;\n")
    if (workspaceKey(pkg, steps, root) === k1) fail("changed root script gives different key")
    else console.log("ok: changed root script -> different key")
    fs.writeFileSync(path.join(root, "scripts", "a.mjs"), "export const x = 1;\n")

    for (const skip of ["node_modules", ".git", ".cache"]) {
      const dep = path.join(pkg, skip, "dep")
      fs.mkdirSync(dep, { recursive: true })
      fs.writeFileSync(path.join(dep, "blob.js"), "x".repeat(1000))
    }
    if (workspaceKey(pkg, steps, root) !== k1) fail("node_modules/.git/.cache are skipped")
    else console.log("ok: node_modules/.git/.cache ignored")
    fs.rmSync(path.join(pkg, "node_modules"), { recursive: true, force: true })
    fs.rmSync(path.join(pkg, ".git"), { recursive: true, force: true })
    fs.rmSync(path.join(pkg, ".cache"), { recursive: true, force: true })

    write("pkg", k1, root)
    const entry = read("pkg", k1, root)
    if (!entry || entry.key !== k1 || entry.workspace !== "pkg") fail("write/read round-trip")
    else console.log("ok: write/read round-trip")
    if (read("pkg", k2, root) !== null) fail("entry whose key does not match is not reused")
    else console.log("ok: stale key is not reused")
    fs.writeFileSync(path.join(root, ".cache", "checks", "pkg.json"), "not json{")
    if (read("pkg", k1, root) !== null) fail("corrupt entry is not reused")
    else console.log("ok: corrupt entry is not reused")

    if (!process.exitCode) console.log("check-cache self-test: all green")
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv.includes("--check")) selfTest()
