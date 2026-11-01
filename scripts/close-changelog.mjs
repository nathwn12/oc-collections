#!/usr/bin/env node
/**
 * Close a package changelog at the derived release version.
 *
 * The release gate derives the version from the commits, so nobody writes the
 * `## [<version>]` heading by hand: this step turns the entries under
 * `## [Unreleased]` into `## [<version>] - <date>` and leaves a fresh empty
 * `## [Unreleased]` above it, in one heading-line replacement. Nothing else in
 * the file moves.
 *
 * Idempotent: when the version heading is already there, the file is not
 * written and the exit is 0, so a re-run of the release job is a no-op.
 *
 * Usage:
 *   close-changelog.mjs --package <name> --version <v> [--date <yyyy-mm-dd>] [--dry-run]
 *   close-changelog.mjs --check
 *
 * Failures set process.exitCode and return; a forced exit can truncate the
 * lines still queued when CI pipes them.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ROOT } from "./workspace-plan.mjs"
import { resolvePackage } from "./release-target.mjs"

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const HEADING_RE = /^##\s+\[?Unreleased\]?\s*$/i

function escapedVersion(version) {
  return version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** True when the file already carries the section for this version. */
export function hasVersionSection(text, version) {
  return new RegExp(`^##\\s+\\[?v?${escapedVersion(version)}\\]?(\\s|$)`, "m").test(text)
}

/**
 * Pure close. Returns `{ ok, changed, text, reason }`: `ok:false` is a refusal,
 * `changed:false` with `ok:true` means the file was already closed.
 */
export function closeChangelog(text, version, date) {
  if (!VERSION_RE.test(version)) return { ok: false, changed: false, text, reason: `"${version}" is not X.Y.Z` }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, changed: false, text, reason: `"${date}" is not yyyy-mm-dd` }
  if (hasVersionSection(text, version)) {
    return { ok: true, changed: false, text, reason: `already has a section for ${version}` }
  }
  // Keep whatever ending the file already uses; a changelog is a tracked
  // document and a line-ending flip would bury the real change.
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const trailing = /\r?\n$/.test(text) ? eol : ""
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/)
  const at = lines.findIndex((line) => HEADING_RE.test(line))
  if (at < 0) {
    return { ok: false, changed: false, text, reason: 'has no "## [Unreleased]" heading to close' }
  }
  lines.splice(at, 1, "## [Unreleased]", "", `## [${version}] - ${date}`)
  return { ok: true, changed: true, text: lines.join(eol) + trailing, reason: `closed [Unreleased] as [${version}] - ${date}` }
}

// Offline fixtures: close, idempotent re-run, refusal, and a CRLF file.
const OPEN = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- hold the tail.\n\n## [0.3.1] - 2026-11-01\n\n### Added\n\n- a thing.\n"
const CLOSED = "# Changelog\n\n## [Unreleased]\n\n## [0.4.0] - 2026-11-02\n\n### Fixed\n\n- hold the tail.\n\n## [0.3.1] - 2026-11-01\n\n### Added\n\n- a thing.\n"

const FIXTURES = [
  {
    name: "close",
    text: OPEN,
    version: "0.4.0",
    date: "2026-11-02",
    expect: { ok: true, changed: true, text: CLOSED },
  },
  {
    name: "idempotent",
    text: CLOSED,
    version: "0.4.0",
    date: "2026-11-02",
    expect: { ok: true, changed: false, text: CLOSED },
  },
  {
    name: "refuse-no-unreleased",
    text: "# Changelog\n\n## [0.3.1] - 2026-11-01\n\n### Added\n\n- a thing.\n",
    version: "0.4.0",
    date: "2026-11-02",
    expect: { ok: false, changed: false },
  },
  {
    name: "refuse-bad-version",
    text: OPEN,
    version: "0.4",
    date: "2026-11-02",
    expect: { ok: false, changed: false },
  },
  {
    name: "keeps-crlf",
    text: OPEN.replace(/\n/g, "\r\n"),
    version: "0.4.0",
    date: "2026-11-02",
    expect: { ok: true, changed: true, eol: "\r\n" },
  },
]

export function runFixtures() {
  let passed = 0
  const total = FIXTURES.length
  let failed = 0
  for (const fixture of FIXTURES) {
    const result = closeChangelog(fixture.text, fixture.version, fixture.date)
    const problems = []
    if (result.ok !== fixture.expect.ok) problems.push(`ok=${result.ok}, expected ${fixture.expect.ok}`)
    if (result.changed !== fixture.expect.changed) problems.push(`changed=${result.changed}, expected ${fixture.expect.changed}`)
    if ("text" in fixture.expect && result.text !== fixture.expect.text) problems.push("text differs from the expected file")
    if ("eol" in fixture.expect) {
      const onlyCrlf = !/(^|[^\r])\n/.test(result.text)
      if (!onlyCrlf) problems.push("line endings were not kept")
    }
    if (problems.length > 0) {
      failed++
      console.log(`FAIL ${fixture.name}: ${problems.join("; ")}`)
      continue
    }
    passed++
    console.log(`PASS ${fixture.name}: ${result.changed ? "closed" : "unchanged"}${result.ok ? "" : " (refused)"}`)
  }
  console.log(`close-changelog: fixtures ${total} passed ${passed} failed ${failed}`)
  return failed === 0
}

function usage() {
  return [
    "usage: close-changelog.mjs --package <name> --version <v> [--date <yyyy-mm-dd>] [--dry-run]",
    "       close-changelog.mjs --check",
  ].join("\n")
}

function parseArgs(argv) {
  const options = { mode: "close", packageName: null, version: null, date: new Date().toISOString().slice(0, 10), dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--check") options.mode = "check"
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--package" && argv[i + 1]) options.packageName = argv[++i]
    else if (arg === "--version" && argv[i + 1]) options.version = argv[++i]
    else if (arg === "--date" && argv[i + 1]) options.date = argv[++i]
    else throw new Error(`unknown argument "${arg}"\n${usage()}`)
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`close-changelog: ${error.message}`)
    process.exitCode = 2
    return
  }

  try {
    if (options.mode === "check") {
      if (!runFixtures()) process.exitCode = 1
      return
    }
    if (!options.packageName || !options.version) {
      console.error(`close-changelog: --package and --version are required\n${usage()}`)
      process.exitCode = 2
      return
    }

    const target = resolvePackage(options.packageName)
    const file = path.join(target.dir, "CHANGELOG.md")
    const display = `${path.relative(ROOT, file).split(path.sep).join("/")}`
    if (!fs.existsSync(file)) throw new Error(`${display} does not exist`)
    const before = fs.readFileSync(file, "utf8")
    const result = closeChangelog(before, options.version, options.date)
    if (!result.ok) {
      console.error(`close-changelog: ${display} ${result.reason}`)
      process.exitCode = 1
      return
    }
    if (!result.changed) {
      console.log(`changelog: ${display} ${result.reason}; nothing written`)
      return
    }
    if (options.dryRun) {
      console.log(`changelog: ${display} dry run: would ${result.reason}`)
      return
    }
    fs.writeFileSync(file, result.text)
    console.log(`changelog: ${display} ${result.reason}`)
  } catch (error) {
    console.error(`close-changelog: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
