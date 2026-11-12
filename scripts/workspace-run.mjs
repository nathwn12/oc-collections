#!/usr/bin/env node
/**
 * Root fan-out runner.
 *
 * Workspace packages do not share script names: oc-bifrost and oc-flight-deck
 * call their build `compile`, and oc-harness-setup runs its tests before its
 * pack dry-run. So each package's own exact command is named in the shared plan
 * (scripts/workspace-plan.mjs) instead of assuming one script name. Discovery
 * is fail-closed: a workspace missing from the plan is an error, never a silent
 * skip.
 *
 * Failures set process.exitCode and return; a forced exit can truncate the
 * message still queued on stderr when CI pipes it, and the child's exact
 * status is what the caller must see.
 *
 * Usage: node scripts/workspace-run.mjs [--serial] [--no-cache] [--package <name>] <check|build|test>
 * Workspaces run concurrently (min(cpus, 8)); --serial forces plan order.
 * The check purpose caches green runs (scripts/check-cache.mjs): a workspace
 * whose key is unchanged prints "unchanged since last green (cached)" and is
 * not re-run. `node scripts/workspace-run.mjs check --no-cache` or
 * `OC_CHECK_CACHE=0` disables the cache entirely. The npm `--no-cache`
 * spellings must not be used: npm consumes `--no-cache` as its own cache
 * config (warns `invalid config cache=false`) and delivers an empty argv
 * plus an unchanged environment, so no in-script detection can see it.
 */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PLAN, ROOT, checkPlan, workspaceDirs } from "./workspace-plan.mjs"
import { clear as cacheClear, read as cacheRead, workspaceKey, write as cacheWrite } from "./check-cache.mjs"

const CONCURRENCY = Math.max(1, Math.min(os.cpus().length || 4, 8))

/**
 * `npm_execpath` is npm's own JS entry when npm runs this script, and the bun
 * binary when `bun run` does. Only a JS entry can be handed to node, so any
 * other value falls back to the `npm` shim on PATH.
 */
function npmExecpath() {
  const exec = process.env.npm_execpath
  return exec && /\.[cm]?js$/i.test(exec) ? exec : undefined
}

function npmCommand(args) {
  const npmCli = npmExecpath()
  return npmCli
    ? { cmd: process.execPath, args: [npmCli, ...args], opts: {} }
    : {
        cmd: process.platform === "win32" ? "npm.cmd" : "npm",
        args,
        opts: { shell: process.platform === "win32" },
      }
}

function runNpm(args, cwd) {
  const npmCli = npmExecpath()
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd,
        stdio: "inherit",
        shell: process.platform === "win32",
      })
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    return false
  }
  return true
}

/** Async captured run: same command forms as the serial path, output piped. */
function runCapture(cmd, args, cwd, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, ...opts })
    let output = ""
    if (child.stdout) child.stdout.on("data", (chunk) => { output += chunk.toString("utf8") })
    if (child.stderr) child.stderr.on("data", (chunk) => { output += chunk.toString("utf8") })
    child.on("error", (err) => resolve({ status: 1, output: output + String(err?.message ?? err) + "\n" }))
    child.on("close", (status) => resolve({ status: status ?? 1, output }))
  })
}

/** Steps inside one workspace stay serial; the exact per-step command forms. */
async function runWorkspace(dir, purpose, plan, useCache) {
  const name = path.basename(dir)
  const workspacePath = path.relative(ROOT, dir).replace(/\\/g, "/")
  const steps = plan[name]
  if (steps.length === 0) {
    return { name, code: 0, block: `\n[${purpose}] ${name}: skip (this package has no ${purpose} command)\n` }
  }
  let key = null
  if (useCache) {
    try {
      key = workspaceKey(dir, steps)
      if (cacheRead(name, key)) {
        return { name, code: 0, block: `\n[${purpose}] ${name}: unchanged since last green (cached)\n` }
      }
    } catch {
      key = null // key failure is a miss, never a pass
    }
  }
  let block = ""
  function failed(code) {
    if (useCache) {
      try {
        cacheClear(name)
      } catch {
        /* the absent entry is the desired end state */
      }
    }
    return { name, code, block }
  }
  for (const [kind, ...rest] of steps) {
    block += `\n[${purpose}] ${name}: ${kind} ${rest.join(" ")}\n`
    let result
    if (kind === "script") {
      const { cmd, args, opts } = npmCommand(["run", rest[0], "-w", workspacePath])
      result = await runCapture(cmd, args, ROOT, opts)
    } else if (kind === "pack") {
      const { cmd, args, opts } = npmCommand(["pack", ...rest])
      result = await runCapture(cmd, args, dir, opts)
    } else if (kind === "node") {
      result = await runCapture(process.execPath, rest, dir, {})
    } else throw new Error(`unknown step kind: ${kind}`)
    block += result.output
    if (result.status !== 0) return failed(result.status ?? 1)
  }
  if (useCache && key) {
    try {
      cacheWrite(name, key)
    } catch (err) {
      block += `[${purpose}] ${name}: warning: cache write failed: ${err?.message ?? err}\n`
    }
  }
  return { name, code: 0, block }
}

function runSerial(purpose, plan, dirs, useCache) {
  for (const dir of dirs) {
    const name = path.basename(dir)
    const workspacePath = path.relative(ROOT, dir).replace(/\\/g, "/")
    const steps = plan[name]
    if (steps.length === 0) {
      console.log(`\n[${purpose}] ${name}: skip (this package has no ${purpose} command)`)
      continue
    }
    let key = null
    if (useCache) {
      try {
        key = workspaceKey(dir, steps)
        if (cacheRead(name, key)) {
          console.log(`\n[${purpose}] ${name}: unchanged since last green (cached)`)
          continue
        }
      } catch {
        key = null
      }
    }
    let ok = true
    for (const [kind, ...rest] of steps) {
      console.log(`\n[${purpose}] ${name}: ${kind} ${rest.join(" ")}`)
      if (kind === "script") {
        if (!runNpm(["run", rest[0], "-w", workspacePath], ROOT)) { ok = false; break }
      } else if (kind === "pack") {
        if (!runNpm(["pack", ...rest], dir)) { ok = false; break }
      } else if (kind === "node") {
        const result = spawnSync(process.execPath, rest, { cwd: dir, stdio: "inherit" })
        if (result.status !== 0) {
          process.exitCode = result.status ?? 1
          ok = false
          break
        }
      } else throw new Error(`unknown step kind: ${kind}`)
    }
    if (!ok) {
      if (useCache) {
        try {
          cacheClear(name)
        } catch {
          /* the absent entry is the desired end state */
        }
      }
      return
    }
    if (useCache && key) {
      try {
        cacheWrite(name, key)
      } catch (err) {
        console.log(`[${purpose}] ${name}: warning: cache write failed: ${err?.message ?? err}`)
      }
    }
  }

  console.log(`\n[${purpose}] all packages OK`)
}

async function runParallel(purpose, plan, dirs, useCache) {
  let worst = 0
  const failed = []
  let index = 0
  async function worker() {
    while (index < dirs.length) {
      const dir = dirs[index++]
      const { name, code, block } = await runWorkspace(dir, purpose, plan, useCache)
      process.stdout.write(block)
      if (code !== 0) {
        worst = Math.max(worst, code)
        failed.push(name)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dirs.length) }, worker))

  if (failed.length > 0) {
    console.error(`\n[${purpose}] FAILED: ${failed.join(", ")}`)
    process.exitCode = worst || 1
    return
  }
  console.log(`\n[${purpose}] all packages OK`)
}

function main() {
  const raw = process.argv.slice(2)
  const packageAt = raw.indexOf("--package")
  const packageName = packageAt >= 0 ? raw[packageAt + 1] : null
  if (packageAt >= 0 && (!packageName || packageName.startsWith("-"))) {
    console.error("usage: node scripts/workspace-run.mjs [--serial] [--no-cache] [--package <name>] <check|build|test>")
    process.exitCode = 2
    return
  }
  const rest = packageAt >= 0 ? raw.filter((_, index) => index !== packageAt && index !== packageAt + 1) : raw
  const serial = rest.includes("--serial")
  // `--no-cache` works on direct invocation only; through npm use OC_CHECK_CACHE=0.
  const cacheOff =
    rest.includes("--no-cache") ||
    process.env.OC_CHECK_CACHE === "0"
  const unknown = rest.filter((arg) => arg !== "--serial" && arg !== "--no-cache" && arg.startsWith("-"))
  const purpose = rest.find((arg) => !arg.startsWith("-"))

  const plan = PLAN[purpose]
  if (unknown.length > 0 || !plan) {
    console.error(`usage: node scripts/workspace-run.mjs [--serial] [--no-cache] [--package <name>] <check|build|test> (got "${raw.join(" ") || purpose || ""}")`)
    process.exitCode = 2
    return
  }

  const dirs = workspaceDirs(ROOT)
  if (!checkPlan(plan, dirs, purpose)) {
    process.exitCode = 1
    return
  }
  const selected = packageName
    ? dirs.filter((dir) => {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
        return pkg.name === packageName || path.basename(dir) === packageName
      })
    : dirs
  if (packageName && selected.length === 0) {
    console.error(`[${purpose}] no workspace package "${packageName}"`)
    process.exitCode = 2
    return
  }

  const useCache = purpose === "check" && !cacheOff
  if (serial) runSerial(purpose, plan, selected, useCache)
  else return runParallel(purpose, plan, selected, useCache)
}

main()
