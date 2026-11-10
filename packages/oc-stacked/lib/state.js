// The stack's memory: one directory, plain files, greppable after any compaction.
import fs from 'node:fs';
import path from 'node:path';
import { stamps, table } from './text.js';

export const DIR = '.stack';
export const PATHS = {
  root: DIR,
  ledger: `${DIR}/ledger.md`,
  digest: `${DIR}/digest.md`,
  briefs: `${DIR}/briefs`,
  reports: `${DIR}/reports`,
  state: `${DIR}/state`,
  checks: `${DIR}/state/checks.json`,
  briefsIndex: `${DIR}/state/briefs.json`,
  config: `${DIR}/config.json`,
  lock: `${DIR}/state/.lock`,
  gitignore: `${DIR}/.gitignore`,
};

const DEFAULT_CONFIG = {
  checks: [],
  ownership: { ignore: ['.stack/**'] },
};

/** A fresh copy: config() must never hand out the module's own object. */
const defaults = () => ({ checks: [], ownership: { ignore: ['.stack/**'] } });

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Makefile', 'pytest.ini', 'tox.ini'];

/** A synchronous sleep, so lock contention never spins a core. */
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const pause = (ms) => Atomics.wait(sleepCell, 0, 0, ms);

/** JSON.parse that ignores a leading UTF-8 BOM: Notepad writes one, and it is not corruption. */
const parseJson = (raw) => JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);

/** Windows refuses a rename while another handle briefly holds the destination. */
const RENAME_RETRIES = 4;

/**
 * Write a file by writing `<file>.tmp` and renaming it. A crash or a full disk
 * leaves the old file intact instead of a truncated one. Windows fails that
 * rename with EPERM/EACCES/EBUSY while an editor, antivirus or a second session
 * holds the destination, so exactly those codes are retried with a short
 * backoff; any other failure, and the last retry, rethrows with the path named
 * and removes the temp, so a refused write leaves no litter.
 */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const busy = err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY');
      if (busy && attempt < RENAME_RETRIES) {
        pause(10 * 2 ** attempt);
        continue;
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      if (err instanceof Error) err.message = `cannot write ${file}: ${err.message}`;
      throw err;
    }
  }
}

export function ensureStack(dir) {
  for (const key of ['root', 'briefs', 'reports', 'state']) {
    fs.mkdirSync(path.join(dir, PATHS[key]), { recursive: true });
  }
  if (!fs.existsSync(path.join(dir, PATHS.config))) {
    writeAtomic(path.join(dir, PATHS.config), `${JSON.stringify(defaults(), null, 2)}\n`);
  }
}

function corruptConfig() {
  const value = defaults();
  // Non-enumerable: a spread of a corrupt config must not leak the marker into
  // the file seedStack rewrites, and JSON.stringify must never see it.
  Object.defineProperty(value, '__corrupt', { value: true, enumerable: false });
  return value;
}

/** True when config() could not parse the file, so seedStack must rewrite it. */
export const isCorruptConfig = (cfg) => Boolean(cfg && cfg.__corrupt);

export function config(dir) {
  const file = path.join(dir, PATHS.config);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaults();
    return corruptConfig();
  }
  let parsed;
  try {
    parsed = parseJson(raw);
  } catch {
    return corruptConfig();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return corruptConfig();
  return { ...defaults(), ...parsed };
}

/**
 * Read JSON from the stack. Only a missing file returns the fallback; a corrupt
 * file throws with its name, because reading it as empty lets the next write
 * destroy every record it held.
 */
export function readJson(dir, rel, fallback) {
  const file = path.join(dir, rel);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  try {
    return parseJson(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

/** readJson that never throws: `{ value, error }` for gates and display paths. */
export function tryReadJson(dir, rel, fallback) {
  try {
    return { value: readJson(dir, rel, fallback), error: null };
  } catch (err) {
    return { value: fallback, error: err };
  }
}

export function writeJson(dir, rel, value) {
  writeAtomic(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The pid a lock names, or null when it is pid-less (written by an older
 * version), empty or unreadable. A pid-less lock keeps the age rule.
 */
function lockPid(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

/**
 * True only when the lock names a pid that is certain not to exist. `EPERM`
 * means the process is alive but not ours, so it is not gone, and a pid-less
 * lock is never judged gone: its age is what the sweep measures.
 */
function holderGone(pid) {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

/**
 * Run `fn` as the only writer of the stack's state directory.
 *
 * `wx` fails if the lock exists, so the file itself is the mutex. Fifty tries
 * at 20ms is one second of contention before we refuse rather than corrupt. A
 * lock whose pid is certainly dead is stale now, not ten minutes from now, so a
 * crashed holder does not freeze every write until the sweep notices. Release
 * removes the lock only when it still names this process: a holder that wakes
 * after its lock was pruned must not unlink the next owner's.
 */
export function withLock(dir, fn) {
  ensureStack(dir);
  const file = path.join(dir, PATHS.lock);
  let fd = null;
  for (let attempt = 0; attempt < 50 && fd === null; attempt += 1) {
    try {
      fd = fs.openSync(file, 'wx');
      // The pid travels through the fd the exclusive create returned, so the
      // lock never exists without naming its holder.
      fs.writeSync(fd, String(process.pid));
    } catch (err) {
      if (fd !== null) {
        // The create succeeded and the write did not: this lock is ours to clear.
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
        fd = null;
        try {
          fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
        throw err;
      }
      if (err.code !== 'EEXIST') throw err;
      if (holderGone(lockPid(file))) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* another writer removed it first */
        }
        continue;
      }
      pause(20);
    }
  }
  if (fd === null) {
    throw new Error(`could not acquire ${PATHS.lock} after 50 tries; if no other writer is alive, delete it`);
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    if (lockPid(file) === process.pid) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* someone else cleaned it up */
      }
    }
  }
}

function endsWithNewline(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append one line to the ledger. Append-only by contract: a correction is a new
 * line, never an edit. Returns the stamped line so the caller can echo it.
 */
export function log(dir, kind, text) {
  ensureStack(dir);
  const now = stamps();
  const line = `- ${now.iso} · ${kind.toUpperCase()} · ${text.replace(/\s+/g, ' ').trim()}`;
  const file = path.join(dir, PATHS.ledger);
  const exists = fs.existsSync(file);
  const header = exists ? '' : '# Stack ledger\n\nAppend-only. Newest at the bottom. The digest is derived from here.\n\n';
  // A hand edit or a killed process can leave a line with no terminator. Without
  // this, the next entry merges into it and the ledger silently loses both.
  if (exists && fs.statSync(file).size > 0 && !endsWithNewline(file)) fs.appendFileSync(file, '\n', 'utf8');
  fs.appendFileSync(file, `${header}${line}\n`, 'utf8');
  return line;
}

export function ledgerEntries(dir, limit = 40) {
  const file = path.join(dir, PATHS.ledger);
  if (!fs.existsSync(file)) return [];
  const lines = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('- '));
  return lines.slice(Math.max(0, lines.length - limit)).map(parseLedgerLine);
}

function parseLedgerLine(line) {
  const clean = line.replace(/\r$/, '');
  const m = clean.match(/^- (\S+) · ([A-Za-z]+) · (.*)$/);
  if (!m) return { at: null, kind: 'NOTE', text: clean.replace(/^- /, '') };
  return { at: m[1], kind: m[2].toUpperCase(), text: m[3].replace(/\r$/, '') };
}

// ---------------------------------------------------------------- cleaning

/** A lock older than this is a crash leftover, not a live writer. */
export const LOCK_STALE_MS = 10 * 60 * 1000;
/** Seed only prunes temps this old; a temp from the write in flight is not junk. */
export const TMP_STALE_MS = 60 * 60 * 1000;

/** The directories `ensureStack` owns; empty is their normal state before a seam. */
const SCAFFOLD = new Set(['briefs', 'reports', 'state']);

/**
 * Every entry under `.stack`, without ever following a symlink. A link inside
 * the stack is reported and skipped: deleting through it would reach a path this
 * tool does not own.
 */
function stackEntries(root) {
  const files = [];
  const dirs = [];
  const links = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) links.push(full);
      else if (st.isDirectory()) {
        dirs.push(full);
        queue.push(full);
      } else files.push({ p: full, st });
    }
  }
  return { files, dirs, links };
}

const rel = (dir, file) => path.relative(dir, file).replace(/\\/g, '/');

/**
 * The closing sweep. Removes only what this plugin itself wrote under `.stack/`:
 * atomic-write `*.tmp`, a lock stale for `lockAgeMs`, `plugin.log`, and any
 * directory under it left empty (the `briefs`/`reports`/`state` scaffolding is
 * kept, because `ensureStack` owns it). Anything else — a brief, a report, a
 * config, a symlink — is kept and said so. `apply: false` is the report form.
 */
export function sweepStack(dir, { now = Date.now(), lockAgeMs = LOCK_STALE_MS, tmpAgeMs = 0, apply = false } = {}) {
  const root = path.join(dir, PATHS.root);
  const removed = [];
  const kept = [];
  if (!fs.existsSync(root)) return { removed, kept };

  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    return { removed, kept };
  }
  if (rootStat.isSymbolicLink()) {
    kept.push({ path: PATHS.root, why: 'a symlink, not followed: nothing outside the repository is ours to touch' });
    return { removed, kept };
  }

  const { files, dirs, links } = stackEntries(root);
  const lock = path.join(dir, PATHS.lock);
  const pluginLog = path.join(root, 'plugin.log');

  for (const link of links) {
    kept.push({ path: rel(dir, link), why: 'a symlink, not followed; delete it by hand if it is junk' });
  }

  const minutes = (ms) => `${Math.max(0, Math.round(ms / 60000))}m`;

  for (const { p, st } of files) {
    const age = now - st.mtimeMs;
    if (p === lock) {
      if (age > lockAgeMs) removed.push({ path: rel(dir, p), why: `lock unused for ${minutes(age)}; stale after ${minutes(lockAgeMs)}` });
      else kept.push({ path: rel(dir, p), why: `lock in use, ${minutes(age)} old; stale after ${minutes(lockAgeMs)}` });
      continue;
    }
    if (/\.tmp$/i.test(p)) {
      if (tmpAgeMs <= 0 || age >= tmpAgeMs) {
        removed.push({
          path: rel(dir, p),
          why: tmpAgeMs ? `atomic-write leftover older than ${minutes(tmpAgeMs)}` : 'atomic-write leftover',
        });
      } else {
        kept.push({ path: rel(dir, p), why: `temp newer than ${minutes(tmpAgeMs)}; the write may still be in flight` });
      }
      continue;
    }
    if (p === pluginLog) removed.push({ path: rel(dir, p), why: "the plugin's own log" });
  }

  for (const p of dirs.sort((a, b) => b.length - a.length)) {
    if (path.dirname(p) === root && SCAFFOLD.has(path.basename(p))) continue;
    let entries;
    try {
      entries = fs.readdirSync(p);
    } catch {
      continue;
    }
    if (!entries.length) removed.push({ path: rel(dir, p), why: 'empty directory left behind' });
  }

  if (!apply) return { removed, kept };

  const done = [];
  for (const row of removed) {
    // Re-check the path stayed under the stack root after every join.
    const full = path.resolve(dir, row.path);
    if (!full.startsWith(path.resolve(root) + path.sep)) {
      kept.push({ ...row, why: 'refused: the path resolves outside .stack' });
      continue;
    }
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        kept.push({ ...row, why: 'refused: it became a symlink between the scan and the delete' });
        continue;
      }
      if (st.isDirectory()) fs.rmdirSync(full);
      else fs.unlinkSync(full);
      done.push(row);
    } catch (err) {
      kept.push({ ...row, why: `could not remove: ${err.message}` });
    }
  }
  return { removed: done, kept };
}

const JUNK = /(Thumbs\.db|\.DS_Store|\.log|\.tmp|\.bak|\.orig|\.rej)$/i;

/**
 * Junk-looking paths in the working tree that this plugin did not create. Read
 * only: it names them so a human can decide. `.git`, `.stack` and `node_modules`
 * are not walked, and a symlink is never followed.
 */
export function junkPaths(dir, { limit = 500 } = {}) {
  const skip = new Set(['.git', '.stack', 'node_modules']);
  const found = [];
  const queue = [dir];
  while (queue.length && found.length < limit) {
    const current = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) queue.push(full);
      else if (JUNK.test(entry.name)) found.push(rel(dir, full));
    }
  }
  return found.sort();
}

// ---------------------------------------------------------------- seeding

/** A directory is a project if it has a repository or a build manifest. */
export function isProject(dir) {
  if (fs.existsSync(path.join(dir, '.git'))) return true;
  return MANIFESTS.some((m) => fs.existsSync(path.join(dir, m)));
}

/**
 * Scan Cargo.toml once, returning two views at the original offsets: `bare`
 * with comments and strings blanked, and `live` with strings kept and comments
 * blanked. Structure is read from `bare`, so a `[package]` in a comment or
 * inside `"""..."""` is not a table and a `#` inside a string is not a comment;
 * the members list is read from `live`, where a commented-out line is gone.
 * Returns null for text this reader cannot delimit (an unterminated string,
 * comment or multi-line string), because that is not a manifest we can trust.
 */
function cargoScan(text) {
  const bare = [];
  const live = [];
  const blank = (from, to, keepLive) => {
    for (let j = from; j < to; j += 1) {
      const c = text[j];
      bare.push(c === '\n' ? '\n' : ' ');
      live.push(keepLive || c === '\n' ? c : ' ');
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#') {
      const end = text.indexOf('\n', i);
      blank(i, end < 0 ? text.length : end, false);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (ch !== '"' && ch !== "'") {
      bare.push(ch);
      live.push(ch);
      i += 1;
      continue;
    }
    const triple = text.startsWith(ch.repeat(3), i);
    let j = i + (triple ? 3 : 1);
    if (triple) {
      const close = text.indexOf(ch.repeat(3), j);
      if (close < 0) return null;
      j = close + 3;
    } else {
      for (; j < text.length; j += 1) {
        if (text[j] === ch) break;
        if (text[j] === '\n') return null;
        if (ch === '"' && text[j] === '\\') j += 1;
      }
      if (j >= text.length) return null;
      j += 1;
    }
    blank(i, j, true);
    i = j;
  }
  return { bare: bare.join(''), live: live.join('') };
}

/** Square brackets and curly braces must balance outside strings and comments. */
function balanced(text) {
  let square = 0;
  let curly = 0;
  for (const ch of text) {
    if (ch === '[') square += 1;
    else if (ch === ']') square -= 1;
    else if (ch === '{') curly += 1;
    else if (ch === '}') curly -= 1;
    if (square < 0 || curly < 0) return false;
  }
  return square === 0 && curly === 0;
}

/**
 * True when Cargo.toml declares something `cargo test` can build: a `[package]`
 * table, or a `[workspace]` naming at least one member. An empty virtual
 * workspace has no tests to run, and a manifest that is unreadable, unparseable
 * (an unterminated string or an unbalanced bracket) or not understood is not
 * proof, so all of them add no check. `[workspace.package]` and
 * `[workspace.dependencies]` are neither of those tables.
 */
function cargoDeclaresTests(text) {
  const scan = cargoScan(text);
  // Unparseable is treated exactly like unreadable: a bracket that never closes
  // means every table below it is guesswork, and a header inside a comment or a
  // multi-line string never reaches this scan at all.
  if (!scan || !balanced(scan.bare)) return false;
  const header = /^[ \t]*\[([^\]\r\n]+)\][ \t]*\r?$/gm;
  const headers = [...scan.bare.matchAll(header)];
  if (headers.some((h) => h[1].trim() === 'package')) return true;
  for (let i = 0; i < headers.length; i += 1) {
    if (headers[i][1].trim() !== 'workspace') continue;
    const from = headers[i].index + headers[i][0].length;
    const to = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const members = /(?:^|\r?\n)[ \t]*members[ \t]*=[ \t]*\[([\s\S]*?)\]/.exec(scan.live.slice(from, to));
    const strings = members ? members[1].match(/"[^"\r\n]*"|'[^'\r\n]*'/g) || [] : [];
    if (strings.some((s) => s.slice(1, -1).trim().length > 0)) return true;
  }
  return false;
}

/**
 * The repo's proving commands, detected from its own manifests. Only cheap,
 * well-known commands, and only the ones the project actually declares.
 */
export function detectChecks(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const found = [];
  const add = (name, command, timeout = 240000) => {
    if (!found.some((c) => c.command === command)) found.push({ name, command, timeout });
  };

  if (has('package.json')) {
    try {
      const pkg = parseJson(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const scripts = pkg.scripts || {};
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm';
      const verb = pm === 'npm' ? 'npm run' : pm;
      for (const name of ['test', 'typecheck', 'lint', 'build']) {
        if (scripts[name]) add(name, `${verb} ${name}`);
      }
    } catch {
      /* a broken package.json is not this tool's problem */
    }
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('tox.ini') || has('tests')) add('pytest', 'python -m pytest -q');
  if (has('go.mod')) add('go', 'go test ./...');
  if (has('Cargo.toml')) {
    try {
      if (cargoDeclaresTests(fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8'))) add('cargo', 'cargo test');
    } catch {
      /* a manifest we cannot read or parse is no proof of a test suite */
    }
  }
  if (has('Makefile')) {
    try {
      if (/^test:/m.test(fs.readFileSync(path.join(dir, 'Makefile'), 'utf8'))) add('make', 'make test');
    } catch {
      /* unreadable Makefile, skip */
    }
  }
  return found.slice(0, 4);
}

/**
 * Make `.stack/` exist and be useful, without ever destroying what is there.
 *
 * Missing -> create the directories, the config with detected checks, the
 * ledger header, and a first digest. Present -> union the ignore list and
 * refresh the digest when the ledger is newer; detected checks are installed
 * once, when the config is first written, because an existing valid config is
 * the owner's statement of what proves this repo and seeding must not append
 * to it. Custom checks, notes, briefs and reports are never touched. A corrupt
 * config is rewritten, because it has no content to preserve and leaving it
 * means `check` can never run.
 */
export function seedStack(dir, { quiet = true } = {}) {
  if (!isProject(dir)) return { ok: false, reason: 'not a project', created: [] };

  const created = [];
  const updated = [];
  // Read before ensureStack writes the default: a seed that finds no config
  // installs the detected checks, and a seed that finds a valid one does not.
  const freshConfig = !fs.existsSync(path.join(dir, PATHS.config));
  ensureStack(dir);
  if (!fs.existsSync(path.join(dir, PATHS.ledger))) created.push(PATHS.ledger);

  // The check tail and the plugin's log are machine noise; a real project must
  // not commit them just because it uses the stack.
  const ignoreFile = path.join(dir, PATHS.gitignore);
  if (!fs.existsSync(ignoreFile)) {
    writeAtomic(ignoreFile, 'state/\nplugin.log\n');
    created.push(PATHS.gitignore);
  }

  // The stack maintains itself: a crash leaves `.tmp` files and a stale lock,
  // and the next seed is the cheapest place to clear them. A temp younger than
  // an hour may belong to a write still in flight, so seed keeps it.
  const pruned = sweepStack(dir, { tmpAgeMs: TMP_STALE_MS, apply: true });

  const cfgFile = path.join(dir, PATHS.config);
  const exists = fs.existsSync(cfgFile);
  const cfg = config(dir);
  const corrupt = isCorruptConfig(cfg);
  // Installed once: a valid config already answers "what proves this repo", so
  // a detected check it does not list must not be appended behind the owner.
  const detected = (freshConfig || corrupt) ? detectChecks(dir) : [];
  const before = JSON.stringify({ ...cfg, checks: cfg.checks, ownership: cfg.ownership });
  const mergedChecks = [...(Array.isArray(cfg.checks) ? cfg.checks : [])];
  for (const check of detected) {
    if (!mergedChecks.some((c) => c && (c.command === check.command || c.name === check.name))) mergedChecks.push(check);
  }
  const ignore = new Set([...(cfg.ownership?.ignore || []), ...DEFAULT_CONFIG.ownership.ignore]);
  const next = {
    ...cfg,
    checks: mergedChecks,
    ownership: { ...(cfg.ownership || {}), ignore: [...ignore] },
  };
  if (corrupt || JSON.stringify(next) !== before || !exists) {
    writeJson(dir, PATHS.config, next);
    if (exists) updated.push(PATHS.config);
    else created.push(PATHS.config);
  }

  if (created.includes(PATHS.ledger)) {
    log(dir, 'SEED', `stack seeded in ${path.basename(dir)} with ${next.checks.length} check(s)`);
  }

  const digestFile = path.join(dir, PATHS.digest);
  const ledgerFile = path.join(dir, PATHS.ledger);
  const stale =
    !fs.existsSync(digestFile) ||
    (fs.existsSync(ledgerFile) && fs.statSync(ledgerFile).mtimeMs > fs.statSync(digestFile).mtimeMs);
  if (stale) {
    renderDigest(dir);
    if (fs.existsSync(digestFile)) created.includes(PATHS.digest) || updated.push(PATHS.digest);
  }

  return {
    ok: true,
    created: [...new Set(created)],
    updated: [...new Set(updated)],
    removed: pruned.removed.map((r) => r.path),
    checks: next.checks.length,
  };
}

/** The digest, derived from the ledger and the brief index. Never hand-maintained. */
export function renderDigest(dir) {
  ensureStack(dir);
  // Facts that must survive compaction are read from the whole ledger. The 120
  // window is a display budget; it is not a memory budget.
  const all = ledgerEntries(dir, Number.MAX_SAFE_INTEGER);
  const entries = all.slice(Math.max(0, all.length - 120));
  const now = Date.now();
  const ageOf = (iso) => {
    if (!iso) return 'unknown';
    const mins = Math.round((now - Date.parse(iso)) / 60000);
    if (Number.isNaN(mins)) return 'unknown';
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m`;
    if (mins < 2880) return `${Math.round(mins / 60)}h`;
    return `${Math.round(mins / 1440)}d`;
  };

  const asks = all.filter((e) => e.kind === 'ASK');
  const answers = all.filter((e) => e.kind === 'ANSWER');
  const open = asks.filter((a) => !answers.some((x) => Date.parse(x.at) > Date.parse(a.at))).slice(-5);

  const fresh = entries
    .filter((e) => ['READY', 'LANDED', 'RED', 'NOTE', 'RULING', 'SEED'].includes(e.kind))
    .slice(-8)
    .reverse();

  const briefsRead = tryReadJson(dir, PATHS.briefsIndex, []);
  const briefs = Array.isArray(briefsRead.value) ? briefsRead.value : [];
  const live = briefs.filter((b) => b.status !== 'landed');

  // The objective is the one fact that must survive compaction. The lead logs it
  // at intake; if the digest does not render it, the stack can execute a plan
  // flawlessly toward a goal nobody can restate.
  const intake = [...all].reverse().find((e) => e.kind === 'INTAKE' || /^intake:/i.test(e.text));

  const lines = [
    `# Digest — ${stamps().local}`,
    '',
    'Rewritten by the lead. Newest first. An empty section is a true statement.',
    '',
    ...(intake ? [`**Objective** — ${intake.text.replace(/^intake:\s*/i, '')}`, ''] : []),
    '## Needs you',
    '',
  ];
  lines.push(
    open.length
      ? open.map((a) => `- ${a.text} _(${ageOf(a.at)} ago)_`).join('\n')
      : '_Nothing. The owner has no open decision._',
  );
  lines.push('', '## New', '');
  lines.push(
    fresh.length
      ? fresh.map((e) => `- **${e.kind}** · ${ageOf(e.at)} · ${e.text}`).join('\n')
      : '_Nothing landed yet._',
  );
  lines.push('', '## In progress', '');
  lines.push(
    live.length
      ? table(
          ['Seam', 'Owns', 'State', 'Age'],
          live.map((b) => [
            `[${b.id}](${PATHS.briefs}/${b.id}.md)`,
            (b.owns || []).slice(0, 3).join('<br>') || '—',
            b.status || 'briefed',
            ageOf(b.at),
          ]),
        )
      : '_No briefed seam is open._',
  );
  lines.push('', '## Stall watch', '');
  const stalled = live.filter((b) => Date.parse(b.at) && now - Date.parse(b.at) > 6 * 3600_000);
  lines.push(
    stalled.length
      ? stalled.map((b) => `- ${b.id} has not moved in ${ageOf(b.at)}. Chase it, close it, or kill it.`).join('\n')
      : '_No seam is older than six hours._',
  );

  // Three of the four seats leave an artifact. The auditor's verdict is the one
  // that used to live only in chat, which means "landed" could quietly mean
  // "landed and never reviewed".
  const audits = all.filter((e) => e.kind === 'AUDIT');
  const unaudited = briefs.filter((b) => b.status === 'landed' && !audits.some((a) => a.text.includes(b.id)));
  if (unaudited.length) {
    lines.push('', '## Landed, unaudited', '');
    lines.push(unaudited.map((b) => `- ${b.id} landed without a recorded verdict. Run \`stacked-audit\` and log it.`).join('\n'));
  }

  const text = `${lines.join('\n')}\n`;
  writeAtomic(path.join(dir, PATHS.digest), text);
  return `${text}\n_Written to ${PATHS.digest}._`;
}

export { DEFAULT_CONFIG };
