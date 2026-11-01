#!/usr/bin/env node
/**
 * Derive the version a release run must produce.
 *
 * The release lane takes no version from a human. One release unit is one
 * package (`--package <name>`); the base is the highest `<name>@X.Y.Z` tag for
 * that package, and with no tag the base is the package's manifest version and
 * the derivation says so. The commit range is `<base>..HEAD`:
 *
 *   git log --no-merges -z --format='%H%x09%s%x09%b' <base>..HEAD
 *
 * `-z` terminates each record with NUL so a multi-line body cannot be confused
 * with the next commit; the format string is otherwise the one the lane names.
 * The range is the whole repository: these packages version independently but
 * share one release branch, and a commit anywhere in it is a candidate for
 * every package the run releases.
 *
 * Level, highest wins: major on `!` or `BREAKING CHANGE`; else minor on `feat`;
 * else patch on `fix`/`perf`. A 0.x base bumps the minor instead of the major.
 *
 * Refusals (each names what to change):
 *   EMPTY_RANGE        no commit since the base
 *   NO_RELEASABLE      every commit has a non-releasable type
 *   NON_CONVENTIONAL   subjects that are not `type(scope)!: description`, or
 *                      name a type this lane does not know (listed verbatim)
 *   CHANGELOG_EMPTY    `## [Unreleased]` in the package changelog is empty and
 *                      there is no section for the derived version
 *   MANIFEST_MISMATCH  the derived version is not the package manifest version
 *
 * `release:` is an ignored type, not an unknown one: this repository wrote
 * `release: <package> <version>` commits before the derivation existed, and
 * they stay in a package's range until its next tag. Any other unknown type is
 * still refused, because a typo such as `feats:` would ship as no change.
 *
 * Modes:
 *   --package <name>              derive and enforce every refusal (release gate)
 *   --package <name> --prepare    the release lane will close the changelog and
 *                                 write the manifest, index cell and lockfile
 *                                 in the runner, so CHANGELOG_EMPTY and
 *                                 MANIFEST_MISMATCH become notes, never refusals
 *   --package <name> --dry-run    print the derivation, list refusals as
 *                                 "would refuse", exit 0
 *   --package <name> --json       the same result as one JSON object
 *   --all                         every releasable package with a derived
 *                                 version, in the allowlist order; the push
 *                                 lane's plan, so it implies --prepare
 *   --all --json                  `{ packages: [...], skipped: [...] }`
 *   --package <name> --version <v> --write-cells
 *                                 write <v> into the package manifest, the root
 *                                 index cell and the lockfile cell (runner only;
 *                                 the caller restores them, never commits)
 *   --package <name> --version <v> --assert-cells
 *                                 assert the package manifest, the root index
 *                                 cell and the lockfile cell all carry <v>
 *   --tag-exists <tag>            exit 0 when the local tag exists, 1 when it
 *                                 does not (the release lane's never-retag guard)
 *   --check                       run the offline fixtures
 *
 * `--all` is the batch lane's plan: it reports each package's own refusals but
 * exits 0, because one package refusing must not stop the others. The per
 * package gate is the same command without `--all`.
 *
 * Output for the workflow: with GITHUB_OUTPUT set, `name`, `version`, `tag`,
 * `base` and `level` are appended there (`--all` instead writes `matrix` and
 * `count`).
 *
 * Failures set process.exitCode and return; a forced exit can truncate the
 * lines still queued when CI pipes them.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ROOT } from "./workspace-plan.mjs"
import { ALLOWED, compareVersions, parseTag, resolvePackage } from "./release-target.mjs"

// Conventional types this lane understands. A type outside this table is
// refused rather than ignored: `feats: ...` is a typo for a minor bump, and
// silence would ship it as no change at all.
const TYPES = {
  feat: "minor",
  fix: "patch",
  perf: "patch",
  docs: "ignore",
  chore: "ignore",
  ci: "ignore",
  build: "ignore",
  refactor: "ignore",
  style: "ignore",
  test: "ignore",
  revert: "ignore",
  // Housekeeping commits this repo already wrote before the derivation
  // existed (`release: janua 0.1.2 and oc-talk 0.1.2`). Ignored, not unknown:
  // they are still inside a package's tag range until its next release.
  release: "ignore",
}

const LEVEL_RANK = { patch: 1, minor: 2, major: 3 }
const SUBJECT_RE = /^([a-z]+)(?:\(([^()]*)\))?(!)?: (.+)$/
// Non-null so `---` and `-1` cannot pass as a version; leading zeros are not
// semver and would produce a tag npm rejects.
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" })
  if (result.error) throw new Error(`could not run git: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim()}`)
  }
  return result.stdout
}

function refusal(code, message) {
  return { code, message }
}

/** The highest `<name>@X.Y.Z` tag for one package, or null when it has none. */
export function highestTag(tags, name) {
  let best = null
  for (const tag of tags) {
    let parsed
    try {
      parsed = parseTag(tag)
    } catch {
      continue // `archive/...` and the repository's own `v<version>` tags
    }
    if (parsed.name !== name) continue
    if (!VERSION_RE.test(parsed.version)) continue
    if (best === null || compareVersions(parsed.version, best.version) > 0) best = { tag, version: parsed.version }
  }
  return best
}

/** Read the tags git knows about, local and nothing else. */
export function readTags() {
  return git(["tag", "--list"]).split(/\r?\n/).filter(Boolean)
}

/** Exact membership: a prefix or a similar tag is never a match. */
export function hasTag(tags, tag) {
  return tags.includes(tag)
}

/** Commits in `<base>..HEAD`, or all of HEAD when there is no base commit. */
export function readCommits(baseRef) {
  const range = baseRef ? `${baseRef}..HEAD` : "HEAD"
  const raw = git(["log", "--no-merges", "-z", "--format=%H%x09%s%x09%b", range])
  const commits = []
  for (const record of raw.split("\0")) {
    if (!record.trim()) continue
    const [sha, subject = "", ...body] = record.replace(/^\r?\n/, "").split("\t")
    commits.push({ sha: sha.trim(), subject: subject.trim(), body: body.join("\t").trim() })
  }
  return { range, commits }
}

/** Classify raw commits into the level they imply, what was ignored, what cannot parse. */
export function classify(commits) {
  const considered = []
  const ignored = []
  const rejected = []
  let level = null
  for (const commit of commits) {
    const subject = String(commit.subject ?? "")
    const body = String(commit.body ?? "")
    const match = SUBJECT_RE.exec(subject)
    if (!match) {
      rejected.push({ ...commit, reason: "not a conventional commit subject (`type(scope)!: description`)" })
      continue
    }
    const [, type, scope, bang] = match
    if (!(type in TYPES)) {
      rejected.push({ ...commit, reason: `unknown conventional type "${type}"` })
      continue
    }
    const breaking = Boolean(bang) || /BREAKING[- ]CHANGE/.test(body)
    const commitLevel = TYPES[type] === "ignore" ? "ignore" : breaking ? "major" : TYPES[type]
    const record = { sha: commit.sha, subject, type, scope: scope ?? null, breaking, level: commitLevel }
    if (commitLevel === "ignore") {
      ignored.push(record)
      continue
    }
    considered.push(record)
    if (level === null || LEVEL_RANK[commitLevel] > LEVEL_RANK[level]) level = commitLevel
  }
  return { level, considered, ignored, rejected }
}

/** Apply one level to a base version. A 0.x base bumps the minor, not the major. */
export function bumpVersion(base, level) {
  const match = VERSION_RE.exec(base)
  if (!match) throw new Error(`base version "${base}" is not X.Y.Z`)
  const [major, minor, patch] = match.slice(1).map(Number)
  if (level === "major") return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`
  if (level === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** What a package changelog says about the derived version. */
export function readChangelog(text, version) {
  const lines = String(text ?? "").split(/\r?\n/)
  let unreleasedAt = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\[?Unreleased\]?\s*$/i.test(lines[i])) {
      unreleasedAt = i
      break
    }
  }
  let unreleasedEntries = 0
  if (unreleasedAt >= 0) {
    for (let i = unreleasedAt + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^##\s/.test(line)) break
      if (!line.trim() || /^###/.test(line)) continue
      unreleasedEntries++
    }
  }
  const escaped = typeof version === "string" && version.length > 0 ? version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null
  const versionSection =
    escaped === null ? false : new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`, "m").test(String(text ?? ""))
  return { unreleased: unreleasedAt >= 0, unreleasedEntries, versionSection }
}

/**
 * The whole decision, pure: no filesystem and no git, so `--check` can drive
 * every branch. `changelog` is `{ path, text }` or null when the package has no
 * changelog file.
 */
export function evaluate(input) {
  const { name, dir, manifestVersion, baseVersion, baseSource, baseRef, range, commits, changelog, prepare = false } = input
  const refusals = []
  const notes = []
  const classified = classify(commits)

  if (baseSource === "manifest") {
    notes.push(`no ${name}@X.Y.Z tag exists: base is the manifest version ${baseVersion}`)
  }
  if (classified.rejected.length > 0) {
    refusals.push(
      refusal(
        "NON_CONVENTIONAL",
        `${classified.rejected.length} commit subject(s) cannot be classified: ${classified.rejected
          .map((c) => `"${c.subject}"`)
          .join(", ")}`,
      ),
    )
  }

  let level = classified.level
  let version = null
  if (commits.length === 0) {
    refusals.push(refusal("EMPTY_RANGE", `no commit in ${range}: nothing to release`))
  } else if (classified.rejected.length === 0 && classified.considered.length === 0) {
    refusals.push(
      refusal(
        "NO_RELEASABLE",
        `every commit in ${range} has a non-releasable type (${[...new Set(classified.ignored.map((c) => c.type))].join(", ")}): nothing to release`,
      ),
    )
  } else if (level !== null) {
    version = bumpVersion(baseVersion, level)
  }

  const changelogState = changelog === null ? null : readChangelog(changelog.text, version)
  // With --prepare the lane itself supplies the changelog close and the three
  // version cells in the runner, so a manifest that is behind and a changelog
  // whose [Unreleased] is still empty are facts to report, never blockers.
  const supplied = prepare ? notes : refusals
  if (version !== null) {
    if (!changelog) {
      supplied.push(
        prepare
          ? `no ${dir}/CHANGELOG.md: the release lane has nothing to close`
          : refusal("CHANGELOG_EMPTY", `no ${dir}/CHANGELOG.md: write the changelog entry for ${version} first`),
      )
    } else if (!changelogState.versionSection && changelogState.unreleasedEntries === 0) {
      supplied.push(
        prepare
          ? `${changelog.path} has no entry for ${version}: the release lane closes an empty section`
          : refusal(
              "CHANGELOG_EMPTY",
              `${changelog.path} has no entry under "## [Unreleased]" and no "## [${version}]" section: write the entry before releasing`,
            ),
      )
    }
    if (version !== manifestVersion) {
      supplied.push(
        prepare
          ? `${dir}/package.json carries ${manifestVersion}: the release lane writes ${version} in the runner`
          : refusal(
              "MANIFEST_MISMATCH",
              `derived ${version} != ${dir}/package.json version ${manifestVersion}: set the manifest, the root index cell and the lockfile to ${version}`,
            ),
      )
    }
  }

  return {
    package: name,
    dir,
    manifestVersion,
    base: { version: baseVersion, source: baseSource, ref: baseRef },
    range,
    commits: { total: commits.length, ...classified },
    level,
    version,
    tag: version === null ? null : `${name}@${version}`,
    changelog: changelog === null ? null : { path: changelog.path, ...changelogState },
    notes,
    refusals,
    ok: refusals.length === 0,
  }
}

/** Everything the git-backed path needs, assembled from the working tree. */
export function runDerivation(name, prepare = false) {
  const target = resolvePackage(name)
  const dir = path.relative(ROOT, target.dir).split(path.sep).join("/")
  const tags = readTags()
  const best = highestTag(tags, name)
  const baseVersion = best ? best.version : target.version
  const baseSource = best ? "tag" : "manifest"
  const baseRef = best ? best.tag : null
  const { range, commits } = readCommits(baseRef)
  const changelogPath = path.join(target.dir, "CHANGELOG.md")
  const changelog = fs.existsSync(changelogPath)
    ? { path: `${dir}/CHANGELOG.md`, text: fs.readFileSync(changelogPath, "utf8") }
    : null
  return evaluate({
    name,
    dir,
    manifestVersion: target.version,
    baseVersion,
    baseSource,
    baseRef,
    range,
    commits,
    changelog,
    prepare,
  })
}

function shortSha(sha) {
  return String(sha ?? "").slice(0, 7)
}

export function render(result) {
  const lines = []
  const baseLabel =
    result.base.source === "tag"
      ? `base tag ${result.base.ref}`
      : `base ${result.base.version} from the manifest (no <package>@X.Y.Z tag)`
  lines.push(`derive: package ${result.package} (${result.dir})`)
  lines.push(`derive: manifest version ${result.manifestVersion}`)
  lines.push(`derive: ${baseLabel}`)
  lines.push(`derive: range ${result.range}: ${result.commits.total} commit(s), merge commits excluded by --no-merges`)
  for (const note of result.notes) lines.push(`derive: note ${note}`)
  let index = 0
  for (const commit of result.commits.considered) {
    index++
    lines.push(
      `derive:   considered ${String(index).padStart(2)} ${shortSha(commit.sha)} ${commit.level.padEnd(5)} ${commit.subject}`,
    )
  }
  for (const commit of result.commits.ignored) {
    index++
    lines.push(
      `derive:   ignored    ${String(index).padStart(2)} ${shortSha(commit.sha)} ${commit.type.padEnd(5)} ${commit.subject}`,
    )
  }
  for (const commit of result.commits.rejected) {
    index++
    lines.push(`derive:   rejected   ${String(index).padStart(2)} ${shortSha(commit.sha)} ${commit.subject} (${commit.reason})`)
  }
  if (result.level !== null && result.version !== null) {
    lines.push(`derive: level ${result.level}`)
    lines.push(`derive: derived version ${result.version} (${result.level} from ${result.base.version})`)
    lines.push(`derive: tag ${result.tag}`)
  }
  if (result.changelog !== null) {
    const { unreleasedEntries, versionSection } = result.changelog
    lines.push(
      `derive: changelog ${result.changelog.path}: ${unreleasedEntries} entr${unreleasedEntries === 1 ? "y" : "ies"} under [Unreleased]${
        versionSection ? `, section [${result.version}] already present` : ""
      }`,
    )
  }
  for (const item of result.refusals) lines.push(`derive: REFUSED ${item.code}: ${item.message}`)
  if (result.ok) lines.push("derive: ok")
  return lines.join("\n")
}

function emitOutputs(result) {
  const file = process.env.GITHUB_OUTPUT
  if (!file || !result.ok) return
  fs.appendFileSync(file, `name=${result.package}\nversion=${result.version}\ntag=${result.tag}\nbase=${result.base.version}\nlevel=${result.level}\ndir=${result.dir}\n`)
  // One shape for both dispatch modes: the workflow always fans out over a
  // matrix, and a single package is a matrix of one.
  emitMatrix([result])
}

/** The batch matrix the release workflow fans out over. */
function emitMatrix(results) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  const include = results.map((result) => ({
    name: result.package,
    version: result.version,
    tag: result.tag,
    dir: result.dir,
  }))
  fs.appendFileSync(file, `matrix=${JSON.stringify({ include })}\ncount=${include.length}\n`)
}

/** Split a batch derivation into the packages to release and the ones to skip. */
export function selectAll(results) {
  return {
    release: results.filter((result) => result.version !== null),
    skipped: results.filter((result) => result.version === null),
  }
}

/** Derive every releasable package, in the allowlist order. `--all` is the
 *  push lane's plan, so it prepares (the lane writes the cells and closes the
 *  changelog in the runner). */
export function deriveAll(prepare = true) {
  return selectAll(ALLOWED.map((name) => runDerivation(name, prepare)))
}

export function renderAll({ release, skipped }) {
  const lines = []
  lines.push(
    `all: ${release.length + skipped.length} package(s): ${release.length} with a derived version, ${skipped.length} with none`,
  )
  if (release.length === 0) {
    lines.push("all: nothing to release")
    return lines.join("\n")
  }
  for (const result of release) {
    const codes = result.refusals.map((item) => item.code)
    lines.push(
      `all:   ${result.package} ${result.manifestVersion} -> ${result.version} (${result.level}, base ${result.base.version} from the ${result.base.source}) tag ${result.tag}${
        codes.length > 0 ? ` refused: ${codes.join(", ")}` : ""
      }`,
    )
  }
  for (const result of skipped) {
    const reasons = result.refusals.map((item) => `${item.code}: ${item.message}`).join("; ")
    lines.push(`all:   skipped ${result.package}: ${reasons || "no derivation"}`)
  }
  return lines.join("\n")
}

/** Assert the three cells that carry the version, each read from its own file. */
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Replace one index table row's version cell (the fourth pipe field). The row,
 * its other cells and the file's line endings stay byte-identical; a missing
 * row or an unrecognised cell throws instead of guessing.
 */
export function setIndexCell(text, label, version) {
  if (!VERSION_RE.test(String(version))) throw new Error(`"${version}" is not X.Y.Z`)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.split(/\r?\n/)
  const row = new RegExp(`^\\|\\s*${escapeRe(label)}\\s*\\|`)
  const at = lines.findIndex((line) => row.test(line))
  if (at < 0) throw new Error(`README.md has no row for ${label}`)
  const cells = lines[at].split("|")
  if (cells.length < 5) throw new Error(`README.md ${label} row is not a 5-column table row`)
  if (!/^\s*`[^`]+`\s*$/.test(cells[3])) throw new Error(`README.md ${label} version cell is not a backticked value`)
  cells[3] = ` \`${version}\` `
  lines[at] = cells.join("|")
  return lines.join(eol)
}

/**
 * Write the derived version into the three cells a release has to agree on:
 * the package manifest (the tarball's version), the root index row and the
 * lockfile workspace entry. Idempotent. The release lane runs this in the
 * runner and restores the files afterwards; nothing here is committed.
 */
export function writeCells(name, version) {
  if (!VERSION_RE.test(String(version))) throw new Error(`"${version}" is not X.Y.Z`)
  const target = resolvePackage(name)
  const dir = path.relative(ROOT, target.dir).split(path.sep).join("/")
  const changes = []

  const manifestPath = path.join(target.dir, "package.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  if (manifest.version !== version) {
    manifest.version = version
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
    changes.push(`${dir}/package.json`)
  }

  const readmePath = path.join(ROOT, "README.md")
  const readme = fs.readFileSync(readmePath, "utf8")
  const rewritten = setIndexCell(readme, name.replace(/^@[^/]+\//, ""), version)
  if (rewritten !== readme) {
    fs.writeFileSync(readmePath, rewritten)
    changes.push("README.md")
  }

  const lockPath = path.join(ROOT, "package-lock.json")
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))
  const locked = lock.packages?.[dir]
  if (!locked) throw new Error(`package-lock.json has no packages["${dir}"] entry`)
  if (locked.version !== version) {
    locked.version = version
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n")
    changes.push("package-lock.json")
  }

  return { name, version, dir, changes }
}

export function assertCells(name, version) {
  const target = resolvePackage(name)
  const dir = path.relative(ROOT, target.dir).split(path.sep).join("/")
  const problems = []
  const cells = []

  cells.push({ cell: "manifest", path: `${dir}/package.json`, value: target.version })
  if (target.version !== version) problems.push(`${dir}/package.json version ${target.version} != ${version}`)

  const label = name.replace(/^@[^/]+\//, "")
  const readmePath = path.join(ROOT, "README.md")
  const row = fs
    .readFileSync(readmePath, "utf8")
    .split(/\r?\n/)
    .find((line) => new RegExp(`^\\|\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|`).test(line))
  if (!row) {
    cells.push({ cell: "index", path: "README.md", value: null })
    problems.push(`README.md has no row for ${label}`)
  } else {
    const cell = (row.split("|")[3] ?? "").trim().replace(/^`|`$/g, "")
    cells.push({ cell: "index", path: "README.md", value: cell })
    if (cell !== version) problems.push(`README.md ${label} version cell ${cell} != ${version}`)
  }

  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"))
  const locked = lock.packages?.[dir]?.version ?? null
  cells.push({ cell: "lockfile", path: `package-lock.json packages["${dir}"].version`, value: locked })
  if (locked !== version) problems.push(`package-lock.json packages["${dir}"].version ${locked} != ${version}`)

  return { name, version, cells, problems, ok: problems.length === 0 }
}

// Offline fixtures for every branch: the gate must be able to say no, and it
// must say no for the reason it claims. Each case is pure input plus the verdict.
const FIXTURE_CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- a new thing.\n\n## [1.2.3] - 2026-01-01\n\n### Fixed\n\n- an old thing.\n"
const CLOSED_CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n## [1.3.0] - 2026-11-02\n\n### Added\n\n- a new thing.\n"
const EMPTY_CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n### Fixed\n\n- an old thing.\n"

const FIXTURES = [
  {
    name: "major-bang",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "a1", subject: "feat(api)!: drop the v1 shape" }],
    manifestVersion: "2.0.0",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: true, level: "major", version: "2.0.0" },
  },
  {
    name: "major-body",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "a2", subject: "feat(api): drop the v1 shape", body: "BREAKING CHANGE: v1 callers must move" }],
    manifestVersion: "2.0.0",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: true, level: "major", version: "2.0.0" },
  },
  {
    name: "minor",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [
      { sha: "b1", subject: "feat: add a reader" },
      { sha: "b2", subject: "fix: hold the last byte" },
    ],
    manifestVersion: "1.3.0",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: true, level: "minor", version: "1.3.0", considered: 2 },
  },
  {
    name: "patch",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "c1", subject: "fix(pkg): stop losing the tail" }],
    manifestVersion: "1.2.4",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: true, level: "patch", version: "1.2.4" },
  },
  {
    name: "patch-perf",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "c2", subject: "perf: read in one pass" }],
    manifestVersion: "1.2.4",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: true, level: "patch", version: "1.2.4" },
  },
  {
    name: "zero-major",
    baseVersion: "0.3.1",
    baseSource: "tag",
    commits: [{ sha: "d1", subject: "feat!: change the reply shape" }],
    manifestVersion: "0.4.0",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: true, level: "major", version: "0.4.0" },
  },
  {
    name: "zero-patch",
    baseVersion: "0.3.1",
    baseSource: "tag",
    commits: [{ sha: "d2", subject: "fix: keep the size in force" }],
    manifestVersion: "0.3.2",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: true, level: "patch", version: "0.3.2" },
  },
  {
    name: "first-release",
    baseVersion: "0.1.0",
    baseSource: "manifest",
    commits: [{ sha: "e1", subject: "feat: first shape" }],
    manifestVersion: "0.2.0",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: true, level: "minor", version: "0.2.0", note: "base is the manifest version 0.1.0" },
  },
  {
    name: "ignore-lists",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [
      { sha: "f1", subject: "docs: say what the tool does" },
      { sha: "f2", subject: "feat: add a reader" },
      { sha: "f3", subject: "chore: sync the lockfile" },
    ],
    manifestVersion: "1.3.0",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: true, level: "minor", version: "1.3.0", considered: 1, ignored: 2 },
  },
  {
    name: "accept-changelog-closed",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "g1", subject: "feat: add a reader" }],
    manifestVersion: "1.3.0",
    changelog: CLOSED_CHANGELOG,
    expect: { ok: true, level: "minor", version: "1.3.0", versionSection: true },
  },
  {
    name: "refuse-empty-range",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [],
    manifestVersion: "1.2.3",
    changelog: EMPTY_CHANGELOG,
    expect: { ok: false, codes: ["EMPTY_RANGE"], version: null },
  },
  {
    name: "refuse-only-chore",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [
      { sha: "h1", subject: "docs: say what the tool does" },
      { sha: "h2", subject: "chore: sync the lockfile" },
    ],
    manifestVersion: "1.2.3",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: false, codes: ["NO_RELEASABLE"], version: null },
  },
  {
    name: "refuse-non-conventional",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "i1", subject: "Updated the readme" }],
    manifestVersion: "1.2.3",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: false, codes: ["NON_CONVENTIONAL"], rejected: 1 },
  },
  {
    name: "refuse-unknown-type",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "i2", subject: "feats: add a reader" }],
    manifestVersion: "1.2.3",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: false, codes: ["NON_CONVENTIONAL"], rejected: 1 },
  },
  {
    name: "refuse-manifest-mismatch",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "j1", subject: "feat: add a reader" }],
    manifestVersion: "1.2.4",
    changelog: FIXTURE_CHANGELOG,
    expect: { ok: false, codes: ["MANIFEST_MISMATCH"], version: "1.3.0" },
  },
  {
    name: "refuse-changelog-empty",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "k1", subject: "feat: add a reader" }],
    manifestVersion: "1.3.0",
    changelog: EMPTY_CHANGELOG,
    expect: { ok: false, codes: ["CHANGELOG_EMPTY"], version: "1.3.0" },
  },
  {
    name: "prepare-supplies-the-cells",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "p1", subject: "feat: add a reader" }],
    manifestVersion: "1.2.3",
    changelog: FIXTURE_CHANGELOG,
    prepare: true,
    expect: { ok: true, version: "1.3.0", note: "the release lane writes 1.3.0 in the runner" },
  },
  {
    name: "prepare-closes-an-empty-changelog",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "p2", subject: "fix: hold the tail" }],
    manifestVersion: "1.2.4",
    changelog: EMPTY_CHANGELOG,
    prepare: true,
    expect: { ok: true, version: "1.2.4", note: "closes an empty section" },
  },
  {
    name: "prepare-still-refuses-a-typo-type",
    baseVersion: "1.2.3",
    baseSource: "tag",
    commits: [{ sha: "p3", subject: "feats: add a reader" }],
    manifestVersion: "1.3.0",
    changelog: FIXTURE_CHANGELOG,
    prepare: true,
    expect: { ok: false, codes: ["NON_CONVENTIONAL"] },
  },
]

export function runFixtures() {
  let passed = 0
  let total = 0
  const failures = []
  for (const fixture of FIXTURES) {
    const result = evaluate({
      name: "@fixture/unit",
      dir: "packages/fixture",
      manifestVersion: fixture.manifestVersion,
      baseVersion: fixture.baseVersion,
      baseSource: fixture.baseSource,
      baseRef: fixture.baseSource === "tag" ? `@fixture/unit@${fixture.baseVersion}` : null,
      range: fixture.baseSource === "tag" ? `@fixture/unit@${fixture.baseVersion}..HEAD` : "HEAD",
      commits: fixture.commits,
      changelog: fixture.changelog === null ? null : { path: "packages/fixture/CHANGELOG.md", text: fixture.changelog },
      prepare: fixture.prepare === true,
    })
    const problems = []
    const expect = fixture.expect
    if (result.ok !== expect.ok) problems.push(`ok=${result.ok}, expected ${expect.ok}`)
    if ("level" in expect && result.level !== expect.level) problems.push(`level=${result.level}, expected ${expect.level}`)
    if ("version" in expect && result.version !== expect.version) {
      problems.push(`version=${result.version}, expected ${expect.version}`)
    }
    if ("considered" in expect && result.commits.considered.length !== expect.considered) {
      problems.push(`considered=${result.commits.considered.length}, expected ${expect.considered}`)
    }
    if ("ignored" in expect && result.commits.ignored.length !== expect.ignored) {
      problems.push(`ignored=${result.commits.ignored.length}, expected ${expect.ignored}`)
    }
    if ("rejected" in expect && result.commits.rejected.length !== expect.rejected) {
      problems.push(`rejected=${result.commits.rejected.length}, expected ${expect.rejected}`)
    }
    if ("versionSection" in expect && result.changelog?.versionSection !== expect.versionSection) {
      problems.push(`versionSection=${result.changelog?.versionSection}, expected ${expect.versionSection}`)
    }
    for (const code of expect.codes ?? []) {
      if (!result.refusals.some((item) => item.code === code)) {
        problems.push(`missing refusal ${code} (got ${result.refusals.map((i) => i.code).join(", ") || "none"})`)
      }
    }
    if (expect.note && !result.notes.some((note) => note.includes(expect.note))) {
      problems.push(`missing note "${expect.note}"`)
    }
    if (problems.length > 0) {
      failures.push({ name: fixture.name, problems })
      console.log(`FAIL ${fixture.name}: ${problems.join("; ")}`)
    } else {
      passed++
      const verdict = expect.ok ? `${fixture.baseVersion} -> ${result.version} (${result.level})` : `refused (${expect.codes.join(", ")})`
      console.log(`PASS ${fixture.name}: ${verdict}`)
    }
  }
  // `--all` is what decides which packages a batch run touches, so its split is
  // a decided fact too: a package with no releasable commit is skipped, never
  // attempted, and a package with a derived version is listed even when its own
  // gate would refuse it.
  const allCase = (commits, options = {}) =>
    evaluate({
      name: "@fixture/unit",
      dir: "packages/fixture",
      manifestVersion: "1.2.3",
      baseVersion: "1.2.3",
      baseSource: "tag",
      baseRef: "@fixture/unit@1.2.3",
      range: "@fixture/unit@1.2.3..HEAD",
      commits,
      changelog: { path: "packages/fixture/CHANGELOG.md", text: FIXTURE_CHANGELOG },
      ...options,
    })
  const ALL_CASES = [
    {
      name: "all-lists-derived-only",
      results: [allCase([{ sha: "m1", subject: "feat: add a reader" }]), allCase([{ sha: "m2", subject: "fix: hold the tail" }]), allCase([])],
      expect: { release: 2, skipped: 1 },
    },
    {
      name: "all-skips-everything",
      results: [allCase([{ sha: "n1", subject: "chore: sync the lockfile" }])],
      expect: { release: 0, skipped: 1 },
    },
    {
      name: "all-prepares-the-cells",
      results: [
        allCase([{ sha: "n2", subject: "feat: add a reader" }], {
          manifestVersion: "1.2.3",
          changelog: { path: "packages/fixture/CHANGELOG.md", text: EMPTY_CHANGELOG },
          prepare: true,
        }),
      ],
      expect: { release: 1, skipped: 0, ok: true },
    },
  ]
  for (const fixture of ALL_CASES) {
    total++
    const split = selectAll(fixture.results)
    const problems = []
    if (split.release.length !== fixture.expect.release) {
      problems.push(`release=${split.release.length}, expected ${fixture.expect.release}`)
    }
    if (split.skipped.length !== fixture.expect.skipped) {
      problems.push(`skipped=${split.skipped.length}, expected ${fixture.expect.skipped}`)
    }
    if ("ok" in fixture.expect && split.release[0]?.ok !== fixture.expect.ok) {
      problems.push(`ok=${split.release[0]?.ok}, expected ${fixture.expect.ok}`)
    }
    if (problems.length > 0) {
      failures.push({ name: fixture.name, problems })
      console.log(`FAIL ${fixture.name}: ${problems.join("; ")}`)
    } else {
      passed++
      console.log(`PASS ${fixture.name}: ${split.release.length} to release, ${split.skipped.length} skipped`)
    }
  }
  // The runner-write step and the never-retag guard are pure functions here, so
  // both can fail offline: a wrong row or a similar tag must never pass.
  const README_FIXTURE = "| janua | MCP | `0.3.1` | x |\n| oc-talk | plugin | `0.1.7` | y |\n"
  const CELL_CASES = [
    {
      name: "cell-replaces-one-version",
      label: "janua",
      version: "0.4.0",
      expect: "| janua | MCP | `0.4.0` | x |\n| oc-talk | plugin | `0.1.7` | y |\n",
    },
    { name: "cell-idempotent", label: "janua", version: "0.3.1", expect: README_FIXTURE },
    { name: "cell-refuses-an-unknown-row", label: "nope", version: "1.0.0", throws: true },
    { name: "cell-refuses-a-bad-version", label: "janua", version: "0.4", throws: true },
  ]
  for (const fixture of CELL_CASES) {
    total++
    const problems = []
    let result
    try {
      result = setIndexCell(README_FIXTURE, fixture.label, fixture.version)
    } catch (error) {
      if (!fixture.throws) problems.push(`threw: ${error.message}`)
    }
    if (fixture.throws && result !== undefined) problems.push("did not throw")
    if (!fixture.throws && result !== fixture.expect) problems.push("text differs from the expected index")
    if (problems.length > 0) {
      failures.push({ name: fixture.name, problems })
      console.log(`FAIL ${fixture.name}: ${problems.join("; ")}`)
    } else {
      passed++
      console.log(`PASS ${fixture.name}: ${fixture.throws ? "refused" : "written"}`)
    }
  }
  const TAG_CASES = [
    { name: "tag-exists", tags: ["oc-talk@0.1.7", "v0.2.6"], tag: "oc-talk@0.1.7", expect: true },
    { name: "tag-absent", tags: ["oc-talk@0.1.7"], tag: "oc-talk@0.1.8", expect: false },
    { name: "tag-exact-not-prefix", tags: ["oc-talk@0.1.7"], tag: "oc-talk@0.1", expect: false },
  ]
  for (const fixture of TAG_CASES) {
    total++
    const actual = hasTag(fixture.tags, fixture.tag)
    if (actual !== fixture.expect) {
      failures.push({ name: fixture.name, problems: [`hasTag=${actual}, expected ${fixture.expect}`] })
      console.log(`FAIL ${fixture.name}: hasTag=${actual}, expected ${fixture.expect}`)
    } else {
      passed++
      console.log(`PASS ${fixture.name}: ${actual ? "exists (skip)" : "absent (release)"}`)
    }
  }
  total += FIXTURES.length
  console.log(`derive-release: fixtures ${total} passed ${passed} failed ${failures.length}`)
  return failures.length === 0
}

function usage() {
  return [
    "usage: derive-release.mjs --package <name> [--prepare] [--dry-run] [--json]",
    "       derive-release.mjs --all [--json]",
    "       derive-release.mjs --package <name> --version <v> --write-cells",
    "       derive-release.mjs --package <name> --version <v> --assert-cells",
    "       derive-release.mjs --tag-exists <tag>",
    "       derive-release.mjs --check",
  ].join("\n")
}

/** Argument parsing kept separate so `--check` stays dependency-free. */
function parseArgs(argv) {
  const options = {
    mode: "derive",
    packageName: null,
    version: null,
    tag: null,
    dryRun: false,
    json: false,
    all: false,
    prepare: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--check") options.mode = "check"
    else if (arg === "--assert-cells") options.mode = "assert-cells"
    else if (arg === "--write-cells") options.mode = "write-cells"
    else if (arg === "--all") options.all = true
    else if (arg === "--prepare") options.prepare = true
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--json") options.json = true
    else if (arg === "--package" && argv[i + 1]) options.packageName = argv[++i]
    else if (arg === "--version" && argv[i + 1]) options.version = argv[++i]
    else if (arg === "--tag-exists" && argv[i + 1]) {
      options.mode = "tag-exists"
      options.tag = argv[++i]
    } else throw new Error(`unknown argument "${arg}"\n${usage()}`)
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`derive-release: ${error.message}`)
    process.exitCode = 2
    return
  }

  try {
    if (options.mode === "check") {
      if (!runFixtures()) process.exitCode = 1
      return
    }

    if (options.mode === "tag-exists") {
      if (!options.tag) {
        console.error(`derive-release: --tag-exists needs a tag\n${usage()}`)
        process.exitCode = 2
        return
      }
      const exists = hasTag(readTags(), options.tag)
      console.log(`tag: ${options.tag} ${exists ? "exists" : "absent"}`)
      if (!exists) process.exitCode = 1
      return
    }

    if (options.mode === "write-cells") {
      if (!options.packageName || !options.version) {
        console.error(`derive-release: --write-cells needs --package and --version\n${usage()}`)
        process.exitCode = 2
        return
      }
      const written = writeCells(options.packageName, options.version)
      for (const where of written.changes) console.log(`cells: wrote ${written.version} to ${where}`)
      if (written.changes.length === 0) console.log(`cells: ${written.name} already carries ${written.version}`)
      console.log(`cells: ${written.name} ${written.version} in the runner only; nothing was committed`)
      return
    }

    if (options.mode === "assert-cells") {
      if (!options.packageName || !options.version) {
        console.error(`derive-release: --assert-cells needs --package and --version\n${usage()}`)
        process.exitCode = 2
        return
      }
      const check = assertCells(options.packageName, options.version)
      for (const { cell, path: where, value } of check.cells) {
        console.log(`cells: ${cell.padEnd(8)} ${String(value).padEnd(10)} ${where}`)
      }
      for (const problem of check.problems) console.log(`cells: FAIL ${problem}`)
      if (!check.ok) {
        process.exitCode = 1
        return
      }
      console.log(`cells: ${check.name} carries ${check.version} in the manifest, the index and the lockfile`)
      return
    }

    if (options.all) {
      // Batch plan, not a gate: a package that refuses is reported here and
      // skipped by the run, never allowed to stop the packages beside it.
      const split = deriveAll()
      if (options.json) {
        console.log(JSON.stringify({ packages: split.release, skipped: split.skipped }, null, 2))
      } else {
        console.log(renderAll(split))
      }
      if (options.dryRun) console.log("all: dry run: nothing was written and nothing was tagged")
      else emitMatrix(split.release)
      return
    }

    if (!options.packageName) {
      console.error(`derive-release: --package <name> or --all is required\n${usage()}`)
      process.exitCode = 2
      return
    }
    const result = runDerivation(options.packageName, options.prepare)
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else console.log(render(result))

    if (!result.ok) {
      if (options.dryRun) {
        console.log("derive: dry run: no refusal is enforced here; the release gate runs without --dry-run")
      } else {
        process.exitCode = 1
      }
      return
    }
    if (options.dryRun) {
      console.log("derive: dry run: nothing was written; the release gate runs without --dry-run")
      return
    }
    emitOutputs(result)
  } catch (error) {
    console.error(`derive-release: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
