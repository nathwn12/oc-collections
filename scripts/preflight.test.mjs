#!/usr/bin/env node
/**
 * preflight.test.mjs - offline proof of the two halves that can be wrong
 * silently: which packages a diff selects, and whether a failing step reaches
 * the exit code.
 *
 * No git, no network, no pwsh: the changed paths and the step runner are
 * injected. A fake runner records the steps preflight asked for and returns a
 * chosen status, so the failure path is proved without breaking the tree.
 *
 * Usage: node --test scripts/preflight.test.mjs
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { STATIC_STEPS, runPreflight, selectPackages } from "./preflight.mjs"

const NAMES = ["janua", "oc-talk", "rea-shim"]

test("selectPackages: one package's file selects only that package", () => {
  assert.deepEqual(selectPackages(["packages/oc-talk/index.js"], NAMES), ["oc-talk"])
})

test("selectPackages: a deep nested file still names its package", () => {
  assert.deepEqual(selectPackages(["packages/janua/src/pipe/group.js"], NAMES), ["janua"])
})

test("selectPackages: windows separators and duplicates collapse", () => {
  assert.deepEqual(
    selectPackages(["packages\\oc-talk\\a.js", "packages/oc-talk/b.js"], NAMES),
    ["oc-talk"],
  )
})

test("selectPackages: several packages come back sorted", () => {
  assert.deepEqual(
    selectPackages(["packages/rea-shim/x.js", "packages/janua/y.js"], NAMES),
    ["janua", "rea-shim"],
  )
})

test("selectPackages: a root manifest or lockfile selects every package", () => {
  for (const root of ["package.json", "package-lock.json", "bun.lock"]) {
    assert.deepEqual(selectPackages([root], NAMES), NAMES, `expected all for ${root}`)
  }
})

test("selectPackages: the shared plan selects every package", () => {
  assert.deepEqual(selectPackages(["scripts/workspace-plan.mjs"], NAMES), NAMES)
})

test("selectPackages: docs, the README index and scripts select no package", () => {
  const paths = ["README.md", "CHANGELOG.md", "scripts/check-docs.mjs", ".github/workflows/ci.yml"]
  assert.deepEqual(selectPackages(paths, NAMES), [])
})

test("selectPackages: a path outside the plan is ignored, not fatal", () => {
  assert.deepEqual(selectPackages(["packages/gone/x.js"], NAMES), [])
})

test("the static steps are the six CI static steps, in gate order", () => {
  assert.deepEqual(
    STATIC_STEPS.map((step) => step.name),
    ["vocabulary", "launchers", "structural index", "index self-test", "docs check", "docs self-test"],
  )
})

function recorder(statusFor = () => 0) {
  const steps = []
  const runner = async (step) => {
    steps.push(step)
    const status = statusFor(step)
    return { status, output: status === 0 ? "" : `FAIL ${step.name}: fixture red\n` }
  }
  return { steps, runner }
}

test("runPreflight: a failing step is a non-zero exit carrying that step's output", async () => {
  const { runner } = recorder((step) => (step.name === "docs check" ? 1 : 0))
  const result = await runPreflight({
    argv: ["--changed"],
    root: "R",
    names: NAMES,
    changedPaths: ["README.md"],
    runner,
    log: () => {},
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.passed, STATIC_STEPS.length - 1)
  assert.match(result.failures[0].output, /FAIL docs check: fixture red/)
})

test("runPreflight: an all-green run exits 0 and counts every step", async () => {
  const { runner } = recorder()
  const result = await runPreflight({
    argv: ["--all"],
    root: "R",
    names: NAMES,
    changedPaths: [],
    runner,
    log: () => {},
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.failed, 0)
  assert.equal(result.passed, STATIC_STEPS.length + NAMES.length)
})

test("runPreflight --changed runs only the selected package, through workspace-run", async () => {
  const { steps, runner } = recorder()
  await runPreflight({
    argv: ["--changed"],
    root: "R",
    names: NAMES,
    changedPaths: ["packages/oc-talk/package.json"],
    runner,
    log: () => {},
  })
  const packageSteps = steps.filter((step) => step.group === "package")
  assert.deepEqual(packageSteps.map((step) => step.name), ["oc-talk"])
  const [step] = packageSteps
  assert.deepEqual(step.args.slice(1), ["check", "--package", "oc-talk"])
  assert.match(step.args[0], /workspace-run\.mjs$/)
  assert.equal(step.env.OC_CHECK_CACHE, "0", "a gate that skips is not a gate")
})

test("runPreflight --all runs every package, one leg each", async () => {
  const { steps, runner } = recorder()
  await runPreflight({
    argv: ["--all"],
    root: "R",
    names: NAMES,
    changedPaths: [],
    runner,
    log: () => {},
  })
  assert.deepEqual(
    steps.filter((step) => step.group === "package").map((step) => step.name),
    NAMES,
  )
})

test("runPreflight: an unknown flag is a usage error, not a green run", async () => {
  const { steps, runner } = recorder()
  const result = await runPreflight({ argv: ["--nope"], root: "R", names: NAMES, runner, log: () => {} })
  assert.equal(result.exitCode, 2)
  assert.equal(steps.length, 0)
})

/** Peak overlap of package legs: 1 proves the default cannot starve a timing test. */
async function peakConcurrency(argv) {
  let active = 0
  let peak = 0
  const runner = async (step) => {
    if (step.group !== "package") return { status: 0, output: "" }
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return { status: 0, output: "" }
  }
  await runPreflight({ argv, root: "R", names: NAMES, changedPaths: [], runner, log: () => {} })
  return peak
}

test("runPreflight: package legs run one at a time by default", async () => {
  assert.equal(await peakConcurrency(["--all"]), 1)
})

test("runPreflight --jobs runs legs concurrently when asked", async () => {
  assert.ok((await peakConcurrency(["--all", "--jobs", "3"])) > 1)
})

test("runPreflight: a bad --jobs is a usage error", async () => {
  const { steps, runner } = recorder()
  for (const argv of [["--all", "--jobs"], ["--all", "--jobs", "0"], ["--all", "--jobs", "x"]]) {
    const result = await runPreflight({ argv, root: "R", names: NAMES, runner, log: () => {} })
    assert.equal(result.exitCode, 2, `expected a usage error for ${argv.join(" ")}`)
  }
  assert.equal(steps.length, 0)
})
