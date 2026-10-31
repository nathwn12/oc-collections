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
//   INSTALL_OWNED — the distro supplies a default; on a collision the adopter's
//                   value wins and the collided key is reported by name.
//   DENY_OWNED    — the hard tool.use deny block. Unioned with the adopter's
//                   entries, distro denies last, so a user rule can be added but
//                   can never shadow a shipped deny.
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
const INSTALL_OWNED = ['$schema', 'default_agent', 'formatter', 'compaction', 'tool_output', 'media', 'watcher'];
const DENY_OWNED = ['policies'];
const UNION_KEYS = ['plugins'];
const DISTRO_PLUGIN_IDS = ['oc-flight-deck'];

// `plugins` element truth for OpenCode 2.2.0, measured against the installed
// host (`opencode v2.2.0`, `opencode debug config`): an entry must be a
// specifier STRING — an npm name, `name@version`, `github:owner/repo#ref
// ::path:pkg`, or a local `.ts` path. The 1.x `[specifier, options]` tuple is
// DROPPED by the 2.2.0 schema (so the plugin silently stops loading), and a
// non-string is dropped too. A tuple is therefore reduced to its specifier —
// 2.2.0 has nowhere to express the options — and every entry that cannot be
// expressed is reported, never written into a config the host would ignore.
function pluginSpecifier(entry) {
  if (typeof entry === 'string') {
    const s = entry.trim();
    return s ? s : null;
  }
  if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].trim()) {
    return entry[0].trim();
  }
  return null;
}

// Bare id of a specifier without mangling a scoped name: strip only a version
// suffix after the first character (`pkg@1.2.3` → `pkg`, `@scope/pkg@1.2.3`
// → `@scope/pkg`), and leave a `github:`/path specifier untouched.
function pluginIdOf(spec) {
  const s = String(spec ?? '');
  const at = s.indexOf('@', 1);
  return at > 0 ? s.slice(0, at) : s;
}

// Reduce, dedupe (order preserved), and report 1.x plugin entries so a re-run
// produces byte-identical output and nothing the host would drop survives.
function normalizePluginEntries(entries) {
  const out = [];
  for (const entry of entries) {
    const spec = pluginSpecifier(entry);
    if (spec === null) {
      log('merge', `dropped an unrepresentable plugins entry ${JSON.stringify(entry)} — OpenCode 2.2.0 accepts specifier strings only`);
      continue;
    }
    if (Array.isArray(entry)) {
      log('merge', `normalized the 1.x plugin tuple ${JSON.stringify(entry)} → "${spec}" (OpenCode 2.2.0 drops tuple entries; per-plugin options cannot be carried)`);
    }
    if (out.includes(spec)) continue;
    out.push(spec);
  }
  return out;
}

// Every shipped file follows one decision table (classifyDest): new bytes land
// in place only where the destination still matches what we installed. A
// destination that cannot be proven package-owned is the adopter's file, so it
// is never overwritten — the new version lands beside it as `<name>.new`.
//
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

// Write bytes through the atomic replace, so a crash never leaves the
// destination deleted with the new copy orphaned as tmp.
function installBytes(dest, buf) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.oc-harness-setup-tmp-${process.pid}`;
  writeFileSync(tmp, buf);
  atomicInstall(tmp, dest);
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
// the Node doctor, and registers Windows shell policy — there is no
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
  // The 2.2.0 host prints exactly `opencode v2.2.0`; parse the version out of
  // the banner instead of echoing the whole line (which logged the product name
  // twice) and instead of accepting ANY version: the merged config uses the
  // 2.2.0 dialect, so a 1.x host would silently drop `plugins[]` tuples,
  // `permissions[]` and `policies[]` rather than honour them.
  const banner = (res.stdout || '').trim().split(/\r?\n/)[0] || '';
  const m = banner.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    bail(`could not read an OpenCode version from '${banner || 'no output'}' — expected 'opencode v2.2.0' or newer. Check 'opencode --version' by hand.`);
  }
  const host = { raw: `${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]), minor: Number(m[2]) };
  if (host.major < 2) {
    bail(
      `OpenCode ${host.raw} speaks the 1.x config dialect (@opencode-ai/* plugins, an object \`permission\` block), not the 2.2.0 shape this package writes ` +
        '(plugins[] of specifier strings, permissions[] of {action,resource,effect}, policies[] with tool.use). Nothing was written. ' +
        'Upgrade first (opencode upgrade), then re-run setup.'
    );
  }
  if (host.minor < 2) {
    console.warn(
      `[warn] preflight: OpenCode ${host.raw} is below the 2.2.0 this package is tested on. The merge writes the 2.2-shaped config ` +
        '(plugins[] as specifier strings, permissions[] of {action,resource,effect}, policies[] with tool.use); ' +
        'on 2.0/2.1 those blocks may be partly ignored, so the deny gate is not proven on this host. ' +
        'The install proceeds — upgrade to 2.2.0 or newer when you can.'
    );
  }
  log('preflight', `opencode ${host.raw} — OK`);
  return host;
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

function stageFiles(files, manifest, prior) {
  // Prior manifests spell paths with either separator; incoming rels use the
  // platform join. Compare on normalized slashes so a prior entry still
  // matches its incoming path (journaling keeps each entry's own spelling).
  const norm = (p) => String(p).replace(/\\/g, '/');
  const priorByPath = new Map(
    (prior && Array.isArray(prior.files) ? prior.files : []).map((f) => [norm(f.path), f])
  );
  const counts = { added: 0, updated: 0, kept: 0, skipped: 0 };
  for (const f of files) {
    const srcHash = sha256File(f.src);
    const verdict = classifyDest(f, srcHash, priorByPath, norm);
    if (verdict.action === 'skip') {
      counts.skipped += 1;
      log('staging', `skip   ${f.rel} (already identical — rerun-safe)`);
      manifest.files.push({ path: f.rel, hash: srcHash, action: 'skip' });
      continue;
    }
    if (verdict.action === 'written') {
      installBytes(f.dest, readFileSync(f.src));
      counts.added += 1;
      log('staging', `copy   ${f.rel}`);
      manifest.files.push({ path: f.rel, hash: srcHash, action: 'written' });
      continue;
    }
    if (verdict.action === 'kept') {
      // The destination is the adopter's file: leave it byte-identical and put
      // the new pack bytes beside it. `newPath` is journaled so --uninstall can
      // sweep the `.new` and so a later run can see the adopter's adoption.
      const newRel = `${norm(f.rel)}.new`;
      const newPath = `${f.dest}.new`;
      if (!(existsSync(newPath) && sha256File(newPath) === srcHash)) {
        installBytes(newPath, readFileSync(f.src));
      }
      counts.kept += 1;
      log('staging', `kept user file ${norm(f.rel)}, wrote ${newRel} (differs from what we installed — your bytes are untouched)`);
      manifest.files.push({ path: f.rel, hash: srcHash, prevHash: verdict.prevHash, action: 'kept', newPath: newRel });
      continue;
    }
    // `overwritten`: the destination still matches the prior installed hash, so
    // it is package-owned content and replacing it IS the upgrade.
    installBytes(f.dest, readFileSync(f.src));
    counts.updated += 1;
    log('staging', `update ${f.rel} (unmodified package content — updated in place; backup + manifest protect you)`);
    manifest.files.push({ path: f.rel, hash: srcHash, prevHash: verdict.prevHash, action: 'overwritten' });
  }
  return counts;
}

// The whole install policy in one place: a destination is only replaced when it
// still carries the bytes we installed. Silence about a path (no prior record)
// proves no ownership, so the adopter keeps it.
//   absent                          → written    (nothing to respect)
//   identical to the pack           → skip       (rerun-safe)
//   identical to the prior install  → overwritten (package-owned; this is the upgrade)
//   anything else                   → kept       (adopter-owned; `.new` lands beside it)
function classifyDest(f, srcHash, priorByPath, norm) {
  if (!existsSync(f.dest)) return { action: 'written' };
  const destHash = sha256File(f.dest);
  if (destHash === srcHash) return { action: 'skip' };
  const prior = priorByPath.get(norm(f.rel));
  if (prior && prior.hash && destHash === prior.hash) {
    return { action: 'overwritten', prevHash: destHash };
  }
  return { action: 'kept', prevHash: destHash };
}

// Read-only twin of stageFiles for the pre-gate manifest: the same decision
// table, counted and never written.
function planCounts(files, prior) {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const priorByPath = new Map(
    (prior && Array.isArray(prior.files) ? prior.files : []).map((f) => [norm(f.path), f])
  );
  const counts = { added: 0, updated: 0, kept: 0, skipped: 0 };
  for (const f of files) {
    const v = classifyDest(f, sha256File(f.src), priorByPath, norm);
    if (v.action === 'written') counts.added += 1;
    else if (v.action === 'overwritten') counts.updated += 1;
    else if (v.action === 'kept') counts.kept += 1;
    else counts.skipped += 1;
  }
  return counts;
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
    if (entry.action === 'kept') {
      // The live path holds the adopter's bytes, not ours — an upgrade must not
      // move it anywhere. Only our own `.new` beside it is retired.
      log('retire', `keep   ${rel} (your file from an earlier install — left in place)`);
      const newRel = entry.newPath ? String(entry.newPath) : `${norm(rel)}.new`;
      const newResolved = path.resolve(base, newRel);
      if (newResolved.startsWith(base + path.sep) && existsSync(newResolved)) {
        try {
          if (entry.hash && sha256File(newResolved) === entry.hash) {
            rmSync(newResolved, { force: true });
            log('retire', `removed ${newRel} (our copy beside your file — this version no longer ships it)`);
          } else {
            log('retire', `keep   ${newRel} (you edited it — left in place)`);
          }
        } catch {
          log('retire', `keep   ${newRel} (unreadable — refusing)`);
        }
      }
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
    let hashMatched = false;
    try { hashMatched = entry.hash ? sha256File(resolved) === entry.hash : false; }
    catch { log('retire', `keep   ${rel} (content read failed — refusing)`); continue; }
    if (entry.hash && hashMatched) {
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

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Additive merge for an install-owned key: the distro value is a default the
// adopter may adopt, never a replacement for their own. Plain objects merge, so
// a subkey the adopter never set still arrives; every collided leaf keeps the
// adopter's value and is named in `collisions` so the report can cite it.
function adoptInstallOwned(distro, user, key, pathParts, collisions) {
  const d = distro[key];
  const u = user[key];
  if (isPlainObject(d) && isPlainObject(u)) {
    for (const sub of Object.keys(u)) adoptInstallOwned(d, u, sub, [...pathParts, sub], collisions);
    return;
  }
  if (JSON.stringify(d) !== JSON.stringify(u)) collisions.push(pathParts.join('.'));
  distro[key] = u;
}

// Deny-owning blocks are additive without being softenable: the adopter's own
// entries ride along, every shipped entry stays, and the shipped entries land
// last so a user allow can never shadow a shipped deny under last-match-wins.
function unionDenyLast(distro, user) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const d = Array.isArray(distro) ? distro : [];
  const u = Array.isArray(user) ? user : [];
  return [...u.filter((r) => !d.some((x) => same(x, r))), ...d];
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
    const ownedCollisions = [];
    for (const k of Object.keys(user)) {
      if (DENY_OWNED.includes(k)) {
        if (!Array.isArray(user[k])) {
          console.warn(`[warn] merge: your "${k}" is not an array — the shipped deny entries are kept and yours cannot be merged; fix your rules manually.`);
        } else {
          merged[k] = unionDenyLast(merged[k], user[k]);
        }
        preserved.push(k);
        continue;
      }
      if (INSTALL_OWNED.includes(k)) {
        adoptInstallOwned(merged, user, k, [k], ownedCollisions);
        preserved.push(k);
        continue;
      }
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
        if (!Array.isArray(user[k])) {
          merged[k] = user[k]; // adopter's non-array value wins verbatim
        } else {
          // `plugins` is the only union key, and it is the one whose element
          // shape changed in 2.2.0: normalize before the union so dedupe works
          // on strings (a tuple would never compare equal across runs and
          // would accumulate).
          merged[k] = normalizePluginEntries([
            ...(Array.isArray(merged[k]) ? merged[k] : []),
            ...user[k],
          ]);
        }
        if (k === 'plugins' && priorIsOlder && Array.isArray(merged[k])) {
          const isDistroPlugin = (e) => DISTRO_PLUGIN_IDS.includes(pluginIdOf(e));
          for (const d of merged[k].filter(isDistroPlugin)) {
            log('merge', `dropped the retired distro plugin ${pluginIdOf(d)} (this version ships no plugin; your own plugin entries are kept)`);
          }
          merged[k] = merged[k].filter((e) => !isDistroPlugin(e));
        }
      } else if (k === 'references') {
        // Object union: distro keys + user-only keys.
        merged.references = { ...(user.references ?? {}), ...(merged.references ?? {}) };
      } else {
        merged[k] = user[k]; // adopter value wins
      }
      preserved.push(k);
    }
    if (ownedCollisions.length) {
      log('merge', `kept your value(s) for install-owned key(s): ${ownedCollisions.join(', ')} — the shipped default is not applied to them (delete the key to adopt it)`);
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
    `ownership — your value wins on a collision for: ${INSTALL_OWNED.join(', ')} · deny block unioned, shipped denies last: ${DENY_OWNED.join(', ')} · union: ${[...UNION_KEYS, 'references'].join(', ')} · your keys preserved: ${preserved.length}${preserved.length ? ` (${preserved.join(', ')})` : ''}`
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

function doctorPlan() {
  return 'run scripts/harness-doctor.mjs via node';
}

function runDoctor(configDir) {
  const script = path.join(configDir, 'scripts', 'harness-doctor.mjs');
  if (!existsSync(script)) {
    console.warn(`[doctor] WARNING: ${script} not found — harness-doctor did NOT run, so the 18 laws are UNVERIFIED.`);
    return { code: 0, skipped: true };
  }
  log('doctor', `running ${script}`);
  const res = exec(process.execPath, [script, '-ConfigDir', configDir], false);
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

function printManifest(configDir, files, backupPath, doctor, prior = null) {
  const newCount = files.filter((f) => !existsSync(f.dest)).length;
  const sameCount = files.length - newCount;
  const plan = planCounts(files, prior);
  console.log('----------------------------- install manifest -----------------------------');
  console.log(`  destination config dir : ${configDir}`);
  console.log(`  incoming files         : ${files.length} (${newCount} new, ${sameCount} already identical — rerun-safe)`);
  console.log(`  policy                 : ${plan.updated} updated in place (unmodified package files) · ${plan.kept} kept + .new written (your files) · ${plan.added} added · ${plan.skipped} skipped (identical)`);
  console.log(`  backup path            : ${backupPath}`);
  console.log('  opencode.jsonc merge   : distro base (permissions/deny block, policies block, skill allowlist,');
  console.log('                            default_agent: "orchestrator", references registry)');
  console.log('                            + your keys kept, your value wins on a collision · permissions: harness allows, yours, harness denies last');
  console.log('  state-seed/ -> state/   : shipped seed maps to live state/ (an edited state file is kept, the seeded copy lands as <name>.new)');
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
    if (entry.action === 'kept') {
      // The live path is the adopter's file — uninstall never removes it. The
      // `.new` beside it is our bytes, so that one goes when it is unmodified.
      kept += 1;
      const newRel = entry.newPath ? String(entry.newPath) : null;
      const newResolved = newRel ? path.resolve(base, newRel) : null;
      const insideBase = newResolved && newResolved.startsWith(base + path.sep);
      if (!insideBase || !existsSync(newResolved)) {
        log('uninstall', `kept   ${rel} (your file — never removed)`);
        continue;
      }
      if (entry.hash && sha256File(newResolved) === entry.hash) {
        if (preview) {
          removed += 1;
          log('uninstall', `would remove ${newRel} (our copy beside your kept file)`);
        } else {
          rmSync(newResolved, { force: true });
          removed += 1;
          log('uninstall', `removed ${newRel} (our copy beside your kept file)`);
        }
      } else {
        kept += 1;
        log('uninstall', `kept   ${newRel} (you edited the new version — keeping it)`);
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
    } else if (p.action === 'kept' && e.action !== 'overwritten') {
      // The adopter's file was never ours; an identical destination (they may
      // have adopted the old `.new`) must not be downgraded to `skip`, or
      // --uninstall would delete a file the harness never wrote.
      e.action = 'kept';
      e.prevHash = p.prevHash || e.prevHash;
      e.newPath = p.newPath || e.newPath;
    } else if (p.action === 'preserved' && e.action !== 'overwritten' && e.action !== 'kept') {
      e.action = 'preserved';
    }
  }
  // A re-run must not forget what an earlier run settled: those paths are
  // already deleted or archived and absent from this run's staging, but
  // --uninstall still needs them to restore the pre-install originals from
  // the backup chain. A kept adopter path the pack no longer ships is carried
  // for the same reason: its `.new` may still be beside it.
  const now = new Set(manifest.files.map((f) => norm(f.path)));
  for (const p of prior.files) {
    const settled = p.action === 'retired' || p.action === 'archived' || p.action === 'kept';
    if (settled && !now.has(norm(p.path))) {
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
    printManifest(configDir, files, backupPath, doctorPlan(), prior);
    if (opts.dryRun) {
      console.log('[dry-run] manifest only — nothing was touched.');
      return 0;
    }
    console.log('[ci] refusing to mutate — print-only. Run setup interactively to install.');
    return 0;
  }
  const host = preflight();
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
  printManifest(configDir, files, backupPath, doctorPlan(), prior);

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
    // The host whose dialect the merged config was written for: recorded so an
    // install's config shapes are auditable against the CLI that will read them.
    hostVersion: host.raw,
    created: new Date().toISOString(),
    configDir,
    backupPath: backupPath,
    ...(prior && prior.backupPath ? { priorBackup: backup } : {}),
    files: [],
  };

  const retiredSkills = retireStale(configDir, prior, files, manifest);
  if (retiredSkills.size) log('retire', `${retiredSkills.size} stale skill id(s) retired — their allowlist entries are pruned from the merge (${[...retiredSkills].join(', ')})`);
  const staged = stageFiles(files, manifest, prior);
  carryForwardJournal(manifest, prior);
  // An adopter's own plugins[] entries survive the merge via UNION_KEYS; the
  // distro ships no plugins of its own, so there is nothing to register here.
  mergeJsonc(configDir, backup, manifest, retiredSkills, prior);

  // R6: record the skip in the journal so "all 18 laws unrun" is never silent.
  manifest.doctorSkipped = !existsSync(path.join(configDir, 'scripts', 'harness-doctor.mjs'));
  writeManifest(configDir, manifest);
  log('manifest', `journal written: ${path.join(configDir, MANIFEST_FILE)}`);

  const doctorResult = runDoctor(configDir);
  if (doctorResult.code !== 0) return 1;

  console.log();
  console.log('-------------------------------- summary ---------------------------------');
  console.log('  installed: agents/, commands/, skills/, reference/, scripts/, .docs/, state/ (from state-seed/), AGENTS.md, GLOSSARY.md + merged opencode.jsonc');
  console.log(`  policy   : ${staged.updated} updated in place (unmodified package files) · ${staged.kept} kept + .new written (your files) · ${staged.added} added · ${staged.skipped} skipped (identical)`);
  if (staged.kept > 0) {
    console.log('  adopt    : the new version of each kept file sits beside it as <name>.new — diff it and move it over when you want it');
  }
  console.log(`  backup   : ${manifest.backupPath}${manifest.priorBackup ? `\n  snapshot : ${manifest.priorBackup} (chained — backup() pointer above is the original)` : ''}`);
  if (manifest.doctorSkipped) {
    console.log('  doctor   : ⚠ SKIPPED — the 18 laws were NOT verified (journaled as doctorSkipped; re-run setup to verify)');
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