'use strict';
//
// Small, boring file and archive helpers. Builtins only.
//
// Downloads use HTTPS with capped redirects. A download never overwrites a
// destination it did not create. Archives are inspected before extraction and
// refused unless every entry is a regular file or directory under one root.
// Staging and install paths are checked for links and other reparse points,
// including existing ancestors, so a pre-existing link cannot redirect a write
// outside the owned root. A short-name or case alias of the same directory is
// canonicalized, not mistaken for a redirection.
//

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const USER_AGENT = 'rea-shim';
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
  fs.writeSync(2, `rea-shim: ${message}\n`);
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
      if (stat.isDirectory()) visit(target);
      else if (!stat.isFile()) fail(`extracted archive contains a non-regular entry: ${target}`);
      const real = realpathOrNull(target);
      if (!real) fail(`cannot resolve the extracted archive entry ${target}`);
      if (!pathKey(real).startsWith(`${realRootKey}${path.sep}`)) {
        fail(`extracted archive entry resolves outside the staging directory: ${target}`);
      }
    }
  };
  visit(resolvedRoot);
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
  file.once('open', () => { created = true; });
  try {
    let received = 0;
    response.on('data', (chunk) => { received += chunk.length; });
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

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function normalizeEntry(entry) {
  let value = String(entry).replace(/\\/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  return value;
}

function assertSafeComponent(part, raw) {
  if (!part) fail(`archive entry has an empty path component: ${raw}`);
  if (part === '.' || part === '..') fail(`archive entry escapes its top-level directory: ${raw}`);
  if (part.includes(':')) fail(`archive entry contains a drive or stream separator: ${raw}`);
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
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail('tar.exe is required to extract the portable archive; Windows 10 1803+ and Windows 11 ship it in System32');
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

module.exports = {
  SupportError,
  assertArchiveListingSafe,
  assertInside,
  assertNoReparsePoints,
  assertPlainAncestors,
  assertSafeArchiveEntries,
  assertSafeEntryName,
  assertTarAvailable,
  downloadFile,
  ensurePlainDir,
  extractArchive,
  fail,
  isPlainDir,
  isPlainFile,
  listArchive,
  lstatOrNull,
  logLine,
  normalizeEntry,
  randomSuffix,
  realpathOrNull,
  removeOwnedDir,
  sha256File,
};
