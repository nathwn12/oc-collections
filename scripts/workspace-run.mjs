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
 * Usage: node scripts/workspace-run.mjs <check|build|test>
 */
import { spawnSync } from "node:child_process"
import path from "node:path"

import { PLAN, ROOT, checkPlan, workspaceDirs } from "./workspace-plan.mjs"

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

function main() {
  const purpose = process.argv[2]

  const plan = PLAN[purpose]
  if (!plan) {
    console.error(`usage: node scripts/workspace-run.mjs <check|build|test> (got "${purpose ?? ""}")`)
    process.exitCode = 2
    return
  }

  const dirs = workspaceDirs(ROOT)
  if (!checkPlan(plan, dirs, purpose)) {
    process.exitCode = 1
    return
  }

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

main()
