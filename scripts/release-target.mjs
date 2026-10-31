#!/usr/bin/env node
/**
 * Resolve and validate a release target for .github/workflows/release.yml.
 *
 * Modes:
 *   --tag <tag>                          parse <name>@<version>, check the manifest
 *   --package <name>                     version comes from that package's manifest
 *   --registry-guard <versions.json> <target>
 *                                        fail unless target is newer than every
 *                                        published version in the JSON array
 *
 * The parse and manifest guards are pure and offline (unit-tested in
 * release-target.test.mjs). The registry guard reads a file the workflow
 * fetched with `npm view <pkg> versions --json`, so its comparison is testable
 * without the network.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Releasable packages. Everything else is source-only: a package the owner has
// not admitted here cannot be tagged or dispatched. Admitting one is a one-line
// change here; the dispatch choice list in .github/workflows/release.yml must
// match.
export const ALLOWED = [
  "@nathwn12/oc-bifrost",
  "oc-flight-deck",
  "oc-harness-setup",
  "rea-shim",
]

const ROOT = path.resolve(import.meta.dirname, "..")

// Scoped (@scope/name) or unscoped (name); npm names are lowercase but the
// regex is case-insensitive so a wrong-case tag fails at the allowlist instead
// of being misparsed.
const NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parseTag(tag) {
  if (typeof tag !== "string" || tag.length === 0) throw new Error("empty tag")
  const at = tag.lastIndexOf("@")
  if (at <= 0) throw new Error(`tag "${tag}" must be <package-name>@<version>`)
  const name = tag.slice(0, at)
  const version = tag.slice(at + 1)
  if (!NAME_RE.test(name)) throw new Error(`tag "${tag}" has an invalid package name "${name}"`)
  if (!VERSION_RE.test(version)) throw new Error(`tag "${tag}" has an invalid version "${version}"`)
  return { name, version }
}

function parseVersion(value) {
  const match = VERSION_RE.exec(String(value))
  if (!match) throw new Error(`not a semver version: ${value}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : [],
  }
}

/** Semver precedence: negative, zero, or positive. */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1 // release > prerelease
  if (pb.pre.length === 0) return -1
  const length = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < length; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
      continue
    }
    if (numericX) return -1 // numeric identifiers sort below alphanumeric
    if (numericY) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function resolvePackage(name, root = ROOT) {
  if (!ALLOWED.includes(name)) {
    throw new Error(`"${name}" is not a releasable package; allowed: ${ALLOWED.join(", ")}`)
  }
  // Resolve by the manifest's name, not by the directory: a scoped package's
  // directory is packages/<unscoped-name> (e.g. packages/oc-bifrost).
  const base = path.join(root, "packages")
  let found
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(base, entry.name, "package.json")
    if (!fs.existsSync(manifestPath)) continue
    const candidate = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (candidate.name === name) {
      found = { dir: path.join(base, entry.name), pkg: candidate }
      break
    }
  }
  if (!found) throw new Error(`no workspace package named "${name}" under packages/`)
  const { dir, pkg } = found
  if (typeof pkg.version !== "string" || pkg.version.length === 0) throw new Error(`${name} has no version`)
  if (pkg.private === true) {
    throw new Error(
      `${name} is marked private: true and cannot be published; drop the private flag only after a recorded owner ruling`,
    )
  }
  if (name.startsWith("@") && pkg.publishConfig?.access !== "public") {
    throw new Error(`${name} is scoped and lacks publishConfig.access: public`)
  }
  return { name, version: pkg.version, dir }
}

/** Fail unless the target is strictly newer than every listed published version. */
export function guardRegistry(versions, target) {
  const list = Array.isArray(versions) ? versions : [versions]
  if (list.length === 0) return 0
  const blocking = list.filter((version) => compareVersions(target, version) <= 0)
  if (blocking.length > 0) {
    const newest = list.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))
    throw new Error(
      `target ${target} is not newer than published version(s) ${blocking.join(", ")} (newest ${newest}); refusing to republish`,
    )
  }
  return list.length
}

function emit(target) {
  const dir = path.relative(ROOT, target.dir).replace(/\\/g, "/")
  console.log(`package=${target.name}`)
  console.log(`version=${target.version}`)
  console.log(`dir=${dir}`)
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `name=${target.name}\nversion=${target.version}\ndir=${dir}\n`)
  }
}

function main() {
  const args = process.argv.slice(2)
  try {
    if (args[0] === "--tag") {
      const parsed = parseTag(args[1])
      const target = resolvePackage(parsed.name)
      if (target.version !== parsed.version) {
        throw new Error(`tag version ${parsed.version} != ${target.name} manifest version ${target.version}`)
      }
      emit(target)
    } else if (args[0] === "--package") {
      emit(resolvePackage(args[1]))
    } else if (args[0] === "--registry-guard") {
      const versions = JSON.parse(fs.readFileSync(args[1], "utf8"))
      const count = guardRegistry(versions, args[2])
      console.log(`PASS registry guard: ${args[2]} is newer than all ${count} published version(s)`)
    } else {
      throw new Error(
        "usage: release-target.mjs --tag <tag> | --package <name> | --registry-guard <versions.json> <target>",
      )
    }
  } catch (error) {
    console.error(`release-target: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
