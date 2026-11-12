#!/usr/bin/env node
/**
 * preflight.mjs - the local mirror of the `ci` workflow's gate.
 *
 * One command, seconds, changed packages only. Every step it runs is a step
 * .github/workflows/ci.yml runs, in the same order and with the same
 * argument grammar:
 *
 *   static  (ci.yml `static`)     vocabulary, index structure + its self-test,
 *                                 documentation truth + its self-test
 *   check   (ci.yml `check` leg)  `node scripts/workspace-run.mjs check
 *                                 --package <name>`, one leg per package, with
 *                                 OC_CHECK_CACHE=0 - the same env the matrix
 *                                 legs set, because a gate that skips is not a
 *                                 gate
 *
 * `launchers` (scripts/check-launchers.mjs) is the one step ci.yml's static job
 * does not carry, but the root `check` script does: it is kept here so the
 * local gate is a superset of both, never weaker than either.
 *
 * The one step that exists only as PowerShell (scripts/check-index.ps1 and its
 * self-test) is called as `pwsh -NoProfile -File`, exactly as ci.yml calls it;
 * every other step is Node and adds no pwsh dependency to the hot path.
 *
 * Modes:
 *   --changed (default)  the packages touched by `git diff --name-only
 *                        origin/main...HEAD` plus uncommitted changes, and
 *                        always the repo-wide static steps
 *   --all                every package: the pre-merge ceremony
 *   --install            write .git/hooks/pre-push running `--changed`
 *   --uninstall          remove that hook, and only that hook
 *
 * Output is one PASS/FAIL line per step with its elapsed milliseconds, then
 * `preflight: N passed, M failed, X.Xs`, then the failing steps' own output
 * verbatim. Exit is 1 on any failure, 2 on a usage error.
 *
 * Failures set process.exitCode and return; a forced exit can truncate output
 * still queued when a hook pipes it.
 */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { workspaceDirs } from "./workspace-plan.mjs"

export const ROOT = path.resolve(import.meta.dirname, "..")

const USAGE =
  "usage: node scripts/preflight.mjs [--changed|--all] | --install | --uninstall"

/**
 * Package legs run as separate processes, exactly as the CI legs do, so a red
 * package cannot fail another's leg. Four at once bounds the concurrent npm
 * installs oc-harness-setup performs; the root fan-out's own cap is 8, but it
 * shares one process and one cache.
 */
const CONCURRENCY = Math.max(1, Math.min(os.cpus().length || 4, 4))

/** Root-level paths whose change can affect every package's check. */
const WHOLE_REPO = new Set([
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "scripts/workspace-plan.mjs",
])

/** Marker identifying the hook this script owns; --uninstall trusts only it. */
export const HOOK_MARKER = "managed by scripts/preflight.mjs"

const nodeStep = (name, args) => ({ group: "static", name, cmd: process.execPath, args })

/** The ci.yml `static` steps, in gate order, plus the root check's launchers. */
export const STATIC_STEPS = [
  nodeStep("vocabulary", ["scripts/check-vocabulary.mjs"]),
  nodeStep("launchers", ["scripts/check-launchers.mjs"]),
  {
    group: "static",
    name: "structural index",
    cmd: "pwsh",
    args: ["-NoProfile", "-File", "scripts/check-index.ps1", "--structural"],
  },
  {
    group: "static",
    name: "index self-test",
    cmd: "pwsh",
    args: ["-NoProfile", "-File", "scripts/check-index.selftest.ps1"],
  },
  nodeStep("docs check", ["scripts/check-docs.mjs"]),
  nodeStep("docs self-test", ["scripts/check-docs.selftest.mjs"]),
]

/**
 * Which packages a diff can affect. Pure, so the derivation is proved offline.
 *
 * A root manifest or lockfile, and the shared plan that defines what `check`
 * means, select every package: the last one because a plan edit can change any
 * package's command. Docs, the README index and unrelated scripts select none -
 * the static steps cover them. A path naming a workspace the plan does not know
 * selects nothing; the plan's own fail-closed check reports that case.
 */
export function selectPackages(changedPaths, names) {
  const selected = new Set()
  for (const raw of changedPaths) {
    const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "")
    if (WHOLE_REPO.has(rel)) return [...names]
    const match = /^packages\/([^/]+)(?:\/|$)/.exec(rel)
    if (match && names.includes(match[1])) selected.add(match[1])
  }
  return [...selected].sort()
}

/** Every workspace directory basename, in the plan's own order. */
export function packageNames(root = ROOT) {
  return workspaceDirs(root).map((dir) => path.basename(dir))
}

function git(args, root) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.error || result.status !== 0) return null
  return result.stdout
}

/** Paths in `git status --porcelain` form, with renames reduced to the new path. */
function statusPaths(root) {
  const out = git(["status", "--porcelain"], root)
  if (out === null) return []
  const paths = []
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue
    const entry = line.slice(3)
    const arrow = entry.indexOf(" -> ")
    paths.push(arrow >= 0 ? entry.slice(arrow + 4) : entry.replace(/^"|"$/g, ""))
  }
  return paths
}

/**
 * The changed set: `origin/main...HEAD` (the merge base, as GitHub computes it
 * for a pull request) plus everything uncommitted, staged and untracked. Base
 * resolution falls back to `main` and then to the working tree alone, so the
 * command answers in a clone that has no remote yet instead of failing.
 */
export function changedPaths(root = ROOT) {
  const paths = new Set(statusPaths(root))
  for (const base of ["origin/main", "main"]) {
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
      cwd: root,
      encoding: "utf8",
    })
    if (exists.status !== 0) continue
    const out = git(["diff", "--name-only", `${base}...HEAD`], root)
    if (out === null) continue
    for (const line of out.split("\n")) if (line.trim() !== "") paths.add(line.trim())
    break
  }
  return [...paths]
}

/** Async captured run: the whole output is kept, and shown only if it failed. */
export function spawnStep(step) {
  return new Promise((resolve) => {
    let output = ""
    let child
    try {
      child = spawn(step.cmd, step.args, { cwd: step.cwd, env: step.env ?? process.env })
    } catch (error) {
      resolve({ status: 1, output: `${error?.message ?? error}\n` })
      return
    }
    if (child.stdout) child.stdout.on("data", (chunk) => { output += chunk.toString("utf8") })
    if (child.stderr) child.stderr.on("data", (chunk) => { output += chunk.toString("utf8") })
    child.on("error", (error) => resolve({ status: 1, output: output + `${step.cmd}: ${error?.message ?? error}\n` }))
    child.on("close", (status) => resolve({ status: status ?? 1, output }))
  })
}

/** Fixed-width label so PASS/FAIL lines line up. */
function label(step) {
  return (step.group === "package" ? `pkg ${step.name}` : step.name).padEnd(26)
}

async function forEachLimit(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Run the gate. Everything that touches the world is injectable - `runner` to
 * prove the failure path offline, `changedPaths` and `names` to prove the
 * derivation - so the test needs no git, no network and no pwsh.
 */
export async function runPreflight({
  argv = [],
  root = ROOT,
  names = [],
  changedPaths: paths = [],
  runner = spawnStep,
  log = console.log,
  clock = () => performance.now(),
} = {}) {
  const flags = argv.filter((arg) => arg.startsWith("-"))
  const unknown = flags.filter((flag) => flag !== "--changed" && flag !== "--all")
  if (unknown.length > 0) {
    log(`preflight: unknown argument ${unknown.join(" ")}`)
    log(USAGE)
    return { exitCode: 2, passed: 0, failed: 0, failures: [], results: [] }
  }

  const chosen = flags.includes("--all") ? [...names] : selectPackages(paths, names)
  const steps = [
    ...STATIC_STEPS.map((step) => ({ ...step, cwd: root })),
    ...chosen.map((name) => ({
      group: "package",
      name,
      cmd: process.execPath,
      args: [path.join(root, "scripts", "workspace-run.mjs"), "check", "--package", name],
      cwd: root,
      env: { ...process.env, OC_CHECK_CACHE: "0" },
    })),
  ]

  const start = clock()
  const results = []
  const failures = []

  async function run(step) {
    const begun = clock()
    const { status, output } = await runner(step)
    const ms = Math.round(clock() - begun)
    const record = { ...step, status, ms, output }
    results.push(record)
    log(`${status === 0 ? "PASS" : "FAIL"}  ${label(step)} ${String(ms).padStart(6)}ms`)
    if (status !== 0) failures.push(record)
  }

  // Static steps are a second in total and share the tree's index files: run
  // them in gate order. Package legs are separate processes and independent.
  for (const step of steps.filter((step) => step.group === "static")) await run(step)
  const legs = steps.filter((step) => step.group === "package")
  await forEachLimit(legs, CONCURRENCY, run)

  for (const failure of failures) {
    log(`\n--- ${failure.group === "package" ? `pkg ${failure.name}` : failure.name} output ---`)
    log(failure.output.trimEnd())
    log(`--- end ${failure.group === "package" ? `pkg ${failure.name}` : failure.name} ---`)
  }

  const elapsed = (clock() - start) / 1000
  const failed = failures.length
  const passed = results.length - failed
  log(`preflight: ${passed} passed, ${failed} failed, ${elapsed.toFixed(1)}s`)
  return { exitCode: failed > 0 ? 1 : 0, passed, failed, failures, results }
}

function hookPath(root) {
  const result = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: root, encoding: "utf8" })
  const rel = result.status === 0 ? result.stdout.trim() : path.join(".git", "hooks")
  return path.join(path.resolve(root, rel), "pre-push")
}

function stamp(now) {
  const pad = (n) => String(n).padStart(2, "0")
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

function hookContent() {
  // sh, one line per decision, because a hook that fails silently is worse than
  // none: a missing node aborts instead of passing the push.
  return `#!/bin/sh
# pre-push: ${HOOK_MARKER} --install. The local mirror of the ci gate.
# Remove with: node scripts/preflight.mjs --uninstall
if ! command -v node >/dev/null 2>&1; then
  echo "preflight: node is not on PATH; refusing to push an unproven tree" >&2
  exit 1
fi
cd "$(git rev-parse --show-toplevel)" || exit 1
if ! node scripts/preflight.mjs --changed; then
  echo "preflight: push aborted - fix the failures above, or git push --no-verify to bypass the gate" >&2
  exit 1
fi
`
}

/**
 * Write the hook. An existing hook that is not ours is copied to
 * `pre-push.bak-<timestamp>` first and reported, never overwritten blind.
 */
export function installHook({ root = ROOT, now = new Date() } = {}) {
  const file = hookPath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let backup = null
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8")
    if (!existing.includes(HOOK_MARKER)) {
      backup = `${file}.bak-${stamp(now)}`
      fs.copyFileSync(file, backup)
    }
  }
  fs.writeFileSync(file, hookContent(), "utf8")
  try {
    fs.chmodSync(file, 0o755)
  } catch {
    // Windows has no executable bit; git for Windows runs hooks through sh.
  }
  return { file, backup }
}

/** Remove the hook only when it carries our marker. */
export function uninstallHook({ root = ROOT } = {}) {
  const file = hookPath(root)
  if (!fs.existsSync(file)) return { file, removed: false, reason: "there is no pre-push hook" }
  if (!fs.readFileSync(file, "utf8").includes(HOOK_MARKER)) {
    return { file, removed: false, reason: "the pre-push hook is not ours, leaving it alone" }
  }
  fs.unlinkSync(file)
  return { file, removed: true }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--install")) {
    const { file, backup } = installHook({ root: ROOT })
    if (backup) console.log(`preflight: existing hook copied to ${path.basename(backup)}`)
    console.log(`preflight: installed ${file}`)
    console.log("preflight: every push now runs `node scripts/preflight.mjs --changed`")
    return
  }
  if (argv.includes("--uninstall")) {
    const { file, removed, reason } = uninstallHook({ root: ROOT })
    console.log(removed ? `preflight: removed ${file}` : `preflight: not removed: ${reason}`)
    if (!removed) process.exitCode = 1
    return
  }
  const result = await runPreflight({
    argv,
    root: ROOT,
    names: packageNames(ROOT),
    changedPaths: changedPaths(ROOT),
  })
  process.exitCode = result.exitCode
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main()
}
