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
 * Usage: node scripts/workspace-run.mjs [--serial] [--no-cache] <check|build|test>
 * Workspaces run concurrently (min(cpus, 8)); --serial forces plan order.
 * The check purpose caches green runs (scripts/check-cache.mjs): a workspace
 * whose key is unchanged prints "unchanged since last green (cached)" and is
 * not re-run. --no-cache or OC_CHECK_CACHE=0 disables the cache entirely.
 * Through npm the flag must go after `--` (`npm run check -- --no-cache`):
 * a bare `npm run check --no-cache` is swallowed by npm itself, which owns
 * `cache` as a path config (npm 12 warns "invalid config cache=false").
 */
import { spawn, spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

import { PLAN, ROOT, checkPlan, workspaceDirs } from "./workspace-plan.mjs"
import { clear as cacheClear, read as cacheRead, workspaceKey, write as cacheWrite } from "./check-cache.mjs"

const CONCURRENCY = Math.max(1, Math.min(os.cpus().length || 4, 8))

function npmCommand(args) {
  const npmCli = process.env.npm_execpath
  return npmCli
    ? { cmd: process.execPath, args: [npmCli, ...args], opts: {} }
    : {
        cmd: process.platform === "win32" ? "npm.cmd" : "npm",
        args,
        opts: { shell: process.platform === "win32" },
      }
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath
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
  const serial = raw.includes("--serial")
  // npm_config_cache covers npm versions that propagate the negation; npm 12
  // rejects it ("invalid config cache=false") and drops the bare flag instead.
  const cacheOff =
    raw.includes("--no-cache") ||
    process.env.OC_CHECK_CACHE === "0" ||
    process.env.npm_config_cache === "false"
  const unknown = raw.filter((arg) => arg !== "--serial" && arg !== "--no-cache" && arg.startsWith("-"))
  const purpose = raw.find((arg) => !arg.startsWith("-"))

  const plan = PLAN[purpose]
  if (unknown.length > 0 || !plan) {
    console.error(`usage: node scripts/workspace-run.mjs [--serial] [--no-cache] <check|build|test> (got "${raw.join(" ") || purpose || ""}")`)
    process.exitCode = 2
    return
  }

  const dirs = workspaceDirs(ROOT)
  if (!checkPlan(plan, dirs, purpose)) {
    process.exitCode = 1
    return
  }

  const useCache = purpose === "check" && !cacheOff
  if (serial) runSerial(purpose, plan, dirs, useCache)
  else return runParallel(purpose, plan, dirs, useCache)
}

main()
