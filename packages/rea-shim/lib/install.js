'use strict';
//
// Install mechanics for `rea-shim --bootstrap`.
//
// Two unit types are installed:
//   - an official Ghidra or JDK ZIP, verified by SHA-256 and extracted with
//     the link/reparse checks in support.js;
//   - the exact upstream rea-agents release, installed with npm into its own
//     prefix so all three acceptance checks run the same immutable version.
//
// npm receives a cache path under the root only after that directory has been
// proved plain and canonical, including every existing descendant: npm writes
// through `_cacache`, so a nested junction is refused immediately before each
// spawn rather than trusted because the cache root itself is canonical. A
// pre-existing link is refused, never followed.
//
// The child environment is rebuilt rather than inherited wholesale: every
// spelling of `npm_config_cache` is removed before the validated canonical
// path is set. Windows resolves environment names case-insensitively, so
// spreading an uppercase `NPM_CONFIG_CACHE` beside a lowercase one would let
// the inherited value win and npm would write outside the root after all.
//
// Existing directories are reused only when this module's marker proves it
// created that exact artifact. A foreign directory, a mismatched cache entry
// and a pre-existing download destination are never deleted or replaced.
//

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  assertInside,
  assertNoReparsePoints,
  assertPlainAncestors,
  assertSafeArchiveEntries,
  assertTarAvailable,
  downloadFile,
  ensureCanonicalDirInside,
  ensurePlainDir,
  extractArchive,
  fail,
  isPlainDir,
  isPlainFile,
  listArchive,
  lstatOrNull,
  logLine,
  npmChildEnv,
  randomSuffix,
  removeOwnedDir,
  sha256File,
} = require('./support.js');

const MARKER_FILE = '.rea-shim-install.json';
const MARKER_SCHEMA = 2;

function readMarker(dir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
    if (!marker || marker.schema !== MARKER_SCHEMA) return null;
    return marker;
  } catch {
    return null;
  }
}

function markerMatches(marker, entry) {
  return Boolean(
    marker &&
    marker.schema === MARKER_SCHEMA &&
    marker.name === entry.kind &&
    marker.version === entry.version &&
    marker.sha256 === entry.sha256,
  );
}

function writeMarker(dir, marker) {
  const file = path.join(dir, MARKER_FILE);
  if (lstatOrNull(file)) fail(`refusing to overwrite the existing marker ${file}`);
  fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFreshDir(target, label) {
  if (lstatOrNull(target)) fail(`refusing to reuse the existing path ${target} as a fresh ${label}`);
  ensurePlainDir(target, label);
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt === 3) fail(`could not move the installed directory into ${to}: ${error.message}`);
      await delay(500);
    }
  }
}

function assertEntry(entry) {
  if (!entry || !['ghidra', 'jdk'].includes(entry.kind)) fail('invalid bootstrap artifact kind');
  for (const field of ['version', 'fileName', 'url', 'sha256', 'dirName']) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      fail(`bootstrap artifact ${entry.kind || '<unknown>'} is missing ${field}`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`bootstrap artifact ${entry.fileName} has an invalid SHA-256`);
  if (!/^https:\/\//.test(entry.url)) fail(`bootstrap artifact ${entry.fileName} is not an HTTPS URL`);
  if (entry.fileName !== path.basename(entry.fileName)) fail(`bootstrap artifact filename is not a basename: ${entry.fileName}`);
  if (entry.dirName !== path.basename(entry.dirName)) fail(`bootstrap artifact directory is not a basename: ${entry.dirName}`);
}

/**
 * Install one verified archive. Returns `{ dir, reused, sha256, hashSource }`.
 * The caller must still verify the installed layout and declared Java bounds.
 */
async function ensureArtifact(entry, options = {}) {
  assertEntry(entry);
  const root = options.root;
  if (!root) fail('ensureArtifact needs an install root');
  const log = options.log || logLine;
  const download = options.download || downloadFile;
  ensurePlainDir(root, 'install root');

  const target = path.join(root, entry.kind, entry.dirName);
  assertPlainAncestors(target, 'install target');
  const existing = lstatOrNull(target);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      fail(`refusing to overwrite ${target}: it is not a plain directory`);
    }
    const marker = readMarker(target);
    if (!markerMatches(marker, entry)) {
      fail(
        `refusing to overwrite ${target}: it exists but is not this exact rea-shim install ` +
        '(marker missing or different). Remove it manually if it is yours.',
      );
    }
    log(`reuse verified ${entry.name} ${entry.version} at ${target}`);
    return { dir: target, reused: true, sha256: entry.sha256, hashSource: entry.hashSource || 'install marker' };
  }

  assertTarAvailable();
  const cacheDir = path.join(root, 'cache', entry.sha256);
  ensurePlainDir(cacheDir, 'cache directory');
  const archive = path.join(cacheDir, entry.fileName);
  const existingArchive = lstatOrNull(archive);
  let createdArchive = false;

  if (existingArchive) {
    if (existingArchive.isSymbolicLink() || !existingArchive.isFile()) {
      fail(`refusing to read the cache entry ${archive}: it is not a plain file`);
    }
    const actual = await sha256File(archive);
    if (actual !== entry.sha256) {
      fail(
        `cached ${entry.fileName} at ${archive} does not match the official SHA-256 ` +
        `(${actual}); refusing to delete or overwrite a pre-existing file`,
      );
    }
    log(`reuse verified archive ${entry.fileName}`);
  } else {
    const part = path.join(cacheDir, `.${entry.fileName}.${process.pid}.${randomSuffix()}.part`);
    if (lstatOrNull(part)) fail(`refusing to reuse the existing partial download ${part}`);
    log(`download ${entry.url}`);
    let downloaded = false;
    try {
      await download(entry.url, part, {
        onProgress: ({ received, total, percent }) => {
          log(`  downloaded ${(received / (1024 * 1024)).toFixed(1)}${total > 0 ? ` / ${(total / (1024 * 1024)).toFixed(1)}` : ''} MiB${percent === null ? '' : ` (${percent}%)`}`);
        },
      });
      downloaded = true;
      const actual = await sha256File(part);
      if (actual !== entry.sha256) {
        fs.rmSync(part, { force: true });
        fail(`SHA-256 mismatch for ${entry.fileName}: expected ${entry.sha256}, got ${actual}. Download deleted; nothing was installed.`);
      }
      if (lstatOrNull(archive)) {
        const raced = await sha256File(archive);
        if (raced !== entry.sha256) {
          fs.rmSync(part, { force: true });
          fail(`cached ${entry.fileName} appeared during the download with a different SHA-256; refusing to overwrite it`);
        }
        fs.rmSync(part, { force: true });
      } else {
        fs.renameSync(part, archive);
        createdArchive = true;
      }
      log(`verified sha256 ${actual}`);
    } catch (error) {
      // A failed downloader cleans up its own partial file. Only a part this
      // run received is removed here.
      if (downloaded && lstatOrNull(part)) {
        try {
          fs.rmSync(part, { force: true });
        } catch {
          // The primary error is more useful than a cleanup error.
        }
      }
      throw error;
    }
  }

  // Keep the staging path short: Ghidra's archive is deeply nested and Windows
  // still enforces a 260-character path unless long paths are enabled.
  const staging = path.join(root, `.tmp-${randomSuffix()}`);
  createFreshDir(staging, 'staging directory');
  let installed = false;
  try {
    const names = listArchive(archive);
    const safe = assertSafeArchiveEntries(names);
    if (entry.expectedRootPattern && !entry.expectedRootPattern.test(safe.root)) {
      fail(`archive top-level directory ${safe.root} does not match the expected ${entry.expectedRootPattern}`);
    }
    log(`extract ${entry.fileName} (${names.length} entries)`);
    extractArchive(archive, staging);
    const entriesAtTop = fs.readdirSync(staging, { withFileTypes: true });
    if (entriesAtTop.length !== 1 || entriesAtTop[0].name !== safe.root) {
      fail(`archive extracted unexpected top-level entries: ${entriesAtTop.map((entry) => entry.name).join(', ')}`);
    }
    const extracted = path.join(staging, safe.root);
    if (!isPlainDir(extracted)) fail(`archive did not contain the expected directory ${safe.root}/`);
    assertInside(staging, extracted, 'extracted archive');
    assertNoReparsePoints(staging);

    writeMarker(extracted, {
      schema: MARKER_SCHEMA,
      name: entry.kind,
      version: entry.version,
      sha256: entry.sha256,
      url: entry.url,
      hashSource: entry.hashSource || null,
      source: 'official release archive',
      installedAt: new Date().toISOString(),
    });

    ensurePlainDir(path.dirname(target), 'install directory');
    if (lstatOrNull(target)) {
      fail(`refusing to overwrite ${target}: it appeared while the archive was being installed`);
    }
    await renameWithRetry(extracted, target);
    installed = true;
    log(`installed ${entry.name} ${entry.version} at ${target}`);
  } finally {
    removeOwnedDir(staging, log);
  }

  if (installed && createdArchive) {
    // This file was created by this run; removing it is not deleting a
    // pre-existing destination. A cache file reused from an earlier run stays.
    try {
      fs.rmSync(archive, { force: true });
    } catch {
      // Reclaiming cache space is best-effort; the install is already valid.
    }
    try {
      if (fs.readdirSync(cacheDir).length === 0) fs.rmdirSync(cacheDir);
    } catch {
      // Reclaiming an empty cache directory is best-effort.
    }
  }
  return { dir: target, reused: false, sha256: entry.sha256, hashSource: entry.hashSource || null };
}

function readPackageMarker(dir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
    if (!marker || marker.schema !== MARKER_SCHEMA || marker.name !== 'rea-agents') return null;
    return marker;
  } catch {
    return null;
  }
}

/**
 * Validate or create `<root>/npm-cache` and prove it, and every existing entry
 * beneath it, is canonical and inside the install root.
 *
 * npm writes through `npm_config_cache`; a pre-existing junction or symlink at
 * that path would silently redirect every cache write outside the owned root.
 * A junction one level deeper (`npm-cache/_cacache`) redirects just as well,
 * because npm creates and writes through `_cacache` and its descendants. So
 * the whole existing tree is walked, not just the cache root. The returned
 * canonical path is the one npm must receive. A plain existing directory is
 * reused untouched and its cache content stays available for reuse.
 */
function ensureNpmCache(root) {
  return ensureCanonicalDirInside(root, 'npm-cache', 'npm cache directory', {
    rejectReparseDescendants: true,
  });
}

function defaultNpmInstall({ staging, version, root, env, spawn = spawnSync }) {
  const args = [
    '/d', '/c', 'npm', 'install',
    '--prefix', staging,
    '--no-save',
    '--no-package-lock',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    `rea-agents@${version}`,
  ];
  // Verify the cache tree as late as possible: this is the last check before
  // npm gets the path, so a nested junction created earlier is refused and the
  // race window between the walk and npm's first write stays minimal.
  const npmCache = ensureNpmCache(root);
  const result = spawn('cmd.exe', args, {
    encoding: 'utf8',
    timeout: 900000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: npmChildEnv(env || process.env, npmCache, {
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_update_notifier: 'false',
      npm_config_loglevel: 'error',
      npm_config_yes: 'true',
    }),
  });
  if (result.error) fail(`npm install rea-agents@${version} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`npm install rea-agents@${version} failed (exit ${result.status}): ${String(result.stderr || '').trim().slice(-2000)}`);
  }
}

/**
 * Install the exact upstream rea-agents release into its own prefix. The
 * package is unmodified upstream code; npm verifies the registry integrity.
 */
async function ensureUpstreamPackage(options = {}) {
  const version = options.version;
  const root = options.root;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version || ''))) {
    fail(`bootstrap needs an exact upstream version, got '${version}'`);
  }
  if (!root) fail('ensureUpstreamPackage needs an install root');
  const log = options.log || logLine;
  const npmInstall = options.npmInstall || defaultNpmInstall;
  const env = options.env || process.env;
  ensurePlainDir(root, 'install root');

  const target = path.join(root, 'upstream', `rea-agents-${version}`);
  assertPlainAncestors(target, 'upstream install target');
  const existing = lstatOrNull(target);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      fail(`refusing to overwrite ${target}: it is not a plain directory`);
    }
    const marker = readPackageMarker(target);
    const packageJson = path.join(target, 'node_modules', 'rea-agents', 'package.json');
    if (!marker || marker.version !== version || !isPlainFile(packageJson)) {
      fail(
        `refusing to overwrite ${target}: it exists but is not this exact rea-shim upstream install. ` +
        'Remove it manually if it is yours.',
      );
    }
    const installed = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    if (installed.name !== 'rea-agents' || installed.version !== version) {
      fail(`refusing to overwrite ${target}: installed package is ${installed.name}@${installed.version}, expected rea-agents@${version}`);
    }
    const script = path.join(target, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs');
    if (!isPlainFile(script)) fail(`reused install ${target} has no scripts/rea.mjs`);
    if (!isPlainFile(path.join(target, 'node_modules', 'rea-agents', 'dist', 'ghidra', 'GhidraReleasePolicy.js'))) {
      fail(`reused install ${target} has no dist/ghidra/GhidraReleasePolicy.js`);
    }
    log(`reuse rea-agents@${version} at ${target}`);
    return {
      dir: target,
      packageDir: path.dirname(packageJson),
      script,
      version,
      integrity: marker.integrity || null,
      reused: true,
    };
  }

  ensureNpmCache(root);
  const staging = path.join(root, `.tmp-upstream-${randomSuffix()}`);
  createFreshDir(staging, 'upstream staging directory');
  let moved = false;
  try {
    // A minimal manifest makes the prefix a valid npm project without saving
    // rea-agents as a dependency (the exact tree is verified after install).
    fs.writeFileSync(
      path.join(staging, 'package.json'),
      `${JSON.stringify({ name: 'rea-shim-bootstrap', version: '0.0.0', private: true }, null, 2)}\n`,
    );
    log(`install rea-agents@${version} into ${target}`);
    await npmInstall({ staging, version, root, env });
    const packageDir = path.join(staging, 'node_modules', 'rea-agents');
    const packageJson = path.join(packageDir, 'package.json');
    if (!isPlainFile(packageJson)) fail(`npm install did not produce ${packageJson}`);
    const installed = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    if (installed.name !== 'rea-agents' || installed.version !== version) {
      fail(`npm installed ${installed.name}@${installed.version}, expected rea-agents@${version}`);
    }
    const script = path.join(packageDir, 'scripts', 'rea.mjs');
    if (!isPlainFile(script)) fail(`installed rea-agents@${version} has no scripts/rea.mjs`);
    if (!isPlainFile(path.join(packageDir, 'dist', 'ghidra', 'GhidraReleasePolicy.js'))) {
      fail(`installed rea-agents@${version} has no dist/ghidra/GhidraReleasePolicy.js`);
    }
    writeMarker(staging, {
      schema: MARKER_SCHEMA,
      name: 'rea-agents',
      version,
      integrity: options.integrity || null,
      source: 'npm registry',
      installedAt: new Date().toISOString(),
    });
    ensurePlainDir(path.dirname(target), 'upstream install directory');
    if (lstatOrNull(target)) {
      fail(`refusing to overwrite ${target}: it appeared while npm was installing`);
    }
    await renameWithRetry(staging, target);
    moved = true;
    log(`installed rea-agents@${version} at ${target}`);
    return {
      dir: target,
      packageDir: path.join(target, 'node_modules', 'rea-agents'),
      script: path.join(target, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'),
      version,
      integrity: options.integrity || null,
      reused: false,
    };
  } finally {
    if (!moved) removeOwnedDir(staging, log);
  }
  return null;
}

module.exports = {
  MARKER_FILE,
  MARKER_SCHEMA,
  defaultNpmInstall,
  ensureArtifact,
  ensureNpmCache,
  ensureUpstreamPackage,
  readMarker,
  readPackageMarker,
};
