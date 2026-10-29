'use strict';
//
// Low-level support for the explicit `rea-shim --bootstrap` path.
//
// Everything here is deliberately boring and auditable:
//   - HTTPS only, redirects capped, no credential handling;
//   - a download never overwrites or deletes a destination it did not create;
//   - archives are inspected before extraction and refused unless every entry
//     is a regular file or directory under one top-level directory;
//   - extraction staging and the install root are checked for symlinks,
//     junctions and other reparse points, including existing ancestors, so a
//     pre-existing link can never redirect a write outside the root; the npm
//     cache directory and every existing entry beneath it are proved plain the
//     same way immediately before npm receives it, because npm writes through
//     every directory it finds (`_cacache` included), not just the cache root.
//   - a legitimate path alias (a DOS 8.3 short name such as `RUNNER~1` for
//     `runneradmin`, a different letter case, a substituted drive) is
//     canonicalized rather than mistaken for a reparse point: identity, not
//     spelling, decides whether a spelling redirects somewhere else.
//
// Builtins only; no dependencies.
//

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const USER_AGENT = 'rea-shim-bootstrap';
const MAX_REDIRECTS = 5;

class SupportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SupportError';
  }
}

function fail(message) {
  throw new SupportError(message);
}

function logLine(message) {
  fs.writeSync(2, `rea-shim bootstrap: ${message}\n`);
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function randomSuffix() {
  return crypto.randomBytes(6).toString('hex');
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * True when following `target` reaches the same directory object `lstat` saw.
 *
 * Windows names one directory several ways: a DOS 8.3 short name (`RUNNER~1`
 * for a `runneradmin` profile), a differently cased path, a substituted drive.
 * `realpath` answers with the canonical handle path, so such a spelling and its
 * real path differ textually while naming the same directory. A reparse point
 * is different: `lstat` reports the link object and `stat` follows it, so the
 * two carry different file ids (or volumes). Comparing identity - not spelling
 * - is what separates a legitimate alias from a redirection.
 *
 * Returns false for anything that cannot be proved the same object, including
 * a vanished path, so callers fail closed.
 */
function isSameDirectoryObject(target) {
  let own;
  let followed;
  try {
    own = fs.lstatSync(target, { bigint: true });
    followed = fs.statSync(target, { bigint: true });
  } catch {
    return false;
  }
  return Boolean(
    own.isDirectory() && followed.isDirectory() &&
    own.dev === followed.dev && own.ino === followed.ino && own.ino !== 0n,
  );
}

function isPlainFile(target) {
  const stat = lstatOrNull(target);
  return Boolean(stat && stat.isFile() && !stat.isSymbolicLink());
}

function isPlainDir(target) {
  const stat = lstatOrNull(target);
  return Boolean(stat && stat.isDirectory() && !stat.isSymbolicLink());
}

function pathKey(target) {
  return path.resolve(target).replace(/[\\/]+$/, '').toLowerCase();
}

function assertInside(root, target, label) {
  const rootKey = pathKey(root);
  const targetKey = pathKey(target);
  if (targetKey !== rootKey && !targetKey.startsWith(`${rootKey}${path.sep}`)) {
    fail(`${label} ${target} escapes the install root ${root}`);
  }
}

function removeEnvKey(env, key) {
  const wanted = key.toLowerCase();
  for (const existing of Object.keys(env)) {
    if (existing.toLowerCase() === wanted) delete env[existing];
  }
}

/**
 * Build the environment handed to an npm child process.
 *
 * Windows environment lookup is case-insensitive, but the block Node builds
 * from a JavaScript object keeps each key's exact spelling. Spreading
 * `process.env` and then adding `npm_config_cache` therefore leaves an
 * inherited `NPM_CONFIG_CACHE` (or any other spelling) beside it, and the
 * first case-insensitive match wins when npm reads its config - so the
 * inherited value can beat the validated one. Every inherited spelling of
 * `npm_config_cache` is removed before the single canonical path is set, and
 * the same is done for each override, so a fixed npm flag cannot be shadowed
 * either. The returned object therefore contains exactly one cache config
 * entry, and it is the path this process validated.
 *
 * `npmCache` is the canonical path returned by `ensureCanonicalDirInside`.
 * Pass `null` only where no cache may be written (a read-only plan run): the
 * inherited cache config is still removed, so an external path can never
 * reach npm, and npm falls back to its own configured cache.
 */
function npmChildEnv(baseEnv, npmCache, overrides = {}) {
  const env = { ...(baseEnv || process.env) };
  removeEnvKey(env, 'npm_config_cache');
  if (npmCache !== null && npmCache !== undefined) {
    if (typeof npmCache !== 'string' || npmCache.length === 0 || !path.isAbsolute(npmCache)) {
      fail(`npm needs an absolute validated cache path, got '${String(npmCache)}'`);
    }
    env.npm_config_cache = npmCache;
  }
  for (const [key, value] of Object.entries(overrides)) {
    removeEnvKey(env, key);
    env[key] = String(value);
  }
  return env;
}

/**
 * Refuse a path when any existing component between the filesystem root and
 * the target is a symbolic link, junction or other reparse point. Node reports
 * junctions through `lstat().isSymbolicLink()`; `realpath` is the cross-check
 * for other reparse points that resolve elsewhere. A component whose real path
 * only differs by spelling (a DOS 8.3 short name or another alias of the same
 * directory object) is canonicalized and accepted; a component that resolves
 * to a different object is refused, wherever its target lives.
 */
function assertPlainAncestors(target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      fail(`${label} ${current} is a symbolic link, junction or reparse point; refusing to write through it`);
    }
    if (!stat.isDirectory()) {
      fail(`${label} ${current} is not a directory; refusing to write through it`);
    }
    const real = realpathOrNull(current);
    if (real && pathKey(real) !== pathKey(current) && !isSameDirectoryObject(current)) {
      fail(`${label} ${current} resolves to ${real}; refusing to write through a reparse point`);
    }
  }
}

/**
 * Create `target` one segment at a time, never through an existing link. A
 * `mkdir -p` would happily traverse a junction created between the root and
 * the target; this does not.
 */
function ensurePlainDir(target, label) {
  assertPlainAncestors(target, label);
  const existing = lstatOrNull(target);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      fail(`${label} ${target} exists but is not a plain directory; refusing to write through it`);
    }
    return;
  }
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(`${label} ${current} exists but is not a plain directory; refusing to write through it`);
      }
      continue;
    }
    try {
      fs.mkdirSync(current);
    } catch (error) {
      fail(`cannot create ${label} ${current}: ${error.message}`);
    }
    const created = lstatOrNull(current);
    if (!created || !created.isDirectory() || created.isSymbolicLink()) {
      fail(`${label} ${current} was not created as a plain directory`);
    }
  }
}

/**
 * Validate or create one directory directly beneath `root` and prove its
 * canonical path is exactly `<canonical root>/<name>`.
 *
 * `ensurePlainDir` refuses links on the way down and will not create through
 * them. This adds the canonical postcondition for a caller that is about to
 * hand the directory to another program: the directory it will write through
 * must still resolve to the intended path inside the root. Returns the
 * canonical path, which callers should pass on rather than the lexical one.
 *
 * Pass `{ rejectReparseDescendants: true }` when the directory is handed to a
 * program that writes through everything it finds (the npm cache). A tree
 * that is canonical at its root can still contain a `_cacache` junction one
 * level down, which redirects every write just as effectively.
 */
function ensureCanonicalDirInside(root, name, label, options = {}) {
  if (
    typeof name !== 'string' || !name || name === '.' || name === '..' ||
    name !== path.basename(name) || /[\\/:]/.test(name)
  ) {
    fail(`${label} name must be one plain directory name`);
  }
  const target = path.join(root, name);
  ensurePlainDir(target, label);
  const realRoot = realpathOrNull(root);
  if (!realRoot) fail(`cannot resolve the install root ${root} to verify ${label}`);
  const realTarget = realpathOrNull(target);
  if (!realTarget) fail(`cannot resolve ${label} ${target}`);
  if (pathKey(realTarget) !== pathKey(path.join(realRoot, name))) {
    fail(`${label} ${target} resolves to ${realTarget}; refusing to write outside the canonical install root ${realRoot}`);
  }
  assertInside(realRoot, realTarget, label);
  if (options.rejectReparseDescendants) {
    assertNoReparseDescendants(realTarget, label);
  }
  return realTarget;
}

/**
 * Refuse a tree when any existing entry beneath `root` is a symbolic link,
 * junction or other reparse point that resolves elsewhere.
 *
 * The npm cache is handed to a third-party program that writes through every
 * directory it finds, so proving the cache directory itself is canonical is
 * not enough: a pre-existing `npm-cache/_cacache` junction redirects content,
 * index and temp writes outside the owned root. Every existing level is
 * walked, and every directory the walk descends into is re-resolved and
 * compared with its lexical path, so any reparse point fails closed even when
 * `lstat` does not classify it as a symbolic link.
 *
 * Race-conscious by construction: the walk runs immediately before npm is
 * spawned, re-resolves the root at both ends so a tree swap during the walk
 * fails closed, and treats an entry that vanishes mid-walk as nothing left to
 * follow. A writer with concurrent write access inside the cache could still
 * create a link after the walk and before npm's first write; closing that
 * residual window would need handle-relative opens, which Node does not
 * expose on Windows.
 *
 * A root or directory whose real path differs only by an alias of the same
 * object (a DOS 8.3 short name, a different case) is canonicalized, not
 * refused; anything that resolves to a different object is refused.
 */
function assertNoReparseDescendants(root, label) {
  const resolvedRoot = path.resolve(root);
  const realRoot = realpathOrNull(resolvedRoot);
  if (!realRoot) fail(`cannot resolve ${label} ${root}`);
  if (pathKey(realRoot) !== pathKey(resolvedRoot) && !isSameDirectoryObject(resolvedRoot)) {
    fail(`${label} ${root} resolves to ${realRoot}; refusing to write through a reparse point`);
  }
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      fail(`cannot inspect ${label} ${dir}: ${error.message}`);
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      const stat = lstatOrNull(target);
      if (!stat) continue; // vanished between listing and inspection: nothing left to follow
      if (stat.isSymbolicLink()) {
        fail(`${label} ${target} is a symbolic link, junction or reparse point; refusing to let npm write through it`);
      }
      if (!stat.isFile() && !stat.isDirectory()) {
        fail(`${label} ${target} is not a regular file or directory; refusing to let npm write through it`);
      }
      if (!stat.isDirectory()) continue;
      const real = realpathOrNull(target);
      if (!real) {
        // Only a vanished entry is safe to skip; any other resolution failure
        // is unknown state and must fail closed.
        if (lstatOrNull(target)) fail(`cannot resolve ${label} ${target}`);
        continue;
      }
      if (pathKey(real) !== pathKey(target) && !isSameDirectoryObject(target)) {
        fail(`${label} ${target} resolves to ${real}; refusing to write through a reparse point`);
      }
      visit(target);
      // Bracket every directory: if it was swapped for a link while its
      // entries were being inspected, fail closed now rather than trust a
      // listing that came from somewhere else.
      const realAfterVisit = realpathOrNull(target);
      if (!realAfterVisit || pathKey(realAfterVisit) !== pathKey(real)) {
        fail(`${label} ${target} changed while it was being verified; refusing to hand it to npm`);
      }
    }
  };
  visit(realRoot);
  const realAfter = realpathOrNull(resolvedRoot);
  if (!realAfter || pathKey(realAfter) !== pathKey(realRoot)) {
    fail(`${label} ${root} changed while it was being verified; refusing to hand it to npm`);
  }
}

function removeOwnedDir(target, log = logLine) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    log(`warning: could not remove ${target}: ${error.message}`);
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ---------------------------------------------------------------------------
// HTTPS reads. No non-HTTPS URL is ever requested.
// ---------------------------------------------------------------------------

function openResponse(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new SupportError(`invalid URL ${url}: ${error.message}`));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new SupportError(`refusing a non-HTTPS URL: ${url}`));
      return;
    }
    const request = https.get(parsed, {
      headers: {
        'user-agent': `${USER_AGENT}/${process.pid}`,
        accept: '*/*',
        ...(options.headers || {}),
      },
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          reject(new SupportError(`redirect from ${url} had no Location header`));
          return;
        }
        if (redirects >= MAX_REDIRECTS) {
          reject(new SupportError(`too many redirects while reading ${url}`));
          return;
        }
        openResponse(new URL(location, parsed).toString(), options, redirects + 1).then(resolve, reject);
        return;
      }
      resolve(response);
    });
    request.on('error', reject);
    request.setTimeout(options.timeoutMs || 120000, () => {
      request.destroy(new SupportError(`request stalled: ${url}`));
    });
  });
}

async function fetchText(url, options = {}) {
  const response = await openResponse(url, options);
  const status = response.statusCode || 0;
  if (status !== 200) {
    response.resume();
    fail(`GET ${url} returned HTTP ${status}`);
  }
  const maxBytes = options.maxBytes || 1024 * 1024;
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      fail(`GET ${url} exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`GET ${url} did not return JSON: ${error.message}`);
  }
  return null;
}

/**
 * Download to a path that must not already exist. The destination is created
 * with `wx`, so a race cannot clobber an existing file either. On failure only
 * a file this call created is removed; a pre-existing destination is never
 * touched, and the preflight check fails before any network request.
 */
async function downloadFile(url, destination, options = {}) {
  if (lstatOrNull(destination)) {
    fail(`refusing to overwrite the existing file ${destination}`);
  }
  assertPlainAncestors(path.dirname(destination), 'download destination');
  const response = await openResponse(url, options);
  const status = response.statusCode || 0;
  if (status !== 200) {
    response.resume();
    fail(`GET ${url} returned HTTP ${status}`);
  }

  let created = false;
  const file = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  file.once('open', () => {
    created = true;
  });
  try {
    let received = 0;
    const total = Number(response.headers['content-length'] || 0);
    let lastPercent = -10;
    let lastAt = 0;
    response.on('data', (chunk) => {
      received += chunk.length;
      if (typeof options.onProgress !== 'function') return;
      const now = Date.now();
      const percent = total > 0 ? Math.floor((received / total) * 100) : null;
      if (percent !== null && percent < lastPercent + 10 && now - lastAt < 5000) return;
      lastPercent = percent === null ? lastPercent : percent;
      lastAt = now;
      options.onProgress({ received, total, percent });
    });
    await pipeline(response, file);
    return { bytes: received };
  } catch (error) {
    try {
      file.destroy();
    } catch {
      // The explicit unlink below is what matters.
    }
    if (created) {
      try {
        fs.rmSync(destination, { force: true });
      } catch {
        // Best-effort cleanup of a file this call created.
      }
    }
    if (error instanceof SupportError) throw error;
    fail(`download failed for ${url}: ${error.message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Archive inspection and extraction.
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function normalizeEntry(entry) {
  let value = String(entry).replace(/\\/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  return value;
}

function assertSafeComponent(part, raw) {
  if (!part) fail(`archive entry has an empty path component: ${raw}`);
  if (part === '.' || part === '..') fail(`archive entry escapes its top-level directory: ${raw}`);
  if (part.includes(':')) fail(`archive entry contains a drive or NTFS stream separator: ${raw}`);
  if (/[\u0000-\u001f]/.test(part)) fail(`archive entry contains a control character: ${raw}`);
  if (/[. ]$/.test(part)) fail(`archive entry component ends with a dot or space: ${raw}`);
  if (WINDOWS_RESERVED.test(part.replace(/\..*$/, ''))) {
    fail(`archive entry uses a reserved Windows device name: ${raw}`);
  }
}

function assertSafeEntryName(raw) {
  const entry = normalizeEntry(raw);
  if (!entry || entry === '.') return null;
  if (entry.includes('\0')) fail(`archive entry contains a NUL byte: ${raw}`);
  if (entry.startsWith('/') || entry.startsWith('//') || /^[A-Za-z]:/.test(entry)) {
    fail(`archive entry is absolute: ${raw}`);
  }
  const trimmed = entry.replace(/\/+$/, '');
  if (!trimmed) fail(`archive entry has no path: ${raw}`);
  for (const part of trimmed.split('/')) assertSafeComponent(part, raw);
  return trimmed;
}

/**
 * Validate a plain archive listing and return its single top-level directory.
 * Every entry must be a relative regular file or directory under exactly one
 * root. Links, devices and entries outside that root are refused.
 */
function assertSafeArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('archive listing is empty; refusing to extract it');
  }
  const roots = new Set();
  const names = [];
  for (const raw of entries) {
    const name = assertSafeEntryName(raw);
    if (!name) continue;
    names.push(name);
    roots.add(name.split('/')[0]);
  }
  if (names.length === 0) fail('archive has no usable entries');
  if (roots.size !== 1) {
    fail(`archive entries do not share one top-level directory: ${[...roots].join(', ')}`);
  }
  const root = [...roots][0];
  if (root.includes('/') || root === '.' || root === '..') {
    fail(`archive top-level directory is invalid: ${root}`);
  }
  return { root, entries: names };
}

/**
 * `tar -tvf` starts each line with the entry type. Only regular files (`-`)
 * and directories (`d`) are extractable; `l` symlinks, `h` hard links and
 * device/FIFO/socket types are refused before extraction.
 */
function assertArchiveListingSafe(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    fail('verbose archive listing is empty; refusing to extract it');
  }
  for (const line of lines) {
    const trimmed = String(line).trim();
    if (!trimmed) continue;
    const type = trimmed[0];
    if (type !== '-' && type !== 'd') {
      fail(`archive entry is not a regular file or directory (type '${type}'): ${trimmed.slice(0, 200)}`);
    }
  }
}

function runTar(args, label, timeoutMs = 300000) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) fail(`${label} could not run tar: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status}): ${String(result.stderr || '').trim().slice(-1000)}`);
  }
  return String(result.stdout || '').split(/\r?\n/).filter(Boolean);
}

function assertTarAvailable() {
  const result = spawnSync('tar', ['--version'], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail('tar.exe is required to extract the official ZIP archives; Windows 10 1803+ and Windows 11 ship it in System32');
  }
}

function listArchive(archive) {
  const names = runTar(['-tf', archive], `tar -tf ${path.basename(archive)}`);
  const verbose = runTar(['-tvf', archive], `tar -tvf ${path.basename(archive)}`);
  if (names.length !== verbose.length) {
    fail(`archive listings disagree for ${path.basename(archive)}: ${names.length} names vs ${verbose.length} typed entries`);
  }
  assertArchiveListingSafe(verbose);
  return names;
}

function extractArchive(archive, staging) {
  const result = spawnSync('tar', ['-xf', archive, '-C', staging], {
    encoding: 'utf8',
    timeout: 900000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) fail(`tar extraction failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`tar extraction failed (exit ${result.status}): ${String(result.stderr || '').trim().slice(-1000)}`);
  }
}

/**
 * Walk an extracted tree and refuse links or non-file entries. This is the
 * post-extraction counterpart to the listing check: even a hostile archive
 * that slipped a link past the listing cannot turn staging into a write path.
 *
 * Containment is decided from each entry's canonical path, so an aliased
 * staging path (a DOS 8.3 short name under the temp directory) is not mistaken
 * for an escape, while an entry that resolves elsewhere still is.
 */
function assertNoReparsePoints(root) {
  const resolvedRoot = path.resolve(root);
  const realRoot = realpathOrNull(resolvedRoot);
  if (!realRoot) fail(`cannot resolve the extracted directory ${root}`);
  const realRootKey = pathKey(realRoot);
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      const stat = lstatOrNull(target);
      if (!stat) fail(`archive entry disappeared while verifying: ${target}`);
      if (stat.isSymbolicLink()) {
        fail(`extracted archive contains a symbolic link, junction or reparse point: ${target}`);
      }
      if (stat.isDirectory()) {
        visit(target);
      } else if (!stat.isFile()) {
        fail(`extracted archive contains a non-regular entry: ${target}`);
      }
      const real = realpathOrNull(target);
      if (!real) fail(`cannot resolve the extracted archive entry ${target}`);
      if (!pathKey(real).startsWith(`${realRootKey}${path.sep}`)) {
        fail(`extracted archive entry resolves outside the staging directory: ${target}`);
      }
    }
  };
  visit(resolvedRoot);
}

module.exports = {
  SupportError,
  USER_AGENT,
  assertArchiveListingSafe,
  assertInside,
  assertNoReparseDescendants,
  assertNoReparsePoints,
  assertPlainAncestors,
  assertSafeArchiveEntries,
  assertSafeEntryName,
  assertTarAvailable,
  downloadFile,
  ensureCanonicalDirInside,
  ensurePlainDir,
  extractArchive,
  fail,
  fetchJson,
  fetchText,
  formatMiB,
  isPlainDir,
  isPlainFile,
  listArchive,
  lstatOrNull,
  logLine,
  normalizeEntry,
  npmChildEnv,
  randomSuffix,
  realpathOrNull,
  removeOwnedDir,
  sha256File,
};
