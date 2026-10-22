#!/usr/bin/env node
/**
 * oc-harness-setup — installer engine. Pure Node ESM, stdlib only, ZERO dependencies.
 *
 * Subcommands / flags:
 *   setup                 full install (default when no args)
 *   --dry-run             print the install manifest, touch nothing
 *   --ci                  refuse to mutate: print the manifest, exit 0
 *   setup --uninstall     delete exactly the manifest-listed files, keep
 *                         user-modified ones, print the backup restore path
 *   --version / -v        print the package version, touch nothing
 *
 * Exit codes are strictly 0 (ok / clean abort) or 1 (failure).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

// Node floor: import.meta.dirname needs Node 20.11+; the supported floor is
// 22 (package.json engines + README + CI). Fail fast with a clear message
// instead of a cryptic TypeError on older runtimes.
const NODE_MAJOR = Number(String(process.versions?.node ?? '').split('.')[0]);
if (!Number.isInteger(NODE_MAJOR) || NODE_MAJOR < 22) {
  console.error(
    `oc-harness-setup requires Node.js 22 or newer (found ${process.versions?.node ?? 'unknown'}). Install Node 22+ and retry.`
  );
  process.exit(1);
}

const PKG_NAME = 'oc-harness-setup';
const PKG_ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST_FILE = 'oc-harness-setup.manifest.json';
const COPY_DIRS = ['agents', 'commands', 'skills', 'reference', 'scripts', '.docs', 'state-seed'];
const COPY_FILES = ['AGENTS.md', 'GLOSSARY.md', 'gitignore.template'];
// npm renames a shipped root dotfile (`.gitignore` → `.npmignore`) on pack/
// install, so the pack ships `gitignore.template` and the installer aliases it
// back to `.gitignore` at the destination.
const FILE_ALIASES = { 'gitignore.template': '.gitignore' };
// Source→destination aliases: the pack ships `state-seed/` (tracked) but the
// live tree owns `state/` (git-ignored runtime), so every incoming
// `state-seed/...` file lands at `state/...`. `rel` is ALWAYS the
// destination-relative path — manifest, journal, and logs use it.
const DIR_ALIASES = { 'state-seed': 'state' };
// Ownership table for the opencode.jsonc merge. Every top-level key falls into
// exactly one bucket; there is no "known merge key" list to drift out of date.
//   INSTALL_OWNED — the distro's value wins outright (runtime policy).
//   UNION_KEYS    — arrays unioned + deduped (distro entries first).
//   'references'  — object union: distro keys + user-only keys.
//   'permissions' — ordered union: harness allow/ask rules first, then the
//                   adopter's rules, then the harness's hard DENIES last. Under
//                   last-match-wins this lets an adopter's deny beat a harness
//                   allow while nothing can shadow a harness deny. The `skill`
//                   wildcard deny is exempt from the move (its fail-closed
//                   allowlist is deny-then-allows; see mergeJsonc).
//   everything else (known or unknown) — the adopter's value wins; the distro
//                   value stays when the adopter does not define the key.
const INSTALL_OWNED = ['$schema', 'default_agent', 'formatter', 'compaction', 'tool_output', 'media', 'watcher', 'policies'];
const UNION_KEYS = ['plugins'];
const DISTRO_PLUGIN_IDS = ['oc-flight-deck'];
// Adopter-owned files: a shipped skeleton that the adopter genuinely edited
// MUST survive an upgrade — overwriting it destroys their data. Genuineness
// is proven against the prior manifest (see stageFiles): a destination that
// still matches the prior installed hash is unmodified pack content and IS
// updated, so a stock 0.3.3 AGENTS.md is replaced by the V9 contract while a
// genuinely adopter-edited one is kept. The template is a controlled copy
// graded by the doctor, so adopter edits are archived then overwritten.
const PRESERVE_IF_EXISTS = new Set(['reference/models.md', 'AGENTS.md', '.gitignore', 'state/lessons.md']);
// Keyed on forward slashes; matched through norm() because rel is platform-native
// (path.join yields backslashes on Windows).
// Leak markers — generic shapes, never a concrete machine. They catch the
// maintainer's workstation leaking into the shipped tree (an absolute
// user-profile path, a session id). They are linted against the package
// source only, never the adopter's config, so a legitimate
// `{file:~/.secrets/…}` apiKey pointer can never abort an install.
//
// Every marker is a SHAPE, not a value: a drive letter plus a user-profile
// path, a session-id token — never the product's own vocabulary. The
// harness's safety tooling legitimately ships illustrative path fragments
// and self-test probes, so a bare generic token would abort every correct
// install; the markers are drawn tight enough to miss them (verified by the
// packaging audit, which runs these same shapes over the shipped tree).
// A leak of a concrete workstation path into a secret store is caught by the
// profile-path marker; a bare `.secrets` cannot distinguish product from
// author and so is deliberately not a marker.
const LINT_PATTERNS = [
  { label: 'absolute user path', test: /[a-z]:[\\/]users[\\/]/i },
  { label: 'session id', test: /ses_[a-z0-9]{16,}/ },
];

/* ------------------------------ tiny helpers ------------------------------ */

function log(label, msg) {
  console.log(`[${label}] ${msg}`);
}

// Never reuse a taken path when preserving bytes: copying onto an existing file
// would destroy the very copy we are trying to keep.
function nextFreePath(base) {
  if (!existsSync(base)) return base;
  for (let i = 2; ; i++) {
    const p = `${base}-${i}`;
    if (!existsSync(p)) return p;
  }
}

// F4: atomic file replace — rename dest aside, rename tmp into place, then
// delete the aside copy (restoring the aside copy if the middle step throws).
// Closes the rm-then-rename window where a crash left the user's file DELETED
// with the new copy orphaned as tmp.
function atomicInstall(tmp, dest) {
  if (!existsSync(dest)) {
    renameSync(tmp, dest);
    return;
  }
  const aside = nextFreePath(`${dest}.oc-harness-setup-aside-${process.pid}`);
  renameSync(dest, aside);
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try {
      renameSync(aside, dest);
    } catch {}
    throw err;
  }
  rmSync(aside, { force: true });
}

function usage() {
  console.log(`oc-harness-setup — install the OpenCode harness into your config dir.

usage:
  oc-harness-setup setup                full install (default: no args needed)
  oc-harness-setup --dry-run            print the manifest only; touch nothing
  oc-harness-setup --ci                 print-only, refuse to mutate, exit 0
  oc-harness-setup setup --uninstall    remove exactly the manifest-listed files
  oc-harness-setup --version            print the package version`);
}

class Bail extends Error {}
function bail(msg) {
  console.error(`[error] ${msg}`);
  throw new Bail(msg);
}

// Windows 10/11 only. This installer writes the Windows config home, runs
// PowerShell doctors, and registers Windows shell policy — there is no
// macOS/Linux path. --help and --version return from parseArgs before any
// dispatch, so they keep working everywhere.
function assertWindows() {
  if (process.platform !== 'win32') {
    bail('Windows 10/11 only — macOS and Linux are not supported.');
  }
  log('platform', 'Windows detected — running the Windows installer path');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
const sha256File = (p) => sha256(readFileSync(p));
const sha256Text = (s) => sha256(Buffer.from(s, 'utf8'));

function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function versionLess(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const sa = i < pa.length ? pa[i] : '0';
    const sb = i < pb.length ? pb[i] : '0';
    const aNum = /^\d+$/.test(sa);
    const bNum = /^\d+$/.test(sb);
    if (aNum && bNum) {
      const diff = Number(sa) - Number(sb);
      if (diff !== 0) return diff < 0;
    } else {
      if (sa !== sb) return sa < sb;
    }
  }
  return false;
}

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Run a CLI. On Windows, npm-installed commands are .cmd shims that
 * CreateProcess cannot launch directly — retry through cmd.exe on ENOENT.
 */
function exec(name, args = [], capture = false) {
  const opts = {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  };
  try {
    const res1 = spawnSync(name, args, opts);
    if (!res1.error) return res1;
    if (res1.error.code !== 'ENOENT') return res1;
    if (process.platform === 'win32') {
      const comspec = process.env.ComSpec || 'cmd.exe';
      const res2 = spawnSync(comspec, ['/d', '/s', '/c', name, ...args], opts);
      if (!res2.error) return res2;
    }
    return res1;
  } catch (err) {
    return { error: err, status: null, stdout: '', stderr: '' };
  }
}

/* ------------------------- preflight / config discovery -------------------- */

function preflight() {
  const res = exec('opencode', ['--version'], true);
  if (res.error || res.status !== 0) {
    bail(
      'OpenCode CLI is required but not runnable (' +
        (res.error ? 'not found on PATH' : `exited ${res.status}`) +
        '). Install/upgrade OpenCode first, then re-run setup.'
    );
  }
  const first = (res.stdout || '').trim().split(/\r?\n/)[0] || 'unknown version';
  log('preflight', `opencode ${first} — OK`);
}

function findConfigDir() {
  const res = exec('opencode', ['debug', 'paths'], true);
  if (!res.error && res.status === 0) {
    const m = (res.stdout || '').match(/^config\s*[=:]?\s*(.+)$/m);
    if (m) {
      let dir = m[1].trim().replace(/^["']|["']$/g, '');
      if (dir.startsWith('~') && (dir[1] === '/' || dir[1] === '\\')) {
        dir = path.join(homedir(), dir.slice(2));
      }
      if (dir) {
        // F7: opencode echoes OPENCODE_CONFIG_DIR verbatim, so a relative
        // value arrives here still relative — resolve to absolute so the
        // manifest records a cwd-independent destination.
        dir = path.resolve(dir);
        log('config', `resolved via 'opencode debug paths': ${dir}`);
        return dir;
      }
    }
  } else {
    log('config', 'opencode debug paths unavailable — falling back to the environment chain');
  }
  const env = process.env;
  if (env.OPENCODE_CONFIG_DIR) {
    // F7: resolve verbatim env (relative → cwd-dependent) to absolute and
    // expand a leading ~, mirroring the debug-paths branch.
    let dir = String(env.OPENCODE_CONFIG_DIR).trim().replace(/^["']|["']$/g, '');
    if (dir === '~' || (dir.startsWith('~') && (dir[1] === '/' || dir[1] === '\\'))) {
      dir = path.join(homedir(), dir.length > 1 ? dir.slice(2) : '');
    } else {
      dir = path.resolve(dir);
    }
    log('config', `env OPENCODE_CONFIG_DIR: ${dir}`);
    return dir;
  }
  // Windows-only target: the live Windows profile owns the config home.
  // There are no XDG/HOME fallbacks — macOS and Linux are not supported
  // (assertWindows bails before any discovery on those platforms).
  const profile = env.USERPROFILE || homedir();
  if (profile) {
    const p = path.resolve(path.join(profile, '.config', 'opencode'));
    log('config', `profile fallback: ${p}`);
    return p;
  }
  bail('could not determine the OpenCode config dir. Set OPENCODE_CONFIG_DIR and re-run (USERPROFILE is absent).');
}

/* --------------------------- package tree collection ----------------------- */

function walkDir(dir, onFile) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(p, onFile);
    else onFile(p);
  }
}

function collectIncoming(configDir) {
  const files = [];
  for (const dirName of COPY_DIRS) {
    const srcDir = path.join(PKG_ROOT, dirName);
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
      log('staging', `note: ${dirName}/ not present in this package — nothing to copy from it`);
      continue;
    }
    walkDir(srcDir, (p) => {
      const pkgRel = path.relative(PKG_ROOT, p);
      // Alias the destination: state-seed/lessons.md -> state/lessons.md.
      const top = pkgRel.split(path.sep)[0];
      const rel = DIR_ALIASES[top] ? path.join(DIR_ALIASES[top], pkgRel.slice(top.length + 1)) : pkgRel;
      files.push({
        rel,
        src: p,
        dest: path.join(configDir, rel),
      });
    });
  }
  for (const f of COPY_FILES) {
    const src = path.join(PKG_ROOT, f);
    if (!existsSync(src)) {
      log('staging', `note: ${f} not present in this package — nothing to copy`);
      continue;
    }
    const rel = FILE_ALIASES[f] ?? f;
    files.push({ rel, src, dest: path.join(configDir, rel) });
  }
  return files;
}

/* -------------------------------- backup ----------------------------------- */

function makeBackup(configDir, backupPath) {
  if (existsSync(configDir)) {
    if (!statSync(configDir).isDirectory()) {
      bail(`${configDir} exists but is not a directory — refusing to install over it`);
    }
    cpSync(configDir, backupPath, { recursive: true });
    log('backup', `copied ${configDir} → ${backupPath}`);
  } else {
    log('backup', `no config dir at ${configDir} yet — will create it (nothing to back up)`);
  }
  return backupPath;
}

// A second-resolution stamp can repeat on a fast re-run. If that path already
// exists it may be the PRESERVED ORIGINAL snapshot, and cpSync into an existing
// dir would overwrite pristine bytes — so never reuse a taken path.
function nextBackupPath(configDir) {
  const stamp = tsStamp();
  let p = `${configDir}.bak-oc-harness-setup-${stamp}`;
  for (let i = 2; existsSync(p); i++) p = `${configDir}.bak-oc-harness-setup-${stamp}-${i}`;
  return p;
}

/* ------------------------------ staged copy -------------------------------- */

function stageFiles(files, manifest, prior, configDir) {
  // Prior manifests spell paths with either separator; incoming rels use the
  // platform join. Compare on normalized slashes so a prior entry still
  // matches its incoming path (journaling keeps each entry's own spelling).
  const norm = (p) => String(p).replace(/\\/g, '/');
  const priorByPath = new Map(
    (prior && Array.isArray(prior.files) ? prior.files : []).map((f) => [norm(f.path), f])
  );
  let written = 0;
  for (const f of files) {
    const srcHash = sha256File(f.src);
    let action = 'written';
    let prevHash = null;
    let archivedTo = null;
    if (existsSync(f.dest)) {
      const destHash = sha256File(f.dest);
      if (destHash === srcHash) {
        action = 'skip';
        log('staging', `skip   ${f.rel} (already identical — rerun-safe)`);
      } else if (PRESERVE_IF_EXISTS.has(norm(f.rel))) {
        // Upgrade rule: preserve only a GENUINELY adopter-edited file, i.e.
        // one that differs from the prior manifest hash. A destination that
        // still matches the prior installed hash is unmodified pack content —
        // update it, so a stock 0.3.3 AGENTS.md is replaced by the V9 contract
        // while an adopter-edited AGENTS.md is kept. No prior record means we
        // cannot prove it is stock, so preserve (never destroy unknown data).
        const p = priorByPath.get(norm(f.rel));
        if (p && p.hash && destHash === p.hash) {
          action = 'overwritten';
          prevHash = destHash;
          log('staging', `update ${f.rel} (matches the prior installed hash — unmodified pack content, overwriting; backup + manifest protect you)`);
        } else {
          action = 'preserved';
          log('staging', `preserve ${f.rel} (exists and differs from the prior install — kept; harness will not overwrite adopter-owned files)`);
        }
      } else {
        // Safe-upgrade rule: a destination the user edited since install
        // (its bytes differ from the prior manifest hash) is archived before
        // the overwrite, so a user-modified 0.3.x file that the new distro
        // still ships — e.g. agents/orchestrator.md — is never silently
        // destroyed. Unmodified pack content (or no prior record) overwrites
        // normally; the pre-install backup still protects it. Files in
        // PRESERVE_IF_EXISTS never reach this branch (kept above, never
        // archived). Same archive root and nextFreePath as retireStale.
        const p = priorByPath.get(norm(f.rel));
        // state/template.md is pack-owned but graded: an existing copy that
        // differs from the shipped bytes is ALWAYS archived before the
        // overwrite, with or without a prior manifest entry.
        const isTemplate = norm(f.rel) === 'state/template.md';
        if ((p && p.hash && destHash !== p.hash) || (isTemplate && destHash !== srcHash)) {
          const dest2 = nextFreePath(path.join(configDir, 'state', 'archive', 'legacy-0.3.x', f.rel));
          mkdirSync(path.dirname(dest2), { recursive: true });
          renameSync(f.dest, dest2);
          archivedTo = path.relative(configDir, dest2);
          action = 'overwritten';
          prevHash = destHash;
          log('staging', `archive ${f.rel} → ${archivedTo} (you edited the old file — pre-upgrade bytes moved aside; writing the new file)`);
        } else {
          // A genuine overwrite: journal it so --uninstall can put the original
          // back from the pre-install backup instead of deleting the harness copy.
          action = 'overwritten';
          prevHash = destHash;
          log('staging', `update ${f.rel} (destination differs — overwriting; backup + manifest protect you)`);
        }
      }
    } else {
      log('staging', `copy   ${f.rel}`);
    }
    if (action === 'written' || action === 'overwritten') {
      mkdirSync(path.dirname(f.dest), { recursive: true });
      const tmp = `${f.dest}.oc-harness-setup-tmp-${process.pid}`;
      writeFileSync(tmp, readFileSync(f.src));
      atomicInstall(tmp, f.dest);
      written += 1;
    }
    // Preserved entries journal the SRC hash on purpose: --uninstall deletes
    // only on an exact match, so a preserved destination (bytes differ from
    // src) reads as modified → kept, not deleted.
    if (archivedTo) {
      manifest.files.push({ path: f.rel, hash: srcHash, prevHash, action, archivedTo });
    } else if (prevHash) {
      manifest.files.push({ path: f.rel, hash: srcHash, prevHash, action });
    } else {
      manifest.files.push({ path: f.rel, hash: srcHash, action });
    }
  }
  return written;
}

// A prior `skills/<id>/...` path belongs to skill <id>; anything else is not
// a skill path (null). Used to prune stale skill allowlist entries after an
// upgrade retires or archives the skill's files.
function skillIdOf(rel) {
  const parts = String(rel).split(/[\\/]/);
  return parts[0] === 'skills' && parts.length > 2 ? parts[1] : null;
}

// Prune directories left empty, up to (not including) the config dir: a
// stale empty `skills/old/` would otherwise trip the doctor's skill laws (a
// directory with no SKILL.md). Non-empty parents (adopter files inside) stop
// the climb and are kept.
function pruneEmptyParents(base, dir) {
  while (dir !== base && dir.startsWith(base + path.sep)) {
    let ents;
    try {
      ents = readdirSync(dir);
    } catch {
      break;
    }
    if (ents.length) break;
    try {
      rmdirSync(dir);
    } catch {
      break;
    }
    log('retire', `pruned empty dir ${path.relative(base, dir)} (left empty)`);
    dir = path.dirname(dir);
  }
}

// Upgrade sweep: retire pack files the new distro no longer ships (old agent
// roster, old skills/commands/references/scripts). Runs BEFORE staging, so a
// retired path can never collide with an incoming one. Returns the Set of
// retired skill IDs (missing, retired, or archived) so the merge can prune
// their stale allowlist entries. For every prior manifest entry NOT in the
// incoming destination set: `merged` entries (opencode.jsonc) are ignored;
// anything else is resolved inside the config dir. A destination that is
// already gone just contributes its skill ID. Unmodified pack content (bytes
// still equal the prior entry hash) is deleted and journaled as
// { path, hash, action: 'retired' }. Modified content (the adopter owns the
// bytes) is MOVED out of the active tree into the runtime-ignored
// `state/archive/legacy-0.3.x/<rel>` (nextFreePath on collision) and
// journaled as { path, hash, action: 'archived', archivedTo } — nothing is
// destroyed. Unreadable entries are kept and the reason is logged.
// --uninstall restores both kinds from the pre-install backup.
function retireStale(configDir, prior, files, manifest) {
  const retiredSkills = new Set();
  if (!prior || !Array.isArray(prior.files)) return retiredSkills;
  // Incoming rels use the platform join while a prior manifest may spell the
  // same path with the other separator — compare on normalized slashes so a
  // prior entry that the distro still ships is not mistaken for stale.
  // Journaling keeps each entry's own spelling.
  const norm = (p) => String(p).replace(/\\/g, '/');
  const incoming = new Set(files.map((f) => norm(f.rel)));
  const base = path.resolve(configDir);
  for (const entry of prior.files) {
    const rel = String(entry.path || '');
    if (!rel || incoming.has(norm(rel))) continue;
    if (entry.action === 'merged') continue;
    if (entry.action === 'retired' || entry.action === 'archived') {
      // An earlier run already settled this path; its skill stays pruned.
      const settled = skillIdOf(rel);
      if (settled) retiredSkills.add(settled);
      continue;
    }
    const resolved = path.resolve(base, rel);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      log('retire', `skip   ${rel} (escapes the config dir — refusing)`);
      continue;
    }
    const skillId = skillIdOf(rel);
    if (!existsSync(resolved)) {
      if (skillId) retiredSkills.add(skillId);
      log('retire', `absent ${rel} (already gone — nothing to retire)`);
      continue;
    }
    try {
      if (!statSync(resolved).isFile()) {
        log('retire', `keep   ${rel} (not a file — refusing)`);
        continue;
      }
    } catch {
      log('retire', `keep   ${rel} (unreadable — refusing)`);
      continue;
    }
    if (entry.hash && sha256File(resolved) === entry.hash) {
      rmSync(resolved, { force: true });
      manifest.files.push({ path: rel, hash: entry.hash, action: 'retired' });
      if (skillId) retiredSkills.add(skillId);
      log('retire', `retired ${rel} (unmodified pack content from the prior install — journaled for uninstall restore)`);
      pruneEmptyParents(base, path.dirname(resolved));
    } else if (entry.hash) {
      const archivedTo = path.join('state', 'archive', 'legacy-0.3.x', rel);
      const dest = nextFreePath(path.join(base, archivedTo));
      mkdirSync(path.dirname(dest), { recursive: true });
      renameSync(resolved, dest);
      const relArchivedTo = path.relative(base, dest);
      manifest.files.push({ path: rel, hash: entry.hash, action: 'archived', archivedTo: relArchivedTo });
      if (skillId) retiredSkills.add(skillId);
      log('retire', `archived ${rel} → ${relArchivedTo} (modified since install — moved out of the active tree; journaled for uninstall restore)`);
      pruneEmptyParents(base, path.dirname(resolved));
    } else {
      log('retire', `keep   ${rel} (no prior hash to compare — adopter owns it now)`);
    }
  }
  return retiredSkills;
}

/* ---------------------------- opencode.jsonc merge ------------------------- */

function stripJsonc(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function dropTrailingCommas(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue; // trailing comma
    }
    out += c;
  }
  return out;
}

function parseJsonc(text, what) {
  try {
    return JSON.parse(dropTrailingCommas(stripJsonc(text)));
  } catch (err) {
    bail(`${what} is not valid JSONC: ${err.message}`);
  }
}

function mergeJsonc(configDir, backupPath, manifest, retiredSkills = new Set(), prior = null) {
  const distroPath = path.join(PKG_ROOT, 'opencode.jsonc');
  if (!existsSync(distroPath)) {
    log('merge', 'note: this package ships no opencode.jsonc — no merge to do');
    return;
  }
  // Output is always opencode.jsonc (the canonical file the doctor grades).
  // Input prefers the adopter's opencode.jsonc; when only opencode.json exists
  // we merge THAT, rather than ignoring the adopter's real config.
  const targetPath = path.join(configDir, 'opencode.jsonc');
  const jsonPath = path.join(configDir, 'opencode.json');
  const sourcePath = existsSync(targetPath) ? targetPath : existsSync(jsonPath) ? jsonPath : null;
  if (sourcePath === jsonPath) {
    console.warn(
      `[warn] merge: found ${jsonPath} but no opencode.jsonc — merging it into a freshly written opencode.jsonc. ` +
        'Your opencode.json is left untouched; reconcile or remove it so the two cannot drift.'
    );
  }

  const merged = structuredClone(
    parseJsonc(readFileSync(distroPath, 'utf8'), 'the shipped opencode.jsonc (this package build looks broken)')
  );
  const priorIsOlder = !!(prior && prior.version && versionLess(String(prior.version), pkgVersion()));
  const distroRefKeys = new Set(Object.keys(merged.references ?? {}));
  const preserved = [];
  if (sourcePath) {
    const user = parseJsonc(
      readFileSync(sourcePath, 'utf8'),
      `your existing ${path.basename(sourcePath)} — aborting before any write; your config is untouched (backup: ${backupPath})`
    );
    const userPerms = Array.isArray(user.permissions) ? user.permissions : null;
    if (user.permissions !== undefined && !userPerms) {
      console.warn('[warn] merge: your "permissions" is not an array (v2 expects an array of {action,resource,effect}) — harness denies kept; fix your rules manually.');
    }
    for (const k of Object.keys(user)) {
      if (INSTALL_OWNED.includes(k)) continue; // distro value wins outright
      if (k === 'permissions') {
        if (!userPerms) continue;
        // Ordered union, deny-last. Under last-match-wins an adopter's rule must
        // sit AFTER the harness's allow/ask rules (whose leading `shell *` allow
        // would otherwise neutralise an adopter `shell … deny`), and every
        // harness HARD DENY must stay after both so nothing can shadow it
        // (Law 12). The `skill` action is exempt from the move: its fail-closed
        // allowlist is `skill * → deny` FOLLOWED by one allow per local skill
        // (Law 9 requires the wildcard deny; Law 12 exempts the action), so
        // moving that deny last would deny every known skill. Skill rules keep
        // their shipped relative order in the head.
        // Rules identical to a harness rule are dropped from the adopter's side
        // and kept from the harness's, so a re-run reproduces the same array
        // exactly (a plain concat would double it on every run).
        const distroPerms = Array.isArray(merged.permissions) ? merged.permissions : [];
        const sameRule = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const isHardDeny = (p) => !!p && p.effect === 'deny' && p.action !== 'skill';
        const distroHead = distroPerms.filter((p) => !isHardDeny(p));
        const distroTail = distroPerms.filter(isHardDeny);
        // Stale skill allows die with their skills: an adopter allow for a
        // retired/archived skill would otherwise dangle (Law 14 fails a
        // dangling allow). Custom adopter allows for live skills pass through.
        const droppedStaleAllows = [];
        const userOnly = userPerms.filter((p) => {
          if (distroPerms.some((d) => sameRule(d, p))) return false;
          if (
            p && p.action === 'skill' && p.effect === 'allow' &&
            typeof p.resource === 'string' && p.resource !== '*' &&
            retiredSkills.has(p.resource)
          ) {
            droppedStaleAllows.push(p.resource);
            return false;
          }
          return true;
        });
        if (droppedStaleAllows.length) {
          log('merge', `dropped stale skill allows for retired skills: ${droppedStaleAllows.join(', ')}`);
        }
        merged.permissions = [...distroHead, ...userOnly, ...distroTail];
      } else if (UNION_KEYS.includes(k)) {
        let next;
        if (Array.isArray(user[k])) {
          next = [...new Set([...(Array.isArray(merged[k]) ? merged[k] : []), ...user[k]])];
        } else {
          next = user[k];
        }
        if (k === 'plugins' && priorIsOlder && Array.isArray(next)) {
          const isDistroPlugin = (e) => {
            const raw = Array.isArray(e) ? e[0] : e;
            return DISTRO_PLUGIN_IDS.includes(String(raw ?? '').split('@')[0]);
          };
          for (const d of next.filter(isDistroPlugin)) {
            const raw = Array.isArray(d) ? d[0] : d;
            log('merge', `dropped the retired distro plugin ${String(raw ?? '').split('@')[0]} (this version ships no plugin; your own plugin entries are kept)`);
          }
          next = next.filter((e) => !isDistroPlugin(e));
        }
        merged[k] = next;
      } else if (k === 'references') {
        // Object union: distro keys + user-only keys.
        merged.references = { ...(user.references ?? {}), ...(merged.references ?? {}) };
      } else {
        merged[k] = user[k]; // adopter value wins
      }
      preserved.push(k);
    }
  } else {
    log('merge', 'no existing opencode.jsonc/opencode.json — writing the harness base');
  }
  // Reference registry: point ONLY the distro's keys at the resolved config
  // dir (portable `~` form under home, absolute otherwise; forward slashes).
  // User-only reference keys are never touched.
  if (merged.references && typeof merged.references === 'object' && distroRefKeys.size) {
    const resolved = path.resolve(configDir);
    const home = homedir();
    let portable;
    if (home && (resolved === home || resolved.startsWith(home + path.sep))) {
      const rel = path.relative(home, resolved).split(path.sep).join('/');
      portable = rel ? `~/${rel}` : '~';
    } else {
      portable = resolved.split(path.sep).join('/');
    }
    for (const key of distroRefKeys) {
      const entry = merged.references[key];
      if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
        entry.path = portable;
      }
    }
  }
  // JSON.stringify strips comments, including the marker the doctor's Law 11
  // cites as evidence — reinsert it so the merged file still documents the
  // deny gate (the law grades the rules; the marker keeps its cited evidence).
  const denyEvidence =
    '  // Hard stops. `ask` is auto-approved under --auto, so `deny` is the only gate\n' +
    '  // that holds while you are away. Keep this set minimal and last.\n';
  const mergedText = JSON.stringify(merged, null, 2).replace(
    '  "permissions": [\n',
    `  "permissions": [\n${denyEvidence}`
  );
  const out = `${mergedText}\n`;
  mkdirSync(configDir, { recursive: true });
  const tmp = `${targetPath}.oc-harness-setup-tmp-${process.pid}`;
  writeFileSync(tmp, out);
  atomicInstall(tmp, targetPath);
  manifest.files.push({ path: 'opencode.jsonc', hash: sha256Text(out), action: 'merged' });
  log(
    'merge',
    `ownership — install-owned (distro wins): ${INSTALL_OWNED.join(', ')} · union: ${[...UNION_KEYS, 'references'].join(', ')} · your keys preserved: ${preserved.length}${preserved.length ? ` (${preserved.join(', ')})` : ''}`
  );
  log('merge', `rewrote ${targetPath} (distro base + your keys; permissions = harness allows, yours, harness denies last)`);
}

/* ------------------------------ author-leak lint --------------------------- */

// Lints the PACKAGE source (files[].src) and nothing else. The adopter's config
// is never a lint target, so a valid config — including a DOCS-SANCTIONED
// `{file:~/.secrets/…}` apiKey pointer — can never trip this abort. Called
// pre-write, so a hit aborts before anything lands.
function lintPackagedSource(files) {
  const hits = [];
  for (const f of files) {
    if (!f.src || !existsSync(f.src)) continue;
    const low = readFileSync(f.src, 'utf8').toLowerCase();
    // No `break`: a file can carry more than one marker, and reporting only the
    // first hides the rest of the leak.
    for (const pat of LINT_PATTERNS) {
      if (pat.test.test(low)) hits.push({ file: f.rel, pattern: pat.label });
    }
  }
  return hits;
}

/* --------------------------------- doctor ---------------------------------- */

function pwshProbe() {
  const probe = exec('pwsh', ['-NoProfile', '-Command', 'exit 0'], true);
  return { usable: !(probe.error || probe.status !== 0) };
}

function doctorPlan() {
  return pwshProbe().usable
    ? 'run scripts/harness-doctor.ps1 via pwsh'
    : 'pwsh missing — doctor SKIPPED, 18 laws UNVERIFIED (warned + journaled)';
}

function runDoctor(configDir, probe) {
  if (!probe.usable) {
    console.warn('[doctor] WARNING: pwsh (PowerShell 7) was not found — harness-doctor did NOT run, so the 18 laws are UNVERIFIED.');
    console.warn('[doctor] Your config still landed, and the skip is recorded in the manifest. To verify later:');
    console.log('    winget install --id Microsoft.PowerShell --source winget   (Windows)');
    console.log('    then re-run: npx oc-harness-setup setup');
    return { code: 0, skipped: true };
  }
  const script = path.join(configDir, 'scripts', 'harness-doctor.ps1');
  if (!existsSync(script)) {
    console.warn(`[doctor] WARNING: ${script} not found — harness-doctor did NOT run, so the 18 laws are UNVERIFIED.`);
    return { code: 0, skipped: true };
  }
  log('doctor', `running ${script}`);
  const res = exec('pwsh', ['-NoProfile', '-File', script, '-ConfigDir', configDir], false);
  if (res.error || res.status !== 0) {
    log(
      'doctor',
      `harness-doctor exited ${res.error ? 'with an error' : `${res.status}`} — fix the issue, then re-run setup (idempotent)`
    );
    return { code: 1, skipped: false };
  }
  log('doctor', 'harness-doctor passed');
  return { code: 0, skipped: false };
}

/* --------------------------- manifest print (gate) ------------------------- */

function printManifest(configDir, files, backupPath, doctor) {
  const newCount = files.filter((f) => !existsSync(f.dest)).length;
  const sameCount = files.length - newCount;
  console.log('----------------------------- install manifest -----------------------------');
  console.log(`  destination config dir : ${configDir}`);
  console.log(`  incoming files         : ${files.length} (${newCount} new, ${sameCount} already identical — rerun-safe)`);
  console.log(`  backup path            : ${backupPath}`);
  console.log('  opencode.jsonc merge   : distro base (permissions/deny block, policies block, skill allowlist,');
  console.log('                            default_agent: "orchestrator", references registry)');
  console.log('                            + your keys kept · permissions: harness allows, yours, harness denies last');
  console.log('  state-seed/ -> state/   : shipped seed maps to live state/ (state/lessons.md is preserved;');
  console.log('                            state/template.md is pack-owned, and an edited copy is archived under state/archive/ then replaced)');
  console.log(`  doctor plan            : harness-doctor, 18 laws — ${doctor}`);
  console.log('----------------------------------------------------------------------------');
}

async function confirmProceed() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer = '';
  try {
    answer = (await rl.question('Type y to continue (anything else aborts; nothing is touched): ')).trim().toLowerCase();
  } catch {
    answer = ''; // stdin closed (EOF) — treat as abort
  } finally {
    rl.close();
  }
  return answer === 'y' || answer === 'yes';
}

/* -------------------------------- uninstall -------------------------------- */

function uninstall(configDir, opts = {}) {
  // F3: --dry-run / --ci preview what would be removed and return 0 without
  // deleting (setup --uninstall --dry-run must touch nothing).
  assertWindows();
  const preview = !!(opts.preview || opts.dryRun || opts.ci);
  const manifestPath = path.join(configDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    bail(
      `no ${MANIFEST_FILE} found in ${configDir} — nothing to uninstall (an install may already have been removed, or the config dir moved).`
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    bail(`could not read ${manifestPath}: ${err.message} — inspect it manually before touching anything.`);
  }
  const base = path.resolve(configDir);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.length) bail(`manifest at ${manifestPath} lists no files — refusing a blind cleanup.`);
  const backupRoot = manifest.backupPath ? path.resolve(String(manifest.backupPath)) : null;
  let removed = 0;
  let restored = 0;
  let kept = 0;
  let preserved = 0;
  let missing = 0;
  for (const entry of files) {
    const rel = String(entry.path || '');
    const resolved = path.resolve(base, rel);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      log('uninstall', `skip   ${rel} (escapes the config dir — refusing)`);
      continue;
    }
    if (entry.action === 'retired') {
      // An upgrade retired this path: it is gone from the new distro. If the
      // adopter never recreated it, put the pre-install original back from
      // the backup; if they recreated it, it is theirs now — keep it.
      if (!existsSync(resolved)) {
        const original = backupRoot ? path.join(backupRoot, rel) : null;
        if (original && existsSync(original)) {
          if (preview) {
            restored += 1;
            log('uninstall', `would restore ${rel} (retired by upgrade — your pre-install file, from ${manifest.backupPath})`);
          } else {
            mkdirSync(path.dirname(resolved), { recursive: true });
            cpSync(original, resolved, { force: true });
            restored += 1;
            log('uninstall', `restored ${rel} (retired by upgrade — your pre-install file, from ${manifest.backupPath})`);
          }
        } else {
          missing += 1;
          log('uninstall', `missing ${rel} (retired by upgrade and no backup holds it — nothing to restore)`);
        }
      } else {
        kept += 1;
        log('uninstall', `kept   ${rel} (you recreated it after the upgrade retired it — keeping)`);
      }
      continue;
    }
    if (entry.action === 'archived') {
      // An upgrade archived this path (you had modified it): the live bytes
      // moved to state/archive/ and the active path went away. If the active
      // path is still absent, put the pre-install original back from the
      // backup; if you recreated it, it is yours now — keep it. Either way
      // the archive path is reported so your bytes stay findable.
      const archivedTo = entry.archivedTo ? String(entry.archivedTo) : null;
      const archiveNote = archivedTo ? ` (your modified bytes live at ${archivedTo})` : '';
      if (!existsSync(resolved)) {
        const original = backupRoot ? path.join(backupRoot, rel) : null;
        if (original && existsSync(original)) {
          if (preview) {
            restored += 1;
            log('uninstall', `would restore ${rel} (archived by upgrade — your pre-install file, from ${manifest.backupPath})${archiveNote}`);
          } else {
            mkdirSync(path.dirname(resolved), { recursive: true });
            cpSync(original, resolved, { force: true });
            restored += 1;
            log('uninstall', `restored ${rel} (archived by upgrade — your pre-install file, from ${manifest.backupPath})${archiveNote}`);
          }
        } else {
          missing += 1;
          log('uninstall', `missing ${rel} (archived by upgrade and no backup holds it — nothing to restore)${archiveNote}`);
        }
      } else {
        kept += 1;
        log('uninstall', `kept   ${rel} (you recreated it after the upgrade archived it — keeping)${archiveNote}`);
      }
      continue;
    }
    if (!existsSync(resolved)) {
      missing += 1;
      continue;
    }
    if (entry.action === 'overwritten' || entry.action === 'merged') {
      // A genuine overwrite comes back from the pre-install backup; the merged
      // opencode.jsonc is never deleted — restore the adopter's original, or
      // leave the harness copy in place when no backup holds it. An
      // `archivedTo` entry additionally keeps the pre-upgrade bytes in the
      // runtime archive and says so.
      const original = backupRoot ? path.join(backupRoot, rel) : null;
      const archiveNote = entry.archivedTo ? ` (pre-upgrade archive kept at ${entry.archivedTo})` : null;
      if (original && existsSync(original)) {
        // Restoring is only reversible if the bytes being replaced survive. When
        // the current file is not the one the installer wrote (hash differs, or
        // none was journaled) it holds post-install edits — copy it aside before
        // the restore overwrites it. Byte-identical installer output needs no
        // copy.
        if (!entry.hash || sha256File(resolved) !== entry.hash) {
          if (preview) {
            preserved += 1;
            log('uninstall', `would keep ${path.relative(base, nextFreePath(`${resolved}.replaced-${tsStamp()}`))} (your post-install edits — would copy before restore)`);
          } else {
            const keep = nextFreePath(`${resolved}.replaced-${tsStamp()}`);
            cpSync(resolved, keep);
            preserved += 1;
            log('uninstall', `kept   ${path.relative(base, keep)} (your post-install edits — copied before restore)`);
          }
        }
        if (preview) {
          restored += 1;
          log('uninstall', `would restore ${rel} (your pre-install file, from ${manifest.backupPath})${archiveNote || ''}`);
        } else {
          cpSync(original, resolved, { force: true });
          restored += 1;
          log('uninstall', `restored ${rel} (your pre-install file, from ${manifest.backupPath})${archiveNote || ''}`);
        }
      } else if (entry.action === 'merged' && entry.hash && sha256File(resolved) === entry.hash) {
        // F5: installer-created merge output (adopter had only opencode.json,
        // so no backup holds opencode.jsonc) still hashes to what was written
        // — it is pure installer output, so delete it; keep only user-modified.
        if (preview) {
          removed += 1;
          log('uninstall', `would remove ${rel} (installer-created merge output — no pre-install file to restore)`);
        } else {
          rmSync(resolved, { force: true });
          removed += 1;
          log('uninstall', `removed ${rel} (installer-created merge output — no pre-install file to restore)`);
        }
      } else {
        kept += 1;
        log('uninstall', `${preview ? 'would keep' : 'kept  '} ${rel} (WARNING: no backup at ${original || '(no backupPath recorded)'} — not deleted)`);
      }
      continue;
    }
    if (entry.hash && sha256File(resolved) === entry.hash) {
      if (preview) {
        removed += 1;
        log('uninstall', `would remove ${rel}`);
      } else {
        rmSync(resolved, { force: true });
        removed += 1;
        log('uninstall', `removed ${rel}`);
      }
    } else {
      kept += 1;
      log('uninstall', `kept   ${rel} (you modified it — hash differs)`);
    }
  }
  if (preview) {
    log('uninstall', `would remove ${removed}, would restore ${restored} overwritten, would keep ${kept} modified, preserved ${preserved} edit-copies, already-missing ${missing}`);
    console.log('[dry-run] preview only — nothing was touched.');
  } else {
    rmSync(manifestPath, { force: true });
    log('uninstall', `removed ${removed}, restored ${restored} overwritten, kept ${kept} modified, preserved ${preserved} edit-copies, already-missing ${missing}`);
  }
  console.log(`  backup (pre-install config dir): ${manifest.backupPath || '(none recorded)'}`);
  if (manifest.priorBackup) console.log(`  later snapshot (kept for the chain): ${manifest.priorBackup}`);
  console.log('  to restore it fully, replace the current config dir with that backup.');
  if (preserved > 0) {
    console.log(`  ${preserved} post-install edit-copy(ies) written beside the restored file(s) as <name>.replaced-<ts> (listed above).`);
  }
  if (manifest.doctorSkipped) {
    console.log('  note: this install skipped the doctor — the 18 laws were never verified.');
  }
}

/* ---------------------------------- setup ---------------------------------- */

function writeManifest(configDir, manifest) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

// R4: a re-run must not erase what an earlier run knew. A file this run sees as
// "skip" may have been an overwrite two runs ago; downgrading it to "skip" would
// make --uninstall delete the adopter's original instead of restoring it. Keep
// the earliest truth: overwritten stays overwritten (with the ORIGINAL prevHash),
// preserved stays preserved.
function carryForwardJournal(manifest, prior) {
  if (!prior || !Array.isArray(prior.files)) return;
  // Prior manifests may spell paths with either separator.
  const norm = (p) => String(p).replace(/\\/g, '/');
  const before = new Map(prior.files.map((f) => [norm(f.path), f]));
  for (const e of manifest.files) {
    if (e.action === 'retired' || e.action === 'archived') continue; // a retirement/archive is this run's truth, never downgraded
    const p = before.get(norm(e.path));
    if (!p) continue;
    if (p.action === 'retired' || p.action === 'archived') continue; // a path the prior run settled that this run re-ships is fresh staging, not a settlement
    if (p.action === 'overwritten') {
      e.action = 'overwritten';
      e.prevHash = p.prevHash || e.prevHash;
    } else if (p.action === 'preserved' && e.action !== 'overwritten') {
      e.action = 'preserved';
    }
  }
  // A re-run must not forget what an earlier run settled: those paths are
  // already deleted or archived and absent from this run's staging, but
  // --uninstall still needs them to restore the pre-install originals from
  // the backup chain.
  const now = new Set(manifest.files.map((f) => norm(f.path)));
  for (const p of prior.files) {
    if ((p.action === 'retired' || p.action === 'archived') && !now.has(norm(p.path))) {
      manifest.files.push(p);
      now.add(norm(p.path));
    }
  }
}

function readManifest(configDir) {
  const p = path.join(configDir, MANIFEST_FILE);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null; // an unreadable manifest is not a reason to abort — a fresh one is written
  }
}

function warnConfigTargets(configDir) {
  if (process.env.OPENCODE_CONFIG) {
    console.warn(
      `[warn] OPENCODE_CONFIG is set (${process.env.OPENCODE_CONFIG}) — it loads ABOVE the global config and may shadow this merge; check 'opencode debug config' after install.`
    );
  }
  const own = new Set([
    path.resolve(configDir, 'opencode.jsonc'),
    path.resolve(configDir, 'opencode.json'),
  ]);
  let dir = path.resolve(process.cwd());
  for (;;) {
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      const p = path.join(dir, name);
      if (existsSync(p) && !own.has(path.resolve(p))) {
        console.warn(
          `[warn] project config ${p} outranks the global config — it may shadow this merge for sessions started in ${dir} or below (warn only; nothing changes).`
        );
        return;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

// F6: sweep installer crash litter (*.oc-harness-setup-tmp-*) left if killed
// between writeFileSync and renameSync. The infix `.oc-harness-setup-tmp-`
// never appears in real user files (opencode.jsonc, agents/*.md, …), so the
// sweep is unambiguous installer junk. Runs only on the mutating path (never
// under --dry-run / --ci, which promise to touch nothing).
function sweepTmpLitter(configDir) {
  if (!existsSync(configDir)) return 0;
  try {
    if (!statSync(configDir).isDirectory()) return 0;
  } catch {
    return 0;
  }
  let swept = 0;
  const walk = (dir) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.includes('.oc-harness-setup-tmp-')) {
        try {
          rmSync(p, { force: true });
          swept += 1;
          log('sweep', `removed crash litter ${path.relative(configDir, p)}`);
        } catch {}
      }
    }
  };
  walk(configDir);
  return swept;
}

// F1: validate every JSONC parse BEFORE any write, so a broken config bails
// before staging overwrites live files (no manifest => uninstall could not restore).
function validateJsoncInputs(configDir, backupPath) {
  const distroPath = path.join(PKG_ROOT, 'opencode.jsonc');
  if (existsSync(distroPath)) {
    parseJsonc(
      readFileSync(distroPath, 'utf8'),
      'the shipped opencode.jsonc (this package build looks broken)'
    );
  }
  const targetPath = path.join(configDir, 'opencode.jsonc');
  const jsonPath = path.join(configDir, 'opencode.json');
  const sourcePath = existsSync(targetPath) ? targetPath : existsSync(jsonPath) ? jsonPath : null;
  if (sourcePath) {
    parseJsonc(
      readFileSync(sourcePath, 'utf8'),
      `your existing ${path.basename(sourcePath)} — aborting before any write; your config is untouched (backup: ${backupPath})`
    );
  }
}

async function setup(opts) {
  assertWindows();
  // F2: --ci / --dry-run promise print-only exit 0 with no mutation — honour
  // them BEFORE preflight(), which bails without the opencode binary (exactly
  // the headless case --ci exists for). Read-only manifest path only.
  if (opts.ci || opts.dryRun) {
    const configDir = findConfigDir();
    const files = collectIncoming(configDir);
    const prior = readManifest(configDir); // read-only
    const newBackupPath = nextBackupPath(configDir);
    const backupPath = prior && prior.backupPath ? prior.backupPath : newBackupPath;
    printManifest(configDir, files, backupPath, doctorPlan());
    if (opts.dryRun) {
      console.log('[dry-run] manifest only — nothing was touched.');
      return 0;
    }
    console.log('[ci] refusing to mutate — print-only. Run setup interactively to install.');
    return 0;
  }
  preflight();
  const configDir = findConfigDir();
  warnConfigTargets(configDir);
  const files = collectIncoming(configDir);

  // Author-leak lint runs PRE-write, over the PACKAGE source only. A hit aborts
  // before the consent gate, so nothing lands and the adopter's config (which
  // is never linted) can never trip it.
  const hits = lintPackagedSource(files);
  if (hits.length) {
    for (const h of hits) console.error(`[lint] author-leak marker "${h.pattern}" found in ${h.file}`);
    bail(
      `author-leak markers found in the packaged source (${hits.length} file(s) listed above) — this package build is corrupted; NOTHING was written. Reinstall from npm.`
    );
  }

  const prior = readManifest(configDir); // read-only
  if (!prior) {
    console.warn('[warn] no prior install manifest — old 0.3.x files are not auto-retired; review them manually before relying on a clean tree.');
  }
  const newBackupPath = nextBackupPath(configDir);
  // R4(d): a re-run must never re-point the original backup — that snapshot has
  // already been mutated by the previous install, so restoring from it would be
  // a lie. Keep the original pointer; chain the new snapshot as priorBackup.
  const backupPath = prior && prior.backupPath ? prior.backupPath : newBackupPath;
  const doctorProbe = pwshProbe(); // read-only probe
  printManifest(configDir, files, backupPath, doctorPlan());

  // (F2: --dry-run / --ci already returned print-only before preflight.)
  if (!(await confirmProceed())) {
    console.log('[gate] aborted — nothing was modified.');
    return 0;
  }

  /* ---------------- mutations begin (all journaled) ---------------- */
  // F1: every parse validated BEFORE the first write — a broken config bails
  // here, before staging overwrites live files.
  validateJsoncInputs(configDir, backupPath);
  // F6: sweep unambiguous installer crash litter before the first write.
  sweepTmpLitter(configDir);
  const backup = makeBackup(configDir, newBackupPath);
  const manifest = {
    package: PKG_NAME,
    version: pkgVersion(),
    created: new Date().toISOString(),
    configDir,
    backupPath: backupPath,
    ...(prior && prior.backupPath ? { priorBackup: backup } : {}),
    files: [],
  };

  const retiredSkills = retireStale(configDir, prior, files, manifest);
  if (retiredSkills.size) log('retire', `${retiredSkills.size} stale skill id(s) retired — their allowlist entries are pruned from the merge (${[...retiredSkills].join(', ')})`);
  stageFiles(files, manifest, prior, configDir);
  carryForwardJournal(manifest, prior);
  // An adopter's own plugins[] entries survive the merge via UNION_KEYS; the
  // distro ships no plugins of its own, so there is nothing to register here.
  mergeJsonc(configDir, backup, manifest, retiredSkills, prior);

  // R6: record the skip in the journal so "all 18 laws unrun" is never silent.
  manifest.doctorSkipped = !doctorProbe.usable || !existsSync(path.join(configDir, 'scripts', 'harness-doctor.ps1'));
  writeManifest(configDir, manifest);
  log('manifest', `journal written: ${path.join(configDir, MANIFEST_FILE)}`);

  const doctorResult = runDoctor(configDir, doctorProbe);
  if (doctorResult.code !== 0) return 1;

  console.log();
  console.log('-------------------------------- summary ---------------------------------');
  console.log('  installed: agents/, commands/, skills/, reference/, scripts/, .docs/, state/ (from state-seed/), AGENTS.md, GLOSSARY.md + merged opencode.jsonc');
  console.log(`  backup   : ${manifest.backupPath}${manifest.priorBackup ? `\n  snapshot : ${manifest.priorBackup} (chained — backup() pointer above is the original)` : ''}`);
  if (manifest.doctorSkipped) {
    console.log('  doctor   : ⚠ SKIPPED — the 18 laws were NOT verified (journaled as doctorSkipped; install PowerShell 7 and re-run to verify)');
  }
  console.log('  undo     : npx oc-harness-setup setup --uninstall');
  console.log('  restart  : restart your OpenCode session so the new agents/commands/skills load.');
  console.log('----------------------------------------------------------------------------');
  return 0;
}

/* --------------------------------- entry ---------------------------------- */

function parseArgs(argv) {
  const opts = { command: 'setup', dryRun: false, ci: false, uninstall: false };
  for (const a of argv) {
    switch (a) {
      case 'setup':
        opts.command = 'setup';
        break;
      case '--version':
      case '-v':
        console.log(pkgVersion());
        process.exitCode = 0;
        return null;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--ci':
        opts.ci = true;
        break;
      case '--uninstall':
        opts.uninstall = true;
        break;
      case '--help':
      case '-h':
        usage();
        process.exitCode = 0;
        return null;
      default:
        usage();
        bail(`unknown argument: ${a}`);
        return null;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;
  if (opts.uninstall) {
    const configDir = findConfigDir();
    // F3: honour --dry-run / --ci in the uninstall branch — preview only.
    if (opts.dryRun || opts.ci) {
      uninstall(configDir, { preview: true });
      return;
    }
    uninstall(configDir);
    return;
  }
  const code = await setup(opts);
  if (code !== 0) process.exitCode = code;
}

main().catch((err) => {
  if (!(err instanceof Bail)) console.error(`[fatal] ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});