#!/usr/bin/env node
// check-docs.mjs - mechanical truth check for maintainer docs.
//
// Scope: the docs this repo owns and can edit: the root index documents and
// the four workspace package trees. Imports are audited by their own repos.
//
// A backticked token is treated as a path claim when it looks like a path:
// it is not absolute, not a URL/anchor, contains no glob or placeholder
// characters, and contains either a slash or a known file extension. The
// token passes if it resolves relative to the document's directory or to the
// repo root. Backticked tokens inside fenced code blocks are examples, not
// prose claims, and are skipped.
//
// Four package READMEs are also npm's front door: npm renders
// packages/<pkg>/README.md and GitHub shows that same file, so those four must
// stay slim and self-contained. They fail on a version literal beside their own
// package name (the stale pin that shipped twice) and on a relative link or
// <img src> (npm has no repo tree to resolve one against). The full document
// lives beside them in docs/GUIDE.md. Prerequisites such as a Node floor are
// not pins and do not trip the version rule.
//
// Usage:
//   node scripts/check-docs.mjs            # in-scope docs
//   node scripts/check-docs.mjs --file X   # one file (used by the self-test)
//   node scripts/check-docs.mjs --file X --pkg NAME  # front-door rule as NAME
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const NAMES = new Set(["AGENTS.md", "CONTRIBUTING.md", "INSTALL.md", "PUBLISHING.md", "README.md", "SKILL.md"]);
const IN_SCOPE = ["README.md", "AGENTS.md", "packages/oc-bifrost", "packages/oc-flight-deck", "packages/oc-harness-setup", "packages/rea-shim"];
// Bare filenames are only claims when they name a maintainer document or a
// manifest. Config examples such as `opencode.jsonc` are not repo paths.
const BARE_CLAIMS = new Set([
  "README.md", "AGENTS.md", "CONTRIBUTING.md", "INSTALL.md", "PUBLISHING.md",
  "SKILL.md", "CHANGELOG.md", "MIGRATIONS.md", "LICENSE", "package.json",
  "package-lock.json", "Cargo.toml", "Cargo.lock",
]);

// Slash-bearing tokens that are not repo paths: host config/cache/state
// locations, GitHub owner/repo slugs, and upstream project paths.
const NON_REPO_PREFIXES = [
  ".opencode/", "./legacy/", "legacy/", "plugin/", "plugins/", "state/",
  "oc-bifrost/github", "nathwn12/", "rtk-ai/", "hooks/opencode/",
];

// Genuinely illustrative tokens, each with a reason. Keep this list small:
// if it grows, the docs are describing things that do not exist.
const SKIPS = [
  { file: "AGENTS.md", token: "docs/repo-guide", reason: "example branch name, not a path" },
  { file: "packages/oc-harness-setup/CONTRIBUTING.md", token: "docs/repo-guide-shape", reason: "example branch name, not a path" },
];

const args = process.argv.slice(2);
const files = [];
let forcedPkg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file" && args[i + 1]) { files.push(path.resolve(args[i + 1])); i++; }
  if (args[i] === "--pkg" && args[i + 1]) { forcedPkg = args[i + 1]; i++; }
}

// The four npm front doors, keyed by package directory, valued by the exact
// name npm and the README use for that package.
const FRONT_DOOR = new Map([
  ["packages/oc-bifrost", "@nathwn12/oc-bifrost"],
  ["packages/oc-flight-deck", "oc-flight-deck"],
  ["packages/oc-harness-setup", "oc-harness-setup"],
  ["packages/rea-shim", "rea-shim"],
]);
// Absolute targets: a scheme (https:, mailto:, ...), a root path, or an anchor.
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

function walk(target, out = []) {
  if (!fs.existsSync(target)) return out;
  const st = fs.statSync(target);
  if (st.isFile()) {
    if (NAMES.has(path.basename(target))) out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    walk(path.join(target, entry.name), out);
  }
  return out;
}

const targets = files.length > 0
  ? files
  : IN_SCOPE.flatMap((p) => walk(path.join(ROOT, p)));

function tokensIn(file) {
  const found = [];
  let fenced = false;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```+|~~~+)/.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced) continue;
    const re = /`([^`\n]+)`/g;
    let m;
    while ((m = re.exec(lines[i]))) found.push({ token: m[1].trim(), line: i + 1 });
  }
  return found;
}

function isPathClaim(token) {
  if (!token || /\s/.test(token)) return false;
  if (/^(https?:|mailto:|tel:|data:|www\.|github\.com\/)/i.test(token)) return false;
  if (/^(?:\/|~|[A-Za-z]:[\\/]|\\\\)/.test(token)) return false;
  if (/[*?<>{}]/.test(token)) return false;
  if (token.startsWith("$") || token.startsWith("@") || token.startsWith("-")) return false;
  if (token.includes("=") || token.includes("|") || token.includes(":")) return false;
  if (/^\.\w+$/.test(token)) return false;
  if (NON_REPO_PREFIXES.some((p) => token.startsWith(p))) return false;
  if (!token.includes("/") && !BARE_CLAIMS.has(token)) return false;
  return true;
}

function nearestPackageRoot(file) {
  let dir = path.dirname(file);
  while (dir.startsWith(ROOT) && dir !== ROOT) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return ROOT;
}

function skipped(file, token) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  return SKIPS.some((s) => s.file === rel && s.token === token);
}

// Missing + git-ignored is build output, not a broken link; this is a git rule, not a filename allowlist.
function isGitIgnored(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const normalized = rel.split(path.sep).join("/");
  // Try both forms: a missing directory matches `dist/`, a missing file
  // matches `dist/file`; git needs the directory form for the former.
  for (const candidate of [normalized, `${normalized}/`]) {
    const result = spawnSync("git", ["check-ignore", "-q", "--", candidate], { cwd: ROOT, stdio: "ignore" });
    if (result.status === 0) return true;
  }
  return false;
}

// The front-door identity of a file: one of the four package READMEs (or a
// fixture told which package it stands for). Null for everything else.
function frontDoorName(file, forced) {
  if (forced) return forced;
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const parts = rel.split("/");
  if (parts.length !== 3 || parts[2] !== "README.md") return null;
  return FRONT_DOOR.get(`${parts[0]}/${parts[1]}`) ?? null;
}

// A version literal beside the package's own name breaks npm consumers two
// ways: it ships a pin that goes stale on the next release, and it reads as the
// current version after the manifest has moved. Prerequisites (`Node 22.14.0`,
// `OpenCode 2.1.1`) name no package and pass.
function frontDoorProblems(text, name) {
  const problems = [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versionRe = new RegExp(`${escaped}["'\`\\s:@]+\\d+\\.\\d+\\.\\d+`, "i");
  let fenced = false;
  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo++;
    if (/^\s*(```+|~~~+)/.test(line)) { fenced = !fenced; continue; }
    const pin = versionRe.exec(line);
    if (pin) problems.push({ line: lineNo, what: `version literal beside the package name: ${pin[0]}` });
    if (fenced) continue;
    for (const m of line.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) {
      if (!ABSOLUTE.test(m[1])) problems.push({ line: lineNo, what: `relative markdown link: ${m[1]}` });
    }
    for (const m of line.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      if (!ABSOLUTE.test(m[1])) problems.push({ line: lineNo, what: `relative image source: ${m[1]}` });
    }
  }
  return problems;
}

let checked = 0;
let failed = 0;
let frontDoors = 0;
const seen = new Set();
for (const file of targets) {
  if (seen.has(file)) continue;
  seen.add(file);
  const rel = path.relative(ROOT, file).split(path.sep).join("/") || path.basename(file);
  const door = frontDoorName(file, forcedPkg);
  if (door) {
    frontDoors++;
    for (const { line, what } of frontDoorProblems(fs.readFileSync(file, "utf8"), door)) {
      failed++;
      console.log(`FAIL ${rel}:${line}: ${what}`);
    }
  }
  for (const { token, line } of tokensIn(file)) {
    const clean = token.split("#")[0].split("?")[0].replace(/^["']|["']$/g, "");
    if (!isPathClaim(clean)) continue;
    if (skipped(file, token)) continue;
    checked++;
    const candidates = [
      path.resolve(path.dirname(file), clean),
      path.resolve(ROOT, clean),
      path.resolve(nearestPackageRoot(file), clean),
    ];
    if (candidates.some((p) => fs.existsSync(p))) continue;
    if (candidates.some(isGitIgnored)) continue;
    failed++;
    console.log(`FAIL ${rel}:${line}: ${token}`);
  }
}

console.log(`docs: files=${seen.size} path-claims=${checked} front-doors=${frontDoors} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
