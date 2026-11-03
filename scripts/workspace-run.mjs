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
 * Usage: node scripts/workspace-run.mjs [--serial] <check|build|test>
 * Workspaces run concurrently (min(cpus, 8)); --serial forces plan order.
 */
import { spawn, spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

import { PLAN, ROOT, checkPlan, workspaceDirs } from "./workspace-plan.mjs"

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
async function runWorkspace(dir, purpose, plan) {
  const name = path.basename(dir)
  const workspacePath = path.relative(ROOT, dir).replace(/\\/g, "/")
  const steps = plan[name]
  if (steps.length === 0) {
    return { name, code: 0, block: `\n[${purpose}] ${name}: skip (this package has no ${purpose} command)\n` }
  }
  let block = ""
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
    if (result.status !== 0) return { name, code: result.status ?? 1, block }
  }
  return { name, code: 0, block }
}

function runSerial(purpose, plan, dirs) {
  for (const dir of dirs) {
    const name = path.basename(dir)
    const workspacePath = path.relative(ROOT, dir).replace(/\\/g, "/")
    const steps = plan[name]
    if (steps.length === 0) {
      console.log(`\n[${purpose}] ${name}: skip (this package has no ${purpose} command)`)
      continue
    }
    for (const [kind, ...rest] of steps) {
      console.log(`\n[${purpose}] ${name}: ${kind} ${rest.join(" ")}`)
      if (kind === "script") {
        if (!runNpm(["run", rest[0], "-w", workspacePath], ROOT)) return
      } else if (kind === "pack") {
        if (!runNpm(["pack", ...rest], dir)) return
      } else if (kind === "node") {
        const result = spawnSync(process.execPath, rest, { cwd: dir, stdio: "inherit" })
        if (result.status !== 0) {
          process.exitCode = result.status ?? 1
          return
        }
      } else throw new Error(`unknown step kind: ${kind}`)
    }
  }

  console.log(`\n[${purpose}] all packages OK`)
}

async function runParallel(purpose, plan, dirs) {
  let worst = 0
  const failed = []
  let index = 0
  async function worker() {
    while (index < dirs.length) {
      const dir = dirs[index++]
      const { name, code, block } = await runWorkspace(dir, purpose, plan)
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
  const unknown = raw.filter((arg) => arg !== "--serial" && arg.startsWith("-"))
  const purpose = raw.find((arg) => !arg.startsWith("-"))

  const plan = PLAN[purpose]
  if (unknown.length > 0 || !plan) {
    console.error(`usage: node scripts/workspace-run.mjs [--serial] <check|build|test> (got "${raw.join(" ") || purpose || ""}")`)
    process.exitCode = 2
    return
  }

  const dirs = workspaceDirs(ROOT)
  if (!checkPlan(plan, dirs, purpose)) {
    process.exitCode = 1
    return
  }

  if (serial) runSerial(purpose, plan, dirs)
  else return runParallel(purpose, plan, dirs)
}

main()
