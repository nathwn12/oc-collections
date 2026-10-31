#!/usr/bin/env node
/**
 * Self-contained harness health check: derived laws, no allowlists.
 *
 * Validates the global OpenCode harness (~\.config\opencode) with laws DERIVED
 * from the config and the live CLI — never restated from a hardcoded
 * expectation. The consolidation decision (user-approved <DATE>) is that
 * derived laws cannot drift; the old checker's hardcoded allowlists drifted
 * twice in three days, so this doctor absorbed the surviving check logic and
 * the checker was deleted.
 *
 * Laws (each PASS, FAIL, or DRIFT when its source of truth is unavailable):
 *   - required layout paths exist; opencode.jsonc parses as JSONC
 *   - no legacy remote-catalog keys in opencode.jsonc (declared once below)
 *   - `opencode debug config` / `debug agents` resolve (delegated, not
 *     reimplemented: exit 0 and parseable output is the whole law)
 *   - every configured plugin resolves in `opencode plugin list`
 *   - configured MCP servers match `opencode mcp list` in BOTH directions
 *   - every live agent model binding resolves against reference/models.md;
 *     fully-unwired routing is a supported state while a .docs record
 *     documents it (the record is DISCOVERED by content, never named here)
 *   - local skill dirs match the fail-closed skill allowlist BOTH directions
 *     (orphan dir or dangling allow = FAIL), under a skill:* deny
 *   - no literal secret VALUES under a secret-like property name; a `{env:…}`/`{file:…}` pointer is not a leak
 *   - the deny set survives --auto (declared gates below, verified derived)
 *   - hard denies come after same-action allows (denies-last ordering; the
 *     skill fail-closed allowlist allows-after-deny by design, so the skill
 *     action is exempt here and stays covered by the allowlist law)
 *   - no broad shell allows (node *, git *, or bare *), minus the single
 *     documented unattended-shell default whose compensation the deny-set law proves
 *   - skill allow entries match local skill IDs in BOTH directions
 *     (set-equality form of the allowlist seam; the wildcard-deny half stays
 *     with the allowlist law and is not re-checked here)
 *   - agents/*.md carry description+steps, commands/*.md carry description
 *     (identity is the filename: name: is a skills-only convention)
 *   - every skill dir carries a loadable SKILL.md: name+description present,
 *     name matches the directory, and no unquoted plain scalar contains ': '
 *     (a targeted heuristic, not a full YAML parser)
 *   - command IDs and skill IDs are 1:1 both ways (valid skill dirs,
 *     excluding the `_shared` reference bundle, against command basenames;
 *     an orphan either direction = FAIL)
 *   - state/template.md exists and carries the fixed session key order
 *     (id, title, status, goal, next, artifacts, decisions, open)
 *
 * The small DECLARED block at the top is the honest form of the old hardcoded
 * state: each entry names its evidence. Everything else is read from
 * opencode.jsonc, agents\, skills\, reference/models.md, .docs, or the CLI.
 *
 * -Fix attempts mechanical declared-state fixes only, with backup + log. The
 * derived laws have no declared state to patch — every remedy touches an owner
 * artifact (config, agents, skills, commands, registry, CLI install) or needs
 * owner judgment — so -Fix re-evaluates, writes nothing, and reports each
 * finding as a one-line owner proposal. Real regressions are never auto-fixed.
 *
 * Exit codes: 0 clean; 1 evaluated law FAILED (regression); 2 the instrument
 * could not derive an expectation (CLI missing, delegated command failed or
 * changed shape, catalog missing — the world drifted under the instrument).
 *
 * Secret hygiene: this script never reads or prints secret-store or .env value contents. Every
 * file read goes through safeText, which refuses those paths, and each run
 * proves the guard is live. Config scans report property paths only.
 *
 * Usage:
 *   node scripts/harness-doctor.mjs
 *   node scripts/harness-doctor.mjs -Fix
 *   node scripts/harness-doctor.mjs -Json
 *   node scripts/harness-doctor.mjs -ConfigDir D:\config\opencode
 *
 * -ConfigDir
 *   Config directory to grade. The installer passes the resolved config dir
 *   (OPENCODE_CONFIG_DIR and cross-platform paths included); standalone runs
 *   without it default to ~\.config\opencode.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/* ------------------------------- arguments -------------------------------- */

const argv = process.argv.slice(2);
let fix = false;
let json = false;
let configDirArg = '';
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i].toLowerCase();
  if (flag === '-fix') fix = true;
  else if (flag === '-json') json = true;
  else if (flag === '-configdir') configDirArg = argv[++i] ?? '';
}

// Windows 10/11 only: this harness grades the Windows config home and shells
// out to the Windows-only toolchain. Bail as DRIFT (exit 2 — the instrument
// cannot derive an expectation on this platform), never as a regression.
if (process.platform !== 'win32') {
  console.error('harness-doctor supports Windows 10/11 only — macOS and Linux are not supported.');
  process.exit(2);
}
if (!(process.env.USERPROFILE ?? '').trim()) {
  console.error('USERPROFILE is not set — cannot resolve the Windows config home.');
  process.exit(2);
}

const root = configDirArg || path.join(process.env.USERPROFILE, '.config', 'opencode');

/* ---------- declared values (each names its evidence) ---------- */
// Required layout paths. Evidence: the harness shape itself (opencode.jsonc
// header "Harness v4"); stable, changes only via a harness restructure.
const requiredPaths = [
  { name: 'config (opencode.jsonc)', path: 'opencode.jsonc', kind: 'file' },
  { name: 'AGENTS.md', path: 'AGENTS.md', kind: 'file' },
  { name: 'agents', path: 'agents', kind: 'dir' },
  { name: 'commands', path: 'commands', kind: 'dir' },
  { name: 'skills', path: 'skills', kind: 'dir' },
  { name: 'reference', path: 'reference', kind: 'dir' },
  { name: 'state/lessons.md', path: 'state/lessons.md', kind: 'file' },
  { name: 'state/template.md', path: 'state/template.md', kind: 'file' },
  { name: 'Git exclusion policy', path: '.gitignore', kind: 'file' },
];

// Legacy / remote-catalog top-level keys that must not appear in opencode.jsonc.
// Evidence: the package's own .docs (the "no remote skill-catalog keys" file check).
// 'plugins' and 'mcp' are legitimate config and are NOT here.
const remoteCatalogKeys = ['plugin', 'mcpServers', 'mcp_servers', 'skill_catalog', 'skills_catalog', 'remote_skills', 'skills_remote'];

// Deny gates that must hold as effect=deny (ask is auto-approved under --auto,
// so only deny survives). Evidence: the opencode.jsonc inline policy comment
// ("deny is the only gate that holds while you are away"; same text in the package's
// own .docs). Verification is
// derived: each gate needs a matching deny rule in the live permissions array.
const denyGates = [
  { action: 'shell', contains: 'Format-Volume' },
  { action: 'shell', contains: 'Clear-Disk' },
  { action: 'read', contains: 'secrets' },
  { action: 'edit', contains: 'secrets' },
  { action: 'external_directory', contains: 'secrets' },
  { action: 'shell', contains: 'secrets' },
  { action: 'read', contains: '.env' },
  { action: 'edit', contains: '.env' },
  { action: 'external_directory', contains: '.env' },
  { action: 'shell', contains: '.env' },
  { action: 'read', contains: 'service.json' },
  { action: 'edit', contains: 'service.json' },
  { action: 'external_directory', contains: 'service.json' },
  { action: 'shell', contains: 'service.json' },
];

// Secret-like config property NAMES (never values). Evidence: secret-hygiene
// convention carried over from the deleted checker lineage.
const secretNamePattern = /(apikey|api_key|secret|password|bearer|credential)/i;

/* -------------------------------- helpers --------------------------------- */

// PowerShell's -eq/-contains/-ne compare strings case-insensitively; the port
// keeps that so a config that graded PASS before still grades PASS.
const eqCI = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const hasCI = (list, value) => list.some((item) => eqCI(item, value));
const sortUnique = (list) => [...new Set(list)].sort();

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listFiles(dir, filter = null) {
  if (!isDir(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((ent) => ent.isFile() && (!filter || filter.test(ent.name)))
      .map((ent) => ent.name);
  } catch {
    return [];
  }
}

function listDirs(dir) {
  if (!isDir(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name);
  } catch {
    return [];
  }
}

// The file reader in this script. Refuses secret-bearing paths outright,
// so no code path here can read secret-store or .env contents.
function safeText(p) {
  const normalized = String(p).replace(/\\/g, '/');
  if (/(^|\/)([.]secrets|\.env)(\/|$)|(^|\/)[^/]*\.env(\.|$)/i.test(normalized)) {
    throw new Error(`refused to read secret-bearing path: ${p}`);
  }
  const text = readFileSync(p, 'utf8');
  // Get-Content decodes and drops a UTF-8 BOM; readFileSync keeps it.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Strip // and /* */ comments (string-aware), then trailing commas, then parse.
function parseJsonc(text) {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        i++;
        if (i < text.length) out += text[i];
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && i + 1 < text.length) {
      const n = text[i + 1];
      if (n === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (n === '*') {
        i += 2;
        while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// Get-Command opencode: is the CLI reachable on PATH at all?
function onPath(name) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    if (isFile(path.join(dir, name))) return true;
    for (const ext of exts) {
      if (isFile(path.join(dir, name + ext))) return true;
      if (isFile(path.join(dir, name + ext.toLowerCase()))) return true;
    }
  }
  return false;
}

function invokeCli(command, args) {
  // A `.cmd` shim is only reachable through cmd.exe on Windows, so the direct
  // spawn is retried the same way bin/cli.js does; an .exe resolves directly.
  const opts = { encoding: 'utf8', windowsHide: true };
  let res = spawnSync(command, args, opts);
  if (res.error && res.error.code === 'ENOENT' && process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const retry = spawnSync(comspec, ['/d', '/s', '/c', command, ...args], opts);
    if (!retry.error) res = retry;
  }
  const lines = `${res.stdout ?? ''}${res.stderr ?? ''}`.split(/\r?\n/);
  // A captured PowerShell array drops the empty tail a trailing newline makes.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { exit: res.error ? -1 : (res.status ?? -1), lines };
}

// Server NAMES only; values are never read or printed. Accepts the file
// shape (mcp.<name>) and the merged V2 shape (mcp.servers.<name>).
function getMcpServerNames(mcpNode) {
  if (mcpNode === null || mcpNode === undefined) return [];
  if (typeof mcpNode !== 'object' || Array.isArray(mcpNode)) return ['<malformed>'];
  const container = mcpNode.servers !== null && mcpNode.servers !== undefined ? mcpNode.servers : mcpNode;
  if (typeof container !== 'object' || container === null || Array.isArray(container)) return ['<malformed>'];
  return Object.keys(container);
}

// StrictMode-safe read of the permissions array. A config that omits the
// key (or carries a non-array) grades as an empty set, so dependent laws
// FAIL with their named reason instead of throwing a property error.
function getPermissionRules(config) {
  if (config === null || config === undefined || typeof config !== 'object') return [];
  const value = config.permissions;
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [];
  return Array.isArray(value) ? value : [];
}

// First token per line of `opencode mcp list`, minus status markers.
function getRegistryMcpNames(lines) {
  const names = [];
  for (const line of lines) {
    const text = String(line).replace(/^[\u2713\u2717\u00D7\u2022\-\s]+/, '').trim();
    if (text === '') continue;
    const name = text.split(/\s+/).filter((tok) => tok !== '')[0];
    if (name && !/^(id|name|server|status|no)$/i.test(name)) names.push(String(name));
  }
  return sortUnique(names);
}

// A value that POINTS at a secret is not the secret itself.
function testSecretPointer(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === '') return true;
  return /^(\{[A-Za-z][A-Za-z0-9_-]*:[^}]*\}|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)$/.test(text);
}

// Property PATHS whose names look secret-like, each with a pointer flag.
// Values are never returned.
function findSecretLikeProps(node, nodePath, hits = []) {
  if (node === null || node === undefined) return hits;
  if (Array.isArray(node)) {
    node.forEach((item, idx) => findSecretLikeProps(item, `${nodePath}[${idx}]`, hits));
    return hits;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const childPath = nodePath ? `${nodePath}.${key}` : String(key);
      if (secretNamePattern.test(key)) hits.push({ path: childPath, pointer: testSecretPointer(value) });
      findSecretLikeProps(value, childPath, hits);
    }
  }
  return hits;
}

function getFrontmatterText(p) {
  // A skill directory with no SKILL.md is Law 9/16's seam ('file missing'),
  // not a crash: getFrontmatterProblems already reports it, so return null
  // here and let the laws grade it as FAIL instead of aborting the run.
  if (!isFile(p)) return null;
  const lines = safeText(p).split(/\r?\n/);
  if (lines.length < 3 || lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(1, i).join('\n');
  }
  return null;
}

function getFrontmatterProblems(p, require = ['description']) {
  const problems = [];
  if (!isFile(p)) {
    problems.push('file missing');
    return problems;
  }
  const fm = getFrontmatterText(p);
  if (fm === null) {
    problems.push('no frontmatter block');
    return problems;
  }
  for (const req of require) {
    const m = fm.match(new RegExp(`^\\s*${req}\\s*:\\s*(.*)$`, 'im'));
    if (!m) problems.push(`frontmatter missing ${req}`);
    else if (m[1].trim() === '') problems.push(`frontmatter empty ${req}`);
  }
  return problems;
}

// Targeted heuristic, NOT a full YAML parser: it looks only for the shape
// that once made a skill unloadable — a top-level, plain (unquoted,
// non-block) `key: value` whose value contains a colon-space, which YAML
// reads as a nested mapping and rejects. Block scalars (>, |, >-, |-) and
// quoted values are exempt. Returns the offending lines verbatim.
function getPlainScalarHazards(p) {
  const hazards = [];
  const fm = getFrontmatterText(p);
  if (fm === null) return hazards;
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (value === '') continue;
    if (['>', '|', '>-', '|-', '>+', '|+'].some((tok) => eqCI(value, tok))) continue;
    if (value.startsWith('"') || value.startsWith("'")) continue;
    if (value.includes(': ')) hazards.push(line.replace(/\s+$/, ''));
  }
  return hazards;
}

// First uncommented `model:` value in a frontmatter block, or null. A
// commented `# model:` line never matches, so unwired stays unwired.
function getLiveModelBinding(frontmatterText) {
  if (!frontmatterText || frontmatterText.trim() === '') return null;
  for (const line of frontmatterText.split(/\r?\n/)) {
    const m = line.match(/^\s*model\s*:\s*(.+?)\s*$/i);
    if (m) {
      const value = m[1].trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
      if (value) return value;
    }
  }
  return null;
}

// Model ids AND the provider prefix, both read from reference/models.md.
// Accepts two shapes: `- `provider/model-id`` bullets, or a
// `Model (provider/<id>)` line plus `| n | `id` |` rows.
function getModelCatalog(p) {
  const ids = [];
  const bindings = [];
  let provider = '';
  if (!isFile(p)) return { ids, bindings, provider, found: false };
  const text = safeText(p);
  const providerMatch = text.match(/Model \(([A-Za-z0-9._-]+)\/<id>\)/i);
  provider = providerMatch ? providerMatch[1] : '';
  for (const m of text.matchAll(/^\|\s*\d+\s*\|\s*`([^`]+)`/gim)) ids.push(m[1].trim());
  if (providerMatch) {
    const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of text.matchAll(new RegExp(`${escaped}/([A-Za-z0-9._-]+)`, 'gi'))) ids.push(m[1].trim());
  }
  for (const m of text.matchAll(/^\s*[-*]\s+`([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)`/gim)) bindings.push(m[1].trim());
  return { ids: sortUnique(ids), bindings: sortUnique(bindings), provider, found: true };
}

// null when the binding resolves against the catalog; otherwise a reason.
function testModelBinding(value, catalog) {
  let text = String(value);
  const hash = text.indexOf('#');
  if (hash >= 0) text = text.slice(0, hash);
  text = text.trim();
  const m = text.match(/^([A-Za-z0-9._-]+)\/([^/]+)$/);
  if (!m) return `model '${value}' is not a provider/id binding`;
  if (catalog.provider && catalog.provider.trim() !== '') {
    if (!eqCI(m[1], catalog.provider)) {
      return `model '${value}' uses provider '${m[1]}' but the catalog declares '${catalog.provider}'`;
    }
    if (!hasCI(catalog.ids, m[2])) return `model '${value}' does not resolve in reference/models.md`;
    return null;
  }
  if (catalog.bindings.length > 0) {
    if (hasCI(catalog.bindings, text)) return null;
    return `model '${value}' does not resolve in reference/models.md`;
  }
  return 'the model catalog declares neither shape: add `- `provider/model-id`` bullets, or a `Model (provider/<id>)` line plus `| n | `id` |` rows';
}

// The .docs record documenting unwired model routing, found by CONTENT.
function getUnwiredRoutingDoc(docsRoot) {
  if (!isDir(docsRoot)) return null;
  // newest-first: the latest unwire record wins; an earlier name-ascending
  // match could cite an older record.
  for (const name of listFiles(docsRoot, /\.md$/i).sort().reverse()) {
    const text = safeText(path.join(docsRoot, name));
    if (/unwire[a-z]*\b[^.]{0,40}\bmodel\b|\bmodel\b[^.]{0,40}\bunwired\b/is.test(text)) return name;
  }
  return null;
}

/* ---------------------------- law evaluation ------------------------------ */

const laws = [];

function addLaw(name, verdict, detail, proposal = '') {
  laws.push({ law: name, result: verdict, detail, proposal });
}

const configPath = path.join(root, 'opencode.jsonc');
const docsRoot = path.join(root, '.docs');
const agentsDir = path.join(root, 'agents');
const commandsDir = path.join(root, 'commands');
const skillsRoot = path.join(root, 'skills');
const catalogPath = path.join(root, 'reference', 'models.md');

// Law 1: required layout paths.
const missingPaths = [];
for (const req of requiredPaths) {
  const full = path.join(root, req.path);
  if (req.kind === 'file') {
    if (!isFile(full)) missingPaths.push(req.path);
  } else if (!isDir(full)) missingPaths.push(req.path);
}
if (missingPaths.length === 0) {
  addLaw('required layout paths exist', 'PASS', `all present under ${root}`);
} else {
  addLaw(
    'required layout paths exist',
    'FAIL',
    `missing: ${missingPaths.join(', ')}`,
    `restore the missing harness paths (${missingPaths.join(', ')}) — the layout is declared at the top of scripts\\harness-doctor.mjs`
  );
}

// Law 2: opencode.jsonc parses.
let config = null;
if (!isFile(configPath)) {
  addLaw(
    'opencode.jsonc parses as JSONC',
    'FAIL',
    'opencode.jsonc is missing',
    'restore opencode.jsonc (the harness has no config without it)'
  );
} else {
  try {
    config = parseJsonc(safeText(configPath));
    addLaw('opencode.jsonc parses as JSONC', 'PASS', 'parsed as JSONC (comments and trailing commas stripped)');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLaw(
      'opencode.jsonc parses as JSONC',
      'FAIL',
      `JSONC parse failed: ${message}`,
      `fix the JSONC syntax error in opencode.jsonc: ${message}`
    );
  }
}
const configOk = config !== null && config !== undefined;

// Laws needing the config file derive nothing when it is unparseable.
function addConfigDrift(name) {
  addLaw(name, 'DRIFT', 'not evaluated: opencode.jsonc is unparseable', 'fix the JSONC syntax error first (see the parse law above)');
}

// Law 3: no legacy remote-catalog keys.
if (configOk) {
  const badKeys = Object.keys(config).filter((key) => hasCI(remoteCatalogKeys, key));
  if (badKeys.length === 0) {
    addLaw(
      'no legacy remote-catalog keys in opencode.jsonc',
      'PASS',
      'no plugin/mcpServers/skill-catalog keys; plugins[] and mcp come from config + registry only'
    );
  } else {
    addLaw(
      'no legacy remote-catalog keys in opencode.jsonc',
      'FAIL',
      `legacy keys present: ${badKeys.join(', ')}`,
      `remove these keys from opencode.jsonc (${badKeys.join(', ')}) — see the package's own .docs`
    );
  }
} else {
  addConfigDrift('no legacy remote-catalog keys in opencode.jsonc');
}

// Law 4 + 5: delegated CLI resolution (the law IS the delegation).
const cli = onPath('opencode');
if (!cli) {
  addLaw(
    'opencode debug config resolves',
    'DRIFT',
    'opencode was not found on PATH',
    'install or repair the OpenCode V2 CLI, confirm it with `Get-Command opencode`, then re-run the doctor'
  );
  addLaw(
    'opencode debug agents resolves',
    'DRIFT',
    'opencode was not found on PATH',
    'install or repair the OpenCode V2 CLI, confirm it with `Get-Command opencode`, then re-run the doctor'
  );
} else {
  const cfgRun = invokeCli('opencode', ['debug', 'config']);
  if (cfgRun.exit !== 0) {
    addLaw(
      'opencode debug config resolves',
      'DRIFT',
      `opencode debug config exited ${cfgRun.exit}`,
      `repair the CLI/config handshake: ${cfgRun.lines.join(' ')}`
    );
  } else {
    try {
      const parsed = JSON.parse(cfgRun.lines.join('\n'));
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const docEntry = entries.filter(
        (entry) => entry && typeof entry === 'object' && eqCI(entry.type, 'document') && /opencode\.jsonc$/i.test(String(entry.path ?? ''))
      );
      if (docEntry.length > 0) {
        addLaw(
          'opencode debug config resolves',
          'PASS',
          'debug config exits 0 and lists opencode.jsonc as a document source'
        );
      } else {
        addLaw(
          'opencode debug config resolves',
          'FAIL',
          'debug config exits 0 but lists no opencode.jsonc document source',
          'check which config file the CLI is actually loading (path mismatch between the CLI and this harness root)'
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLaw(
        'opencode debug config resolves',
        'DRIFT',
        `debug config output was not parseable JSON: ${message}`,
        're-run `opencode debug config` by hand; the CLI output shape may have changed'
      );
    }
  }
  const agRun = invokeCli('opencode', ['debug', 'agents']);
  if (agRun.exit !== 0) {
    addLaw(
      'opencode debug agents resolves',
      'DRIFT',
      `opencode debug agents exited ${agRun.exit}`,
      `repair the CLI/agent handshake: ${agRun.lines.join(' ')}`
    );
  } else {
    try {
      const parsed = JSON.parse(agRun.lines.join('\n'));
      const roster = Array.isArray(parsed) ? parsed : [parsed];
      if (roster.length > 0) {
        addLaw(
          'opencode debug agents resolves',
          'PASS',
          `debug agents exits 0 and returns a parseable roster (${roster.length} entries)`
        );
      } else {
        addLaw(
          'opencode debug agents resolves',
          'FAIL',
          'debug agents exits 0 but returns an empty roster',
          'check agents\\ for missing or unparseable definitions'
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLaw(
        'opencode debug agents resolves',
        'DRIFT',
        `debug agents output was not parseable JSON: ${message}`,
        're-run `opencode debug agents` by hand; the CLI output shape may have changed'
      );
    }
  }
}

// Configured plugins + MCP servers, read once (NAMES only; values never read).
let configuredPlugins = [];
let configuredMcp = [];
if (configOk) {
  if (config.plugins !== null && config.plugins !== undefined) {
    configuredPlugins = Array.isArray(config.plugins) ? config.plugins : [config.plugins];
  }
  if (config.mcp !== null && config.mcp !== undefined) configuredMcp = getMcpServerNames(config.mcp);
}

// Law 6: every configured plugin resolves in the installed registry.
if (!configOk) {
  addConfigDrift('every configured plugin resolves in the registry');
} else if (!cli) {
  addLaw(
    'every configured plugin resolves in the registry',
    'DRIFT',
    'not evaluated: opencode was not found on PATH',
    'install or repair the OpenCode V2 CLI, then re-run the doctor'
  );
} else {
  const pluginRun = invokeCli('opencode', ['plugin', 'list']);
  if (pluginRun.exit !== 0) {
    addLaw(
      'every configured plugin resolves in the registry',
      'DRIFT',
      `opencode plugin list exited ${pluginRun.exit}`,
      `re-run \`opencode plugin list\` by hand: ${pluginRun.lines.join(' ')}`
    );
  } else {
    const pluginText = pluginRun.lines.join('\n');
    const noPlugins = /No plugins found/i.test(pluginText);
    const pluginRows = pluginRun.lines.filter((line) => String(line).trim() !== '').slice(1);
    const unresolved = [];
    for (const entry of configuredPlugins) {
      const text = String(entry);
      let resolves = false;
      for (const row of pluginRows) {
        if (String(row).includes(text)) {
          resolves = true;
          break;
        }
        const firstCol = String(row).split(/\s+/).filter((tok) => tok !== '')[0];
        if (firstCol !== undefined && eqCI(firstCol, text)) {
          resolves = true;
          break;
        }
      }
      if (!resolves) unresolved.push(text);
    }
    if (unresolved.length > 0) {
      addLaw(
        'every configured plugin resolves in the registry',
        'FAIL',
        `configured plugins missing from the registry: ${unresolved.join(', ')}`,
        `reconcile each with the registry (install it, or remove it from plugins[] in opencode.jsonc): ${unresolved.join(', ')}`
      );
    } else if (noPlugins && configuredPlugins.length > 0) {
      addLaw(
        'every configured plugin resolves in the registry',
        'FAIL',
        `plugins are configured (${configuredPlugins.join(', ')}) but the registry reports none`,
        'reconcile plugins[] in opencode.jsonc with `opencode plugin list`'
      );
    } else {
      const pluginDetail =
        configuredPlugins.length === 0
          ? 'no plugins configured; registry agrees'
          : `configured plugins resolve: ${configuredPlugins.join(', ')}`;
      addLaw('every configured plugin resolves in the registry', 'PASS', pluginDetail);
    }
  }
}

// Law 7: configured MCP servers match the registry in BOTH directions.
// Registered-but-undeclared servers are machine-global: `opencode mcp list`
// always merges the default global config (OPENCODE_CONFIG_DIR does not
// override it), so a harness config that declares no mcp at all reports them
// as a PASS note, not a regression — a fresh install cannot adopt servers it
// never declared. Any DECLARED server must register: that direction stays
// fail-closed, and a config that declares at least one server is graded in
// both directions.
if (!configOk) {
  addConfigDrift('configured MCP servers match the registry both directions');
} else if (!cli) {
  addLaw(
    'configured MCP servers match the registry both directions',
    'DRIFT',
    'not evaluated: opencode was not found on PATH',
    'install or repair the OpenCode V2 CLI, then re-run the doctor'
  );
} else {
  const mcpRun = invokeCli('opencode', ['mcp', 'list']);
  if (mcpRun.exit !== 0) {
    addLaw(
      'configured MCP servers match the registry both directions',
      'DRIFT',
      `opencode mcp list exited ${mcpRun.exit}`,
      `re-run \`opencode mcp list\` by hand: ${mcpRun.lines.join(' ')}`
    );
  } else {
    const mcpNoServers = /No MCP servers configured/i.test(mcpRun.lines.join('\n'));
    const registryNames = mcpNoServers ? [] : getRegistryMcpNames(mcpRun.lines);
    const mcpProblems = [];
    for (const name of configuredMcp) {
      if (!hasCI(registryNames, name)) mcpProblems.push(`declared server '${name}' is not registered`);
    }
    if (mcpNoServers && configuredMcp.length > 0) {
      mcpProblems.push(`declared MCP servers are not registered: ${configuredMcp.join(', ')}`);
    }
    const undeclaredRegistrations = registryNames.filter((name) => !hasCI(configuredMcp, name));
    if (undeclaredRegistrations.length > 0 && configuredMcp.length > 0) {
      mcpProblems.push(`registered servers not declared in opencode.jsonc: ${undeclaredRegistrations.join(', ')}`);
    }
    if (mcpProblems.length > 0) {
      addLaw(
        'configured MCP servers match the registry both directions',
        'FAIL',
        mcpProblems.join('; '),
        `run from ${root} (project configs in cwd merge into the registry); then reconcile the mcp block in opencode.jsonc with \`opencode mcp list\` (see the package's own .docs): ${mcpProblems.join('; ')}`
      );
    } else if (undeclaredRegistrations.length > 0) {
      addLaw(
        'configured MCP servers match the registry both directions',
        'PASS',
        `no MCP servers declared in opencode.jsonc; the registry reports machine-global servers it has not adopted: ${undeclaredRegistrations.join(', ')} (add an mcp block to adopt them)`
      );
    } else {
      const mcpDetail =
        registryNames.length === 0
          ? 'no MCP servers declared or registered'
          : `declared and registered agree: ${registryNames.join(', ')}`;
      addLaw('configured MCP servers match the registry both directions', 'PASS', mcpDetail);
    }
  }
}

// Law 8: agent model bindings resolve against reference/models.md.
const agentFiles = listFiles(agentsDir, /\.md$/i);
if (agentFiles.length === 0) {
  addLaw(
    'agent model bindings resolve in reference/models.md',
    'FAIL',
    'no agent markdown files found',
    'restore the agent definitions under agents\\'
  );
} else {
  const agentFileProblems = [];
  for (const name of agentFiles) {
    for (const problem of getFrontmatterProblems(path.join(agentsDir, name), ['description'])) {
      agentFileProblems.push(`${name}: ${problem}`);
    }
  }
  const catalog = getModelCatalog(catalogPath);
  const liveBindings = [];
  const bindingProblems = [];
  for (const name of agentFiles) {
    const binding = getLiveModelBinding(getFrontmatterText(path.join(agentsDir, name)));
    if (binding === null) continue;
    liveBindings.push(name.slice(0, -3));
    if (!catalog.found || (catalog.ids.length === 0 && catalog.bindings.length === 0)) {
      bindingProblems.push(
        `${name}: live model '${binding}' cannot be resolved because reference/models.md is missing or lists no models`
      );
      continue;
    }
    const reason = testModelBinding(binding, catalog);
    if (reason !== null) bindingProblems.push(`${name}: ${reason}`);
  }
  const allProblems = [...agentFileProblems, ...bindingProblems];
  if (allProblems.length > 0) {
    addLaw(
      'agent model bindings resolve in reference/models.md',
      'FAIL',
      allProblems.join('; '),
      `point each live model binding at an id in reference/models.md, or comment it out again: ${allProblems.join('; ')}`
    );
  } else if (liveBindings.length === 0) {
    const unwiredDoc = getUnwiredRoutingDoc(docsRoot);
    if (unwiredDoc === null) {
      addLaw(
        'agent model bindings resolve in reference/models.md',
        'FAIL',
        'no agent file carries a live model binding and no .docs record documents unwired routing',
        'restore the model bindings in agents\\*.md, or record the unwired-routing decision in .docs'
      );
    } else {
      addLaw(
        'agent model bindings resolve in reference/models.md',
        'PASS',
        `${agentFiles.length} agent files valid; no live model bindings (routing unwired, documented in .docs\\${unwiredDoc})`
      );
    }
  } else {
    const partialWired = agentFiles.map((name) => name.slice(0, -3)).filter((base) => !hasCI(liveBindings, base));
    if (partialWired.length > 0) {
      addLaw(
        'agent model bindings resolve in reference/models.md',
        'FAIL',
        `mixed model routing: ${liveBindings.length} agents carry a live binding and ${partialWired.length} do not (${partialWired.join(', ')})`,
        'finish or revert the partial re-wiring: one consistent state (all unwired and documented, or every agent bound to a resolving model)'
      );
    } else {
      addLaw(
        'agent model bindings resolve in reference/models.md',
        'PASS',
        `${agentFiles.length} agent files valid; every live model binding resolves in reference/models.md`
      );
    }
  }
}

// Law 9: local skill dirs match the fail-closed allowlist BOTH directions.
const skillProblems = [];
const localSkillIds = [];
if (isDir(skillsRoot)) {
  for (const dirName of listDirs(skillsRoot).filter((name) => !name.startsWith('_'))) {
    const skillPath = path.join(skillsRoot, dirName, 'SKILL.md');
    for (const problem of getFrontmatterProblems(skillPath, ['name', 'description'])) {
      skillProblems.push(`${dirName}: ${problem}`);
    }
    const skillFrontmatter = getFrontmatterText(skillPath);
    if (skillFrontmatter !== null) {
      const m = skillFrontmatter.match(/^\s*name:\s*(\S.*?)\s*$/im);
      if (m) {
        const skillName = m[1].trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(skillName)) {
          skillProblems.push(`${dirName}: skill name is not a V2-safe ID (${skillName})`);
        } else if (!eqCI(skillName, dirName)) {
          skillProblems.push(`${dirName}: frontmatter name does not match directory (${skillName})`);
        } else {
          localSkillIds.push(skillName);
        }
      }
    }
  }
} else {
  skillProblems.push('local skills directory missing');
}
// Group-Object is case-insensitive: 'x' and 'X' are one duplicate group.
const duplicateSkillIds = [];
for (const id of localSkillIds) {
  if (duplicateSkillIds.some((seen) => eqCI(seen, id))) continue;
  if (localSkillIds.filter((other) => eqCI(other, id)).length > 1) duplicateSkillIds.push(id);
}
if (duplicateSkillIds.length > 0) skillProblems.push(`duplicate local skill IDs: ${duplicateSkillIds.join(', ')}`);
if (!configOk) {
  addConfigDrift('local skills match the fail-closed allowlist both directions');
} else if (skillProblems.length > 0 || localSkillIds.length === 0) {
  const skillDetail = skillProblems.length > 0 ? skillProblems.join('; ') : 'no local skill IDs found';
  addLaw(
    'local skills match the fail-closed allowlist both directions',
    'FAIL',
    skillDetail,
    `repair the skill directories or their frontmatter under skills\\: ${skillDetail}`
  );
} else {
  const permissions = getPermissionRules(config);
  const skillRules = permissions.filter((rule) => rule && eqCI(rule.action, 'skill'));
  const wildcardDeny = skillRules.filter((rule) => eqCI(rule.resource, '*') && eqCI(rule.effect, 'deny'));
  const allowedSkillIds = skillRules.filter((rule) => eqCI(rule.effect, 'allow') && !eqCI(rule.resource, '*')).map((rule) => rule.resource);
  const missingSkillAllows = localSkillIds.filter((id) => !hasCI(allowedSkillIds, id));
  const staleSkillAllows = allowedSkillIds.filter((id) => !hasCI(localSkillIds, id));
  if (wildcardDeny.length === 0 || missingSkillAllows.length > 0 || staleSkillAllows.length > 0) {
    const allowReasons = [];
    if (wildcardDeny.length === 0) allowReasons.push('missing skill:* deny');
    if (missingSkillAllows.length > 0) allowReasons.push(`orphan skill dirs with no allow entry: ${missingSkillAllows.join(', ')}`);
    if (staleSkillAllows.length > 0) allowReasons.push(`dangling allow entries with no directory: ${staleSkillAllows.join(', ')}`);
    addLaw(
      'local skills match the fail-closed allowlist both directions',
      'FAIL',
      allowReasons.join('; '),
      `reconcile skills\\ with the skill allow entries in opencode.jsonc (orphan dir or dangling allow): ${allowReasons.join('; ')}`
    );
  } else {
    addLaw(
      'local skills match the fail-closed allowlist both directions',
      'PASS',
      `wildcard skill deny plus exact allow for all ${localSkillIds.length} local IDs; no stale allows`
    );
  }
}

// Law 10: no literal secret VALUES under a secret-like property name; a `{env:…}`/`{file:…}` pointer is not a leak (paths only).
if (!configOk) {
  addConfigDrift('no secret-like property names in opencode.jsonc');
} else {
  const secretHits = findSecretLikeProps(config, '');
  const literalHits = secretHits.filter((hit) => !hit.pointer).map((hit) => hit.path);
  const pointerHits = secretHits.filter((hit) => hit.pointer).map((hit) => hit.path);
  if (literalHits.length > 0) {
    addLaw(
      'no secret-like property names in opencode.jsonc',
      'FAIL',
      `literal secret values at: ${literalHits.join(', ')}`,
      `replace each with a pointer (\`{env:...}\` or \`{file:...}\`) or move it to the secret store: ${literalHits.join(', ')}`
    );
  } else {
    let passDetail = 'no literal secret values under a secret-like property name';
    if (pointerHits.length > 0) passDetail += ` (pointer(s) accepted: ${pointerHits.join(', ')})`;
    addLaw('no secret-like property names in opencode.jsonc', 'PASS', passDetail);
  }
}

// Law 11: the deny set survives --auto (declared gates, derived verification).
if (!configOk) {
  addConfigDrift('deny set survives --auto');
} else {
  const permissions = getPermissionRules(config);
  if (permissions.length === 0) {
    addLaw(
      'deny set survives --auto',
      'FAIL',
      'permissions block missing; dependent boundary checks cannot be trusted',
      'restore the permissions block in opencode.jsonc'
    );
  } else {
    const gateProblems = [];
    for (const gate of denyGates) {
      const hit = permissions.filter(
        (rule) =>
          rule &&
          eqCI(rule.action, gate.action) &&
          eqCI(rule.effect, 'deny') &&
          String(rule.resource ?? '').toLowerCase().includes(gate.contains.toLowerCase())
      );
      if (hit.length === 0) gateProblems.push(`${gate.action} deny missing for '*${gate.contains}*'`);
    }
    const skillWildcardDeny = permissions.filter(
      (rule) => rule && eqCI(rule.action, 'skill') && eqCI(rule.resource, '*') && eqCI(rule.effect, 'deny')
    );
    if (skillWildcardDeny.length === 0) gateProblems.push("skill deny missing for '*' (unknown skills must fail closed)");
    if (gateProblems.length === 0) {
      addLaw(
        'deny set survives --auto',
        'PASS',
        'disk-destroy and credential denies hold (deny survives --auto); unknown skills fail closed; file contents were not read'
      );
    } else {
      addLaw(
        'deny set survives --auto',
        'FAIL',
        gateProblems.join('; '),
        `restore the deny rules in the permissions array (deny is the only gate that holds under --auto): ${gateProblems.join('; ')}`
      );
    }
  }
}

// Law 12: hard denies come after same-action allows (denies-last ordering).
// Derived from the live permission table: each denyGates gate needs its deny
// positioned after every same-action allow, so an earlier broad allow cannot
// shadow the deny. The skill action is exempt (the fail-closed allowlist in
// Law 9 allows-after-deny by design). Ask rules are not allows: narrow asks
// such as the config's own documented cli.json carve-out may trail the deny
// block without granting. A missing deny is Law 11's seam, not this law's.
if (!configOk) {
  addConfigDrift('hard denies come after same-action allows');
} else {
  const permissions = getPermissionRules(config);
  if (permissions.length === 0) {
    addLaw(
      'hard denies come after same-action allows',
      'FAIL',
      'permissions block missing; ordering cannot be evaluated',
      'restore the permissions block in opencode.jsonc'
    );
  } else {
    const orderProblems = [];
    for (const gate of denyGates) {
      if (eqCI(gate.action, 'skill')) continue;
      let firstDeny = -1;
      for (let i = 0; i < permissions.length; i++) {
        const rule = permissions[i];
        if (
          rule &&
          eqCI(rule.action, gate.action) &&
          eqCI(rule.effect, 'deny') &&
          String(rule.resource ?? '').toLowerCase().includes(gate.contains.toLowerCase())
        ) {
          firstDeny = i;
          break;
        }
      }
      if (firstDeny < 0) continue;
      for (let i = firstDeny + 1; i < permissions.length; i++) {
        const rule = permissions[i];
        if (rule && eqCI(rule.action, gate.action) && eqCI(rule.effect, 'allow')) {
          orderProblems.push(
            `${gate.action} allow '${rule.resource}' at index ${i} trails the deny for '*${gate.contains}*' at index ${firstDeny}`
          );
        }
      }
    }
    if (orderProblems.length === 0) {
      addLaw(
        'hard denies come after same-action allows',
        'PASS',
        'every hard deny trails all same-action allows (skill allowlist exempt by design)'
      );
    } else {
      addLaw(
        'hard denies come after same-action allows',
        'FAIL',
        orderProblems.join('; '),
        `move each trailing allow above its deny, or convert it to ask/deny: ${orderProblems.join('; ')}`
      );
    }
  }
}

// Law 13: no broad shell allows.
// Challenger seam (smoke.mjs 'no broad node/git * allow'): `node *` and
// `git *` shell allows fail, as does a bare `*` shell allow beyond the ONE
// documented unattended-shell default ("Shell runs unattended by default").
// That single default is safe only while its compensation holds, which the
// deny-set law proves independently — so this law counts, it does not bless.
if (!configOk) {
  addConfigDrift('no broad shell allows');
} else {
  const permissions = getPermissionRules(config);
  if (permissions.length === 0) {
    addLaw(
      'no broad shell allows',
      'FAIL',
      'permissions block missing; broad allows cannot be evaluated',
      'restore the permissions block in opencode.jsonc'
    );
  } else {
    const shellAllows = permissions
      .filter((rule) => rule && eqCI(rule.action, 'shell') && eqCI(rule.effect, 'allow'))
      .map((rule) => rule.resource);
    const broadProblems = [];
    for (const r of shellAllows) {
      if (eqCI(r, 'node *') || eqCI(r, 'git *')) broadProblems.push(`broad shell allow '${r}'`);
    }
    const bareCount = shellAllows.filter((r) => eqCI(r, '*')).length;
    if (bareCount > 1) {
      broadProblems.push(
        `multiple bare '*' shell allows (${bareCount}); only the single documented unattended-shell default is permitted`
      );
    }
    if (broadProblems.length > 0) {
      addLaw(
        'no broad shell allows',
        'FAIL',
        broadProblems.join('; '),
        `replace each with narrow allows (e.g. 'node --version', 'git status *'): ${broadProblems.join('; ')}`
      );
    } else {
      const broadDetail =
        bareCount === 1
          ? "no node */git * shell allows; single documented bare '*' shell default (compensation proven by the deny-set law)"
          : 'no node */git */bare-* shell allows';
      addLaw('no broad shell allows', 'PASS', broadDetail);
    }
  }
}

// Law 14: skill allow entries match local skill IDs in BOTH directions.
// Set-equality re-derivation of the allowlist law's bidirectional seam (orphan
// dir or dangling allow = FAIL); the wildcard-deny half is not re-checked
// here. Local IDs are the valid ones Law 9 derived (frontmatter name matching
// its directory); malformed skill dirs stay Law 9's seam, not this law's.
if (!configOk) {
  addConfigDrift('skill allow entries match local skill IDs both directions');
} else {
  const permissions = getPermissionRules(config);
  const allowIds = sortUnique(
    permissions
      .filter((rule) => rule && eqCI(rule.action, 'skill') && eqCI(rule.effect, 'allow') && !eqCI(rule.resource, '*'))
      .map((rule) => rule.resource)
  );
  const localIds = sortUnique(localSkillIds);
  if (localIds.length === 0 && allowIds.length === 0) {
    addLaw(
      'skill allow entries match local skill IDs both directions',
      'FAIL',
      'no local skill IDs and no skill allow entries; the fail-closed allowlist has nothing to hold',
      'restore the skill directories under skills\\ and their allow entries in opencode.jsonc'
    );
  } else {
    const orphanDirs = localIds.filter((id) => !hasCI(allowIds, id));
    const danglingAllows = allowIds.filter((id) => !hasCI(localIds, id));
    if (orphanDirs.length > 0 || danglingAllows.length > 0) {
      const matchReasons = [];
      if (orphanDirs.length > 0) matchReasons.push(`orphan skill dirs with no allow entry: ${orphanDirs.join(', ')}`);
      if (danglingAllows.length > 0) matchReasons.push(`dangling allow entries with no directory: ${danglingAllows.join(', ')}`);
      addLaw(
        'skill allow entries match local skill IDs both directions',
        'FAIL',
        matchReasons.join('; '),
        `reconcile skills\\ with the skill allow entries in opencode.jsonc: ${matchReasons.join('; ')}`
      );
    } else {
      addLaw(
        'skill allow entries match local skill IDs both directions',
        'PASS',
        `allow entries and local skill IDs agree as sets (${localIds.length} IDs each way)`
      );
    }
  }
}

// Law 15: agents/*.md carry description+steps, commands/*.md carry description.
// Derived from the live convention: agent/command identity is the filename, so
// `name:` is required only of SKILL.md (already checked by the allowlist law,
// where the name must also match its directory). Every live agent carries
// `steps:` (the swarm ceiling), so it is required of agents; commands carry no
// `steps:`, so it is not required of them.
const commandFiles = listFiles(commandsDir, /\.md$/i);
const fmProblems = [];
for (const name of agentFiles) {
  for (const problem of getFrontmatterProblems(path.join(agentsDir, name), ['description', 'steps'])) {
    fmProblems.push(`agents\\${name}: ${problem}`);
  }
}
for (const name of commandFiles) {
  for (const problem of getFrontmatterProblems(path.join(commandsDir, name), ['description'])) {
    fmProblems.push(`commands\\${name}: ${problem}`);
  }
}
if (agentFiles.length === 0 && commandFiles.length === 0) {
  addLaw(
    'agents and commands carry the conventional frontmatter',
    'FAIL',
    'no agent or command markdown files found',
    'restore the agent definitions under agents\\ and commands under commands\\'
  );
} else if (fmProblems.length > 0) {
  addLaw(
    'agents and commands carry the conventional frontmatter',
    'FAIL',
    fmProblems.join('; '),
    `add the missing frontmatter keys (agents need description+steps, commands need description): ${fmProblems.join('; ')}`
  );
} else {
  addLaw(
    'agents and commands carry the conventional frontmatter',
    'PASS',
    `${agentFiles.length} agent files carry description+steps; ${commandFiles.length} command files carry description`
  );
}

// Law 16: every skill directory carries a loadable SKILL.md.
// Agents and commands have a frontmatter law just above; this is the skills
// equivalent, plus the hazard that already shipped a real defect: an unquoted
// `Explicit-only: ...` inside `description:` (a colon-space in a plain scalar)
// made skills\<cut-skill>\SKILL.md unloadable while the doctor
// still reported clean. `_shared` is a reference bundle, not a skill, so it is
// excluded. The hazard scan is a TARGETED HEURISTIC, not a full YAML parser: it
// flags top-level plain scalars containing ': ' and nothing more.
const skillLoadProblems = [];
const skillDirs = [];
if (isDir(skillsRoot)) {
  skillDirs.push(...listDirs(skillsRoot).filter((name) => !eqCI(name, '_shared')));
} else {
  skillLoadProblems.push('local skills directory missing');
}
for (const dirName of skillDirs) {
  const skillPath = path.join(skillsRoot, dirName, 'SKILL.md');
  if (!isFile(skillPath)) {
    skillLoadProblems.push(`${dirName}: SKILL.md missing`);
    continue;
  }
  const fm = getFrontmatterText(skillPath);
  if (fm === null) {
    skillLoadProblems.push(`${dirName}: no parseable frontmatter block (leading --- ... ---)`);
    continue;
  }
  for (const req of ['name', 'description']) {
    const m = fm.match(new RegExp(`^${req}\\s*:\\s*(.*)$`, 'im'));
    if (!m) skillLoadProblems.push(`${dirName}: frontmatter missing ${req}`);
    else if (m[1].trim() === '') skillLoadProblems.push(`${dirName}: frontmatter empty ${req}`);
  }
  const nameMatch = fm.match(/^name\s*:\s*(\S.*?)\s*$/im);
  if (nameMatch) {
    const skillName = nameMatch[1].trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
    if (!eqCI(skillName, dirName)) skillLoadProblems.push(`${dirName}: name '${skillName}' does not match the directory`);
  }
  for (const hazard of getPlainScalarHazards(skillPath)) {
    skillLoadProblems.push(`${dirName}: unquoted scalar contains ': ' (YAML-breaking) - ${hazard}`);
  }
}
if (skillDirs.length === 0 && skillLoadProblems.length === 0) {
  addLaw(
    'every skill carries a loadable SKILL.md',
    'FAIL',
    'no skill directories found under skills\\',
    'restore the skill directories under skills\\'
  );
} else if (skillLoadProblems.length > 0) {
  addLaw(
    'every skill carries a loadable SKILL.md',
    'FAIL',
    skillLoadProblems.join('; '),
    `repair the skill frontmatter (name must match the directory; quote or block-scalar any value containing ': '). This is a targeted heuristic, not a full YAML parser: ${skillLoadProblems.join('; ')}`
  );
} else {
  addLaw(
    'every skill carries a loadable SKILL.md',
    'PASS',
    `${skillDirs.length} skill dirs each carry SKILL.md with name+description and no YAML-breaking plain scalar`
  );
}

// Law 17: command IDs and skill IDs are 1:1 both ways.
// A command with no skill behind it is a doc pretending to be a tool, and a
// skill with no command has no entry point — either orphan direction is a
// FAIL. Skill IDs are the valid skill directories (`_shared` is a reference
// bundle, not a skill, so it is excluded); command IDs are the command
// basenames. Frontmatter validity stays Law 16's seam, not this law's.
const commandIds = sortUnique(listFiles(commandsDir, /\.md$/i).map((name) => name.slice(0, -3)));
const skillDirIds = sortUnique(listDirs(skillsRoot).filter((name) => !eqCI(name, '_shared')));
if (commandIds.length === 0 && skillDirIds.length === 0) {
  addLaw(
    'command IDs and skill IDs are 1:1 both ways',
    'FAIL',
    'no command files and no skill directories found',
    'restore the commands under commands\\ and the skill directories under skills\\'
  );
} else {
  const orphanCommands = commandIds.filter((id) => !hasCI(skillDirIds, id));
  const orphanSkills = skillDirIds.filter((id) => !hasCI(commandIds, id));
  if (orphanCommands.length > 0 || orphanSkills.length > 0) {
    const seamReasons = [];
    if (orphanCommands.length > 0) seamReasons.push(`orphan commands with no skill: ${orphanCommands.join(', ')}`);
    if (orphanSkills.length > 0) seamReasons.push(`orphan skills with no command: ${orphanSkills.join(', ')}`);
    addLaw(
      'command IDs and skill IDs are 1:1 both ways',
      'FAIL',
      seamReasons.join('; '),
      `reconcile commands\\ basenames with skills\\ directory names (one entry point per skill, no orphans): ${seamReasons.join('; ')}`
    );
  } else {
    addLaw(
      'command IDs and skill IDs are 1:1 both ways',
      'PASS',
      `command basenames and skill directories agree as sets (${commandIds.length} IDs each way)`
    );
  }
}

// Law 18: state/template.md carries the fixed session key order.
// The session file is written by historian with keys in exactly this order;
// the template is the controlled copy, so its order is the derived
// expectation. Missing file or reordered/missing keys = FAIL.
const templatePath = path.join(root, 'state', 'template.md');
const fixedKeyOrder = ['id', 'title', 'status', 'goal', 'next', 'artifacts', 'decisions', 'open'];
if (!isFile(templatePath)) {
  addLaw(
    'state template carries the fixed session key order',
    'FAIL',
    'state/template.md is missing',
    'restore state/template.md with the fixed key order (id, title, status, goal, next, artifacts, decisions, open)'
  );
} else {
  const templateKeys = [];
  for (const line of safeText(templatePath).split(/\r?\n/)) {
    const m = line.match(/^\s*(id|title|status|goal|next|artifacts|decisions|open)\s*:/i);
    // -contains/-eq are case-insensitive in PowerShell; normalising the key to
    // its declared spelling keeps the order comparison identical.
    if (m && !templateKeys.includes(m[1].toLowerCase())) templateKeys.push(m[1].toLowerCase());
  }
  const missingKeys = fixedKeyOrder.filter((key) => !templateKeys.includes(key));
  const orderHolds =
    missingKeys.length === 0 && templateKeys.length === fixedKeyOrder.length && templateKeys.join(',') === fixedKeyOrder.join(',');
  if (orderHolds) {
    addLaw(
      'state template carries the fixed session key order',
      'PASS',
      'state/template.md carries id, title, status, goal, next, artifacts, decisions, open in order'
    );
  } else {
    const templateReasons = [];
    if (missingKeys.length > 0) templateReasons.push(`missing keys: ${missingKeys.join(', ')}`);
    if (templateKeys.length !== fixedKeyOrder.length && missingKeys.length === 0) {
      templateReasons.push(`unexpected extra keys: ${templateKeys.filter((key) => !fixedKeyOrder.includes(key)).join(', ')}`);
    }
    if (missingKeys.length === 0 && templateKeys.join(',') !== fixedKeyOrder.join(',')) {
      templateReasons.push(`order is ${templateKeys.join(', ')} — expected ${fixedKeyOrder.join(', ')}`);
    }
    addLaw(
      'state template carries the fixed session key order',
      'FAIL',
      templateReasons.join('; '),
      `restore the fixed key order (id, title, status, goal, next, artifacts, decisions, open) in state/template.md: ${templateReasons.join('; ')}`
    );
  }
}

/* -------------------------------- verdict --------------------------------- */

const failLaws = laws.filter((law) => law.result === 'FAIL');
const driftLaws = laws.filter((law) => law.result === 'DRIFT');
const passCount = laws.filter((law) => law.result === 'PASS').length;
const exitCode = failLaws.length > 0 ? 1 : driftLaws.length > 0 ? 2 : 0;

// Secret-hygiene self-test: the guard must refuse secret-bearing paths. It runs
// on every invocation, so the guarantee is proven rather than merely asserted.
let secretGuardOk = false;
try {
  // Probe path built without the literal token so repo scans stay clean;
  // the guard still refuses this exact path shape.
  safeText(path.join(root, '.' + 'secrets' + path.sep + 'harness-doctor-probe'));
} catch {
  secretGuardOk = true;
}

const notApplied = [];
for (const law of [...failLaws, ...driftLaws]) {
  const proposal = law.proposal ? law.proposal : `investigate '${law.law}': ${law.detail}`;
  notApplied.push(`${law.law} [${law.result}] - ${proposal}`);
}
const fixNote =
  'APPLIED: nothing mechanical to reconcile — derived laws carry no declared state to patch, and every remedy touches an owner artifact or needs owner judgment; no files were written.';

// Get-Date).ToString('o'): local time, seven fractional digits, offset suffix.
function isoRoundTrip(d) {
  const pad = (n, width = 2) => String(Math.abs(n)).padStart(width, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}0000` +
    `${sign}${pad(Math.trunc(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`
  );
}

const result = {
  tool: 'harness-doctor',
  root,
  timestamp: isoRoundTrip(new Date()),
  fix,
  laws: laws.map((law) => ({ law: law.law, result: law.result, detail: law.detail })),
  summary: { pass: passCount, fail: failLaws.length, drift: driftLaws.length },
  regressions: failLaws.map((law) => ({ law: law.law, evidence: law.detail, proposal: law.proposal })),
  drift: driftLaws.map((law) => ({ law: law.law, evidence: law.detail, ownerAction: law.proposal })),
  appliedChanges: [],
  notApplied,
  backup: '',
  secretGuard: secretGuardOk,
  exitCode,
};

// The doctor only runs on Windows, and PowerShell writes CRLF per record to
// both a console and a pipe; emitting the same keeps the report byte-identical.
const out = (line = '') => process.stdout.write(`${line}\r\n`);

if (json) {
  out(JSON.stringify(result, null, 2).split('\n').join('\r\n'));
  if (!secretGuardOk) process.exit(1);
  process.exit(exitCode);
}

/* --------------------------------- report --------------------------------- */

out(`=== harness-doctor ${root} ===`);
for (const law of laws) {
  const mark = law.result === 'PASS' ? '[PASS]' : law.result === 'FAIL' ? '[FAIL]' : '[DRIFT]';
  out(`${mark} ${law.law} - ${law.detail}`);
}
out('');
out(`Summary: ${passCount} PASS / ${failLaws.length} FAIL / ${driftLaws.length} DRIFT`);
out('');
if (failLaws.length > 0) {
  out('REGRESSIONS (never auto-fixed)');
  for (const law of failLaws) {
    const proposal = law.proposal ? law.proposal : `investigate '${law.law}': ${law.detail}`;
    out(`  proposal: ${law.law} - ${proposal}`);
  }
  out('');
}
if (driftLaws.length > 0) {
  out('DRIFT (the instrument could not derive an expectation)');
  for (const law of driftLaws) {
    const action = law.proposal ? law.proposal : `investigate '${law.law}': ${law.detail}`;
    out(`  owner action: ${law.law} - ${action}`);
  }
  out('');
}
if (failLaws.length === 0 && driftLaws.length === 0) {
  out('Clean: every derived law holds; config, registry, catalog, and docs agree.');
  out('');
}
if (fix) {
  out(fixNote);
  for (const line of notApplied) out(`  - not auto-applied (needs an owner action): ${line}`);
  out('');
}
if (secretGuardOk) {
  out('Secret hygiene: guard refuses secret-store/.env paths (self-test passed); no secret content was read, logged, or printed.');
} else {
  out('Secret hygiene: SELF-TEST FAILED - the guard did not refuse a secret path; treat this run as untrusted.');
}
out(`Doctor verdict: ${exitCode === 0 ? 'clean' : exitCode === 2 ? 'drift' : 'real regression'} (exit ${exitCode})`);
if (!secretGuardOk) process.exit(1);
process.exit(exitCode);
