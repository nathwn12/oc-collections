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
 * Usage: node scripts/workspace-run.mjs <check|build|test>
 */
import { spawnSync } from "node:child_process"
import path from "node:path"

import { PLAN, ROOT, checkPlan, workspaceDirs } from "./workspace-plan.mjs"

const purpose = process.argv[2]

const plan = PLAN[purpose]
if (!plan) {
  console.error(`usage: node scripts/workspace-run.mjs <check|build|test> (got "${purpose ?? ""}")`)
  process.exit(2)
}

const dirs = workspaceDirs(ROOT)
if (!checkPlan(plan, dirs, purpose)) process.exit(1)

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd,
        stdio: "inherit",
        shell: process.platform === "win32",
      })
  if (result.status !== 0) process.exit(result.status ?? 1)
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
    if (kind === "script") runNpm(["run", rest[0], "-w", workspacePath], ROOT)
    else if (kind === "pack") runNpm(["pack", ...rest], dir)
    else if (kind === "node") {
      const result = spawnSync(process.execPath, rest, { cwd: dir, stdio: "inherit" })
      if (result.status !== 0) process.exit(result.status ?? 1)
    } else throw new Error(`unknown step kind: ${kind}`)
  }
}

console.log(`\n[${purpose}] all packages OK`)
