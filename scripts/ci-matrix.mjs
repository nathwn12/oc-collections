#!/usr/bin/env node
/**
 * ci-matrix.mjs - the CI check matrix, derived from the shared plan.
 *
 * Prints one JSON array on stdout: every workspace directory basename, in
 * `workspaceDirs()` order. The `ci` workflow fans one leg out per entry and
 * each leg runs `node scripts/workspace-run.mjs check --package <entry>`,
 * so a red package fails its own leg instead of the whole monorepo gate.
 *
 * Fail-closed like the plan itself: a workspace missing from `PLAN.check`,
 * or a plan entry with no directory, exits 2 instead of emitting a matrix
 * that silently skips a package.
 */
import path from "node:path"

import { PLAN, ROOT, workspaceDirs } from "./workspace-plan.mjs"

const dirs = workspaceDirs(ROOT)
const names = dirs.map((dir) => path.basename(dir))
const planned = Object.keys(PLAN.check ?? {})
const missing = names.filter((name) => !planned.includes(name))
const extra = planned.filter((name) => !names.includes(name))
if (missing.length > 0 || extra.length > 0) {
  for (const name of missing) console.error(`[ci-matrix] no plan for workspace "${name}"`)
  for (const name of extra) console.error(`[ci-matrix] plan names "${name}", which is not a workspace`)
  process.exit(2)
}
console.log(JSON.stringify(names))
