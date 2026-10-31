#!/usr/bin/env node
// check-vocabulary.mjs - the one definition of the index's internal-vocabulary guard.
//
// CI and `npm run check` both run this file, so the local gate and the PR gate
// cannot disagree about which names are retired. The two pattern classes and the
// excluded path are the ones the workflow carried inline; bracketed classes keep
// the retired names out of this file's own text.
//
// Scope is the index's own files (root docs, workflows, scripts), not packages/.
// Imported trees are their own published documents: oc-harness-setup's shipped
// contract uses one of those names, oc-bifrost keeps vendor/rtk-LICENSE
// byte-identical to upstream, and the imported sources and design docs use the
// words as ordinary English.
//
// A grep exit of 1 means "no match" and is success. Any other nonzero exit is a
// tool failure: it is reported with the command and stderr, never as clean.
//
// Failures set process.exitCode and return; a forced exit can truncate the lines
// still queued when CI pipes them.
import { spawnSync } from "node:child_process"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

const PATTERNS = [
  { label: "internal name", re: "fl[e]et|l[i]feline|m[a]sthead" },
  { label: "internal history", re: "mod[u]le host|supers[e]d|unpubl[i]sh|noth[i]ng mounts" },
]

function main() {
  let dirty = false
  for (const { label, re } of PATTERNS) {
    const args = ["grep", "-I", "-n", "-i", "-E", re, "--", ".", ":(exclude)packages"]
    const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" })
    if (result.error) {
      console.error(`FAIL ${label}: could not run git: ${result.error.message}`)
      process.exitCode = 1
      return
    }
    if (result.status === 1) continue
    if (result.status !== 0) {
      console.error(`FAIL ${label}: git ${args.join(" ")} exited ${result.status}`)
      if (result.stderr) console.error(result.stderr.trimEnd())
      process.exitCode = 1
      return
    }
    const hits = (result.stdout ?? "").trimEnd()
    if (!hits) continue
    console.error(`${label} found in this repo's own files:`)
    console.error(hits)
    dirty = true
  }
  if (dirty) {
    process.exitCode = 1
    return
  }
  console.log("vocabulary: clean")
}

main()
