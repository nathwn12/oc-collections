#!/usr/bin/env node
/**
 * Shared workspace plan.
 *
 * Single source of truth for which packages the root fan-out knows about and
 * the exact commands each package's own check/build/test run. It is imported
 * by workspace-run.mjs (which executes a purpose's plan) and pack-check.mjs
 * (which fails closed on an unplanned workspace), so the two cannot drift.
 *
 * Every workspace must be listed under `check`; `build` and `test` may be an
 * empty array for a package that has no such step.
 */
import fs from "node:fs"
import path from "node:path"

export const ROOT = path.resolve(import.meta.dirname, "..")

export const PLAN = {
  check: {
    "oc-bifrost": [["script", "check"]],
    "oc-flight-deck": [["script", "check"]],
    "oc-harness-setup": [["script", "test"], ["script", "check"]],
    "rea-shim": [["script", "check"], ["script", "test"], ["pack", "--dry-run"]],
  },
  build: {
    "oc-bifrost": [["script", "compile"]],
    "oc-flight-deck": [["script", "compile"]],
    "oc-harness-setup": [],
    "rea-shim": [],
  },
  test: {
    "oc-bifrost": [["script", "test"]],
    "oc-flight-deck": [["script", "test"]],
    "oc-harness-setup": [["script", "test"]],
    "rea-shim": [["script", "test"]],
  },
}

export function workspaceDirs(root = ROOT) {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const dirs = []
  for (const pattern of rootPkg.workspaces ?? []) {
    if (!pattern.endsWith("/*")) throw new Error(`unsupported workspace pattern: ${pattern}`)
    const base = path.join(root, pattern.slice(0, -2))
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(base, entry.name)
      if (fs.existsSync(path.join(dir, "package.json"))) dirs.push(dir)
    }
  }
  return dirs.sort()
}

/**
 * Fail closed when a discovered workspace has no plan entry, or when the plan
 * names something that is not a workspace. Returns false after naming why.
 */
export function checkPlan(plan, dirs, label) {
  const discovered = new Set(dirs.map((dir) => path.basename(dir)))
  for (const name of discovered) {
    if (!(name in plan)) {
      console.error(`[${label}] no plan for workspace "${name}": add its exact command to scripts/workspace-plan.mjs`)
      return false
    }
  }
  for (const name of Object.keys(plan)) {
    if (!discovered.has(name)) {
      console.error(`[${label}] plan names "${name}", which is not a workspace`)
      return false
    }
  }
  return true
}
