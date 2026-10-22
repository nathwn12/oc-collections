#!/usr/bin/env node
// check-docs.mjs - mechanical truth check for maintainer docs.
//
// Scope: the docs this repo owns and can edit. The byte-identical imports
// (crates/, the two MCP launchers) and the archived oc-todo tree are audited
// separately and excluded here; --all includes them for a one-off report.
//
// A backticked token is treated as a path claim when it looks like a path:
// it is not absolute, not a URL/anchor, contains no glob or placeholder
// characters, and contains either a slash or a known file extension. The
// token passes if it resolves relative to the document's directory or to the
// repo root. Backticked tokens inside fenced code blocks are examples, not
// prose claims, and are skipped.
//
// Usage:
//   node scripts/check-docs.mjs            # in-scope docs
//   node scripts/check-docs.mjs --all      # include report-only imports
//   node scripts/check-docs.mjs --file X   # one file (used by the self-test)
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const NAMES = new Set(["AGENTS.md", "CONTRIBUTING.md", "INSTALL.md", "PUBLISHING.md", "README.md", "SKILL.md"]);
const IN_SCOPE = ["README.md", "AGENTS.md", "packages/oc-bifrost", "packages/oc-flight-deck", "packages/oc-harness-setup", "packages/oc-unified", "packages/rea-shim"];
const REPORT_ONLY = ["archive", "crates", "packages/gladius-mcp", "packages/puppet-mcp"];
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
const all = args.includes("--all");
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file" && args[i + 1]) { files.push(path.resolve(args[i + 1])); i++; }
}

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
  : [...IN_SCOPE, ...(all ? REPORT_ONLY : [])].flatMap((p) => walk(path.join(ROOT, p)));

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

let checked = 0;
let failed = 0;
const seen = new Set();
for (const file of targets) {
  if (seen.has(file)) continue;
  seen.add(file);
  const rel = path.relative(ROOT, file).split(path.sep).join("/") || path.basename(file);
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
    failed++;
    console.log(`FAIL ${rel}:${line}: ${token}`);
  }
}

console.log(`docs: files=${seen.size} path-claims=${checked} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
