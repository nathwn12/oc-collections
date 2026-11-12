#!/usr/bin/env node
/**
 * Install the packed tarballs into an empty project and prove they work there.
 *
 * pack-check inspects a tarball's bytes; it never installs one. This is the
 * consumer's half: every workspace is packed with `--ignore-scripts` (no
 * lifecycle side effects, so the tarball is exactly what `npm publish` would
 * upload), all of them are declared as `file:` dependencies in a private
 * throwaway package.json, `npm install --ignore-scripts` resolves them with
 * their real dependencies and peers, and each installed copy is probed from
 * `node_modules/<dir>`:
 *
 *   - every declared entry point exists (main, exports targets, bin),
 *   - every `files` entry landed in the install,
 *   - the package declares something a consumer can load at all,
 *   - every loadable entry point evaluates: library entries are imported and
 *     must export something, bins must answer `--version`/`--help` (a bin
 *     executes on import, so executing it is the load proof that still forces
 *     node to parse and evaluate the module),
 *
 * then, with the same cwd, the package's own `test` command when the tarball
 * ships the test tree it names. No tarball in this repo ships one (pack-check
 * refuses a `test/` entry), so today that step reports "not shipped" and the
 * probe is the install's proof; it goes live for a package that ships tests.
 *
 * Order is the workspace-plan order, the same list the root fan-out uses;
 * packs run concurrently but install and probe in that order. The release lane
 * passes --package to scope this to the released package; a bare run still proves all seven.
 *
 * `--check` proves this harness in both directions, offline against fixtures:
 * a good fixture installs and probes clean; a wrong `main`, an entry file
 * that throws on import, and a package with no entry point must all be
 * refused; and the zero-workspace preflight must fail closed. Exit 1 when an
 * expectation is violated.
 *
 * Failures set process.exitCode and return; a forced exit can truncate the
 * lines still queued when CI pipes them.
 */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PLAN, ROOT, workspaceDirs } from "./workspace-plan.mjs"

const PROBE = `
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const [dir, name] = process.argv.slice(2)

function leaves(value, out = []) {
  if (typeof value === "string") {
    if (value.startsWith("./")) out.push(value)
    return out
  }
  if (value && typeof value === "object") for (const nested of Object.values(value)) leaves(nested, out)
  return out
}

let manifest
try {
  manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
} catch (err) {
  console.log(\`  FAIL unreadable package.json: \${err.message}\`)
  process.exit(1)
}
if (manifest.name !== name) {
  console.log(\`  FAIL installed name \${manifest.name} != \${name}\`)
  process.exit(1)
}

const entries = new Set()
if (typeof manifest.main === "string") entries.add(manifest.main)
if (typeof manifest.module === "string") entries.add(manifest.module)
const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {})
for (const bin of bins) entries.add(bin)
for (const target of leaves(manifest.exports)) entries.add(target)

const missingEntries = [...entries]
  .map((entry) => entry.replace(/^\\.\\//, ""))
  .filter((entry) => !fs.existsSync(path.join(dir, entry)))
const files = (manifest.files ?? []).map((entry) => String(entry).replace(/\\/+$/, "")).filter((entry) => !entry.startsWith("!"))
const missingFiles = files.filter((entry) => !fs.existsSync(path.join(dir, entry)))

if (entries.size === 0) {
  console.log("  FAIL declares no entry point: nothing a consumer can load")
  process.exit(1)
}
for (const entry of missingEntries) console.log(\`  FAIL missing entry \${entry}\`)
for (const entry of missingFiles) console.log(\`  FAIL missing files entry \${entry}\`)
if (missingEntries.length > 0 || missingFiles.length > 0) process.exit(1)

// Existence is not loading: import every loadable library entry and prove it
// evaluates to a namespace with an export. Type declarations and TypeScript
// sources are not runnable modules, so they keep the existence check above
// and are skipped here; JSON subpaths are data, not modules. A bin executes
// on import, so importing one here would run the command: the load proof for
// a bin is executing it, which still forces node to parse and evaluate the
// module before it can answer.
const withoutPrefix = (entry) => {
  const raw = String(entry)
  return raw.startsWith("./") ? raw.slice(2) : raw
}
const binSet = new Set(bins.map(withoutPrefix))
const stripped = [...entries].map(withoutPrefix)
const isRunnable = (entry) => !(
  entry.endsWith(".d.ts") ||
  entry.endsWith(".d.mts") ||
  entry.endsWith(".d.cts") ||
  entry.endsWith(".ts") ||
  entry.endsWith(".tsx") ||
  entry.endsWith(".mts") ||
  entry.endsWith(".cts") ||
  entry.endsWith(".json")
)
const libs = stripped.filter((entry) => !binSet.has(entry) && isRunnable(entry))
let loadFailures = 0
for (const entry of libs) {
  let ns
  try {
    ns = await import(pathToFileURL(path.join(dir, entry)).href)
  } catch (err) {
    console.log(\`  FAIL loads \${entry}: \${err && err.message ? err.message : String(err)}\`)
    loadFailures += 1
    continue
  }
  if (!ns || Object.keys(ns).length === 0) {
    console.log(\`  FAIL loads \${entry}: evaluated but exports nothing\`)
    loadFailures += 1
    continue
  }
  console.log(\`  LOAD \${entry}: evaluated with exports\`)
}
for (const entry of binSet) {
  let ok = false
  let detail = ""
  for (const flag of ["--version", "--help"]) {
    const probed = spawnSync(process.execPath, [path.join(dir, entry), flag], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    })
    detail = (String(probed.stdout ?? "") + String(probed.stderr ?? "")).trim().slice(-160)
    if (!probed.error && probed.status === 0) {
      ok = true
      break
    }
  }
  if (!ok) {
    console.log(\`  FAIL loads \${entry}: bin did not answer --version/--help\${detail ? ": " + detail : ""}\`)
    loadFailures += 1
    continue
  }
  console.log(\`  LOAD \${entry}: bin answered\`)
}
if (loadFailures > 0) process.exit(1)
console.log(\`  PASS \${name}@\${manifest.version}: \${entries.size} entry point(s) and \${files.length} files entr\${files.length === 1 ? "y" : "ies"} present\`)
`

/**
 * `npm_execpath` is npm's own JS entry when npm runs this script, and the bun
 * binary when `bun run` does. Only a JS entry can be handed to node, so any
 * other value falls back to the `npm` shim on PATH.
 */
function npmExecpath() {
  const exec = process.env.npm_execpath
  return exec && /\.[cm]?js$/i.test(exec) ? exec : undefined
}

function npm(args, cwd) {
  const npmCli = npmExecpath()
  return npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd,
        encoding: "utf8",
        shell: process.platform === "win32",
      })
}

const fileUrl = (target) => path.resolve(target).split(path.sep).join("/")

// Packs run concurrently across workspaces (one tarball set, same flags).
const PACK_CONCURRENCY = Math.max(1, Math.min(os.cpus().length || 4, 8))

/** Async npm with captured output, for the concurrent pack phase. */
function npmAsync(args, cwd) {
  return new Promise((resolve) => {
    const npmCli = npmExecpath()
    const child = npmCli
      ? spawn(process.execPath, [npmCli, ...args], { cwd })
      : spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
          cwd,
          shell: process.platform === "win32",
        })
    let stdout = ""
    let stderr = ""
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8") })
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8") })
    child.on("error", (err) => resolve({ status: 1, stdout, stderr: stderr + String(err?.message ?? err) }))
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }))
  })
}

/** Pack one workspace into `destination`; returns the tarball path or null. */
async function packWorkspaceAsync(name, destination) {
  const packed = await npmAsync(["pack", "--ignore-scripts", "--workspace", name, "--pack-destination", destination], ROOT)
  if (packed.status !== 0) {
    console.error(`  FAIL npm pack ${name} (exit ${packed.status})\n${(packed.stderr ?? "").trim()}`)
    return null
  }
  const filename = packed.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  return path.join(destination, filename)
}

/** Write the throwaway consumer manifest and install every tarball into it. */
function installTarballs(root, tarballs) {
  const app = path.join(root, "app")
  fs.mkdirSync(app, { recursive: true })
  const dependencies = {}
  for (const { name, tgz } of tarballs) dependencies[name] = `file:${fileUrl(tgz)}`
  fs.writeFileSync(
    path.join(app, "package.json"),
    `${JSON.stringify({ name: "cleanroom", version: "0.0.0", private: true, dependencies }, null, 2)}\n`,
  )
  fs.writeFileSync(path.join(app, "probe.mjs"), PROBE)
  const base = ["install", "--ignore-scripts", "--no-audit", "--no-fund"]
  const offline = npm([...base, "--offline"], app)
  if (offline.status === 0) {
    console.log("  install succeeded offline (--offline)")
    return app
  }
  fs.rmSync(path.join(app, "node_modules"), { recursive: true, force: true })
  fs.rmSync(path.join(app, "package-lock.json"), { force: true })
  console.log(`  offline install missed (exit ${offline.status}); retrying online with --prefer-offline`)
  const installed = npm([...base, "--prefer-offline"], app)
  if (installed.status !== 0) {
    console.error(`  FAIL npm install (exit ${installed.status})\n${(installed.stdout ?? "").trim()}\n${(installed.stderr ?? "").trim()}`)
    return null
  }
  console.log("  install succeeded online (--prefer-offline)")
  return app
}

/** Probe one installed copy, with cwd inside it. A scoped name is two segments.
 *  Returns the probe's exit status: 0 is clean, anything else is a failure. */
function probe(app, name) {
  const dir = path.join(app, "node_modules", name)
  if (!fs.existsSync(dir)) {
    console.log(`  FAIL ${name} is not in node_modules/${name} after install`)
    return 1
  }
  const result = spawnSync(process.execPath, [path.join(app, "probe.mjs"), dir, name], { cwd: dir, encoding: "utf8" })
  for (const line of `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/).filter(Boolean)) {
    console.log(line)
  }
  return result.status ?? 1
}

/**
 * Run the installed copy's own test command, with cwd in node_modules/<name>.
 * A tarball in this repo ships no test tree (pack-check refuses one), so the
 * honest answer for such a package is the probe above; the test run is live the
 * moment a package starts shipping its own tests.
 */
function runOwnTest(app, name) {
  const dir = path.join(app, "node_modules", name)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
  if (!manifest.scripts?.test) {
    console.log(`  test  ${name}: no test script`)
    return true
  }
  if (!["test", "tests"].some((sub) => fs.existsSync(path.join(dir, sub)))) {
    console.log(`  test  ${name}: not shipped (the tarball carries no test tree); the probe is the install's proof`)
    return true
  }
  const npmCli = npmExecpath()
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, "test"], { cwd: dir, stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], {
        cwd: dir,
        stdio: "inherit",
        shell: process.platform === "win32",
      })
  return result.status === 0
}

/** Fail closed: nothing discovered means nothing was proven. */
function preflight(dirs, quiet = false) {
  if (dirs.length === 0) {
    if (!quiet) console.error("cleanroom FAILED: no workspace packages found; there is nothing to install")
    return false
  }
  return true
}

async function runReal(scoped = null) {
  const dirs = workspaceDirs(ROOT)
  if (!preflight(dirs)) {
    process.exitCode = 1
    return
  }
  const byName = new Map()
  for (const dir of dirs) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
    byName.set(path.basename(dir), pkg.name)
  }
  // The release lane names the manifest package (scoped for janua/oc-bifrost);
  // a bare directory name works too. Either way this resolves to one directory.
  let scopedDir = null
  if (scoped !== null) {
    const match = [...byName.entries()].find(([dir, name]) => scoped === dir || scoped === name)
    if (!match) {
      const known = [...byName.entries()].map(([dir, name]) => (dir === name ? dir : `${dir} (${name})`))
      console.error(`cleanroom: unknown workspace "${scoped}"; known workspaces: ${known.join(", ")}`)
      process.exitCode = 2
      return
    }
    scopedDir = match[0]
  }
  // Plan order, then anything discovered but unplanned (pack-check owns the
  // plan-mismatch refusal; this run still installs what exists).
  const order = Object.keys(PLAN.check).filter((name) => byName.has(name))
  for (const name of byName.keys()) if (!order.includes(name)) order.push(name)
  const selected = scopedDir === null ? order : order.filter((name) => name === scopedDir)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-collections-cleanroom-"))
  const failures = []
  try {
    const destination = path.join(root, "tarballs")
    fs.mkdirSync(destination, { recursive: true })
    const packedByDir = new Map()
    let packIndex = 0
    async function packWorker() {
      while (packIndex < selected.length) {
        const dirName = selected[packIndex++]
        const name = byName.get(dirName)
        console.log(`\n[cleanroom] packing ${name}`)
        const tgz = await packWorkspaceAsync(name, destination)
        if (tgz === null) failures.push(name)
        else packedByDir.set(dirName, { name, tgz })
      }
    }
    await Promise.all(Array.from({ length: Math.min(PACK_CONCURRENCY, selected.length) }, packWorker))
    // Plan order is preserved for the install below: same tarball set as the
    // serial run, only packed concurrently.
    const tarballs = selected.filter((dirName) => packedByDir.has(dirName)).map((dirName) => packedByDir.get(dirName))
    if (tarballs.length > 0) {
      console.log(`\n[cleanroom] installing ${tarballs.length} tarball(s) into a private project`)
      const app = installTarballs(root, tarballs)
      if (app === null) {
        process.exitCode = 1
        return
      }
      for (const { name } of tarballs) {
        const status = probe(app, name)
        if (status !== 0) failures.push(`${name} (probe exit ${status})`)
        else if (!runOwnTest(app, name)) failures.push(name)
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\ncleanroom FAILED: ${failures.join(", ")}`)
    process.exitCode = 1
    return
  }
  console.log(`\ncleanroom: ${selected.length} package(s) installed from their tarballs and loadable`)
}

/** One fixture package, optionally broken, packed, installed and probed. */
function fixtureRun(root, { dirName, manifest, files }, expectClean) {
  const source = path.join(root, `${dirName}-src`)
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(source, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
  }
  const destination = path.join(root, `${dirName}-tarballs`)
  fs.mkdirSync(destination, { recursive: true })
  const packed = npm(["pack", "--ignore-scripts", "--pack-destination", destination], source)
  if (packed.status !== 0) {
    console.log(`FAIL ${dirName}: npm pack (exit ${packed.status})`)
    return false
  }
  const filename = packed.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  const tgz = path.join(destination, filename)
  const app = installTarballs(path.join(root, dirName), [{ name: manifest.name, tgz }])
  if (app === null) {
    console.log(`FAIL ${dirName}: npm install`)
    return false
  }
  const status = probe(app, manifest.name)
  const clean = status === 0
  const label = expectClean ? "good fixture installs and probes clean" : "broken fixture is refused"
  console.log(`  probe exit ${status}`)
  console.log(`${clean === expectClean ? "PASS" : "FAIL"} ${label}`)
  return clean === expectClean
}

function runCheck() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-collections-cleanroom-check-"))
  const results = []
  try {
    results.push(
      fixtureRun(root, {
        dirName: "good",
        manifest: { name: "@fixture/good", version: "1.0.0", main: "./index.js", files: ["index.js"] },
        files: { "index.js": "module.exports = 1\n" },
      }, true),
    )
    results.push(
      fixtureRun(root, {
        dirName: "broken",
        manifest: { name: "@fixture/broken", version: "1.0.0", main: "./dist/missing.js", files: ["index.js"] },
        files: { "index.js": "module.exports = 1\n" },
      }, false),
    )
    results.push(
      fixtureRun(root, {
        dirName: "throwing",
        manifest: { name: "@fixture/throwing", version: "1.0.0", main: "./index.js", files: ["index.js"] },
        files: { "index.js": "throw new Error('fixture boom')\n" },
      }, false),
    )
    results.push(
      fixtureRun(root, {
        dirName: "noentry",
        manifest: { name: "@fixture/noentry", version: "1.0.0", files: ["README.md"] },
        files: { "README.md": "# noentry\n" },
      }, false),
    )
    const emptyClosed = preflight([], true) === false
    console.log(`${emptyClosed ? "PASS" : "FAIL"} zero workspaces fails closed`)
    results.push(emptyClosed)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  const failed = results.filter((ok) => !ok).length
  console.log(`cleanroom: fixtures ${results.length} passed ${results.length - failed} failed ${failed}`)
  if (failed > 0) process.exitCode = 1
}

async function main() {
  const args = process.argv.slice(2)
  let check = false
  let scoped = null
  let packageSeen = 0
  const unknown = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--check") {
      check = true
      continue
    }
    if (arg === "--package" || arg.startsWith("--package=")) {
      packageSeen += 1
      if (packageSeen === 1) {
        scoped = arg.startsWith("--package=") ? arg.slice("--package=".length) : args[i + 1]
        if (!arg.startsWith("--package=")) i += 1
      }
      continue
    }
    unknown.push(arg)
  }
  if (scoped !== null && (scoped === undefined || scoped.startsWith("--"))) scoped = ""
  if (unknown.length > 0 || packageSeen > 1 || (check && packageSeen > 0) || (packageSeen === 1 && scoped === "")) {
    console.error(`usage: node scripts/cleanroom.mjs [--check] [--package <workspace-name>] (got "${args.join(" ")}")`)
    process.exitCode = 2
    return
  }
  try {
    if (check) runCheck()
    else await runReal(scoped)
  } catch (error) {
    console.error(`cleanroom: ${error.message}`)
    process.exitCode = 1
  }
}

main()
