'use strict';
//
// The one no-argument entry: verify, install, configure, start.
//
// Runtime trust is the exact pinned SHA-256 checked with native Node crypto
// before any extraction. A bad hash installs nothing and gives one recovery
// path: rerun the command. A rerun checks the install marker, skips the download
// entirely and never touches an existing config.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const support = require('./support.js');
const sources = require('./sources.js');
const settings = require('./settings.js');

const HOME_ENV = 'REA_SHIM_HOME';
const MARKER_FILE = '.rea-shim-craft-install.json';
const MARKER_SCHEMA = 1;

function fail(message) {
  throw new Error(message);
}

function installRoot(env = process.env) {
  const override = env[HOME_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim(), 'craft-anything');
  }
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'rea-shim', 'craft-anything');
}

function appDir(root, source) {
  return path.join(root, 'app', source.version, source.archiveRoot);
}

function configDirFor(root) {
  return settings.configDirFor(root);
}

function readMarker(dir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
    if (!marker || marker.schema !== MARKER_SCHEMA) return null;
    return marker;
  } catch {
    return null;
  }
}

function markerMatches(marker, source) {
  return Boolean(
    marker &&
    marker.schema === MARKER_SCHEMA &&
    marker.version === source.version &&
    marker.sha256 === source.sha256,
  );
}

function assertPinnedSize(file, source) {
  const observed = fs.statSync(file).size;
  if (observed !== source.bytes) {
    fail(`${source.fileName} is ${observed} bytes; expected ${source.bytes}. Refusing to hash or extract a payload of the wrong size.`);
  }
}

async function renameWithRetry(from, to, options = {}) {
  const rename = options.rename || fs.renameSync;
  const attempts = 4;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs || 250));
      }
    }
  }
  fail(`could not move the verified archive after ${attempts} attempts: ${lastError && lastError.message ? lastError.message : lastError}`);
}

function writeMarker(dir, source) {
  const file = path.join(dir, MARKER_FILE);
  if (support.lstatOrNull(file)) fail(`refusing to overwrite the existing marker ${file}`);
  fs.writeFileSync(file, `${JSON.stringify({
    schema: MARKER_SCHEMA,
    name: source.name,
    version: source.version,
    sha256: source.sha256,
    url: source.url,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, { flag: 'wx' });
}

async function ensureInstalled(options = {}) {
  const admitted = sources.resolveSource(options.platform, options.arch);
  const source = options.source || admitted;
  const root = options.root;
  if (!root) fail('an install root is required');
  const log = options.log || support.logLine;
  const download = options.download || support.downloadFile;

  support.ensurePlainDir(root, 'install root');
  const target = appDir(root, source);
  support.assertPlainAncestors(target, 'install target');
  const exe = path.join(target, source.exeName);
  const existing = support.lstatOrNull(target);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      fail(`refusing to overwrite ${target}: it is not a plain directory`);
    }
    if (!markerMatches(readMarker(target), source) || !support.isPlainFile(exe)) {
      fail(`refusing to overwrite ${target}: it is not this exact verified install. Remove it manually if it is yours.`);
    }
    log(`reuse verified ${source.name} ${source.version} at ${target}`);
    return { dir: target, exe, reused: true, sha256: source.sha256 };
  }

  support.assertTarAvailable();
  const cacheDir = path.join(root, 'cache', source.sha256);
  const archive = path.join(cacheDir, source.fileName);
  const existingArchive = support.lstatOrNull(archive);
  let part = null;
  if (existingArchive) {
    if (existingArchive.isSymbolicLink() || !existingArchive.isFile()) {
      fail(`refusing to read the cache entry ${archive}: it is not a plain file`);
    }
    assertPinnedSize(archive, source);
    const cached = await support.sha256File(archive);
    if (cached !== source.sha256) {
      fail(`cached ${source.fileName} does not match the pinned SHA-256 (${cached}); refusing to delete or overwrite a pre-existing file`);
    }
    log(`reuse verified archive ${source.fileName}`);
  } else {
    support.ensurePlainDir(cacheDir, 'cache directory');
    part = path.join(root, `.craft-${process.pid}-${support.randomSuffix()}.part`);
    if (support.lstatOrNull(part)) fail(`refusing to reuse the existing partial download ${part}`);
    log(`download ${source.url}`);
    await download(source.url, part, options.downloadOptions || {});
    try {
      assertPinnedSize(part, source);
    } catch (error) {
      fs.rmSync(part, { force: true });
      throw error;
    }
    const actual = await support.sha256File(part);
    if (actual !== source.sha256) {
      fs.rmSync(part, { force: true });
      fail(
        `SHA-256 mismatch for ${source.fileName}: expected ${source.sha256}, got ${actual}. ` +
        'The partial download was removed; rerun the command to try again.',
      );
    }
    const raced = support.lstatOrNull(archive);
    if (raced) {
      const racedHash = await support.sha256File(archive);
      fs.rmSync(part, { force: true });
      if (racedHash !== source.sha256) fail(`cached ${source.fileName} appeared with a different SHA-256; refusing to overwrite it`);
    } else {
      try {
        await renameWithRetry(part, archive, { rename: options.rename, retryDelayMs: options.retryDelayMs });
        part = null;
      } catch (error) {
        fs.rmSync(part, { force: true });
        throw error;
      }
    }
    log(`verified sha256 ${actual}`);
  }

  const staging = path.join(root, `.stage-${support.randomSuffix()}`);
  support.ensurePlainDir(staging, 'staging directory');
  let installed = false;
  try {
    const names = support.listArchive(archive);
    const safe = support.assertSafeArchiveEntries(names);
    if (safe.root !== source.archiveRoot) {
      fail(`archive top-level directory ${safe.root} does not match the pinned ${source.archiveRoot}`);
    }
    log(`extract ${source.fileName} (${names.length} entries)`);
    support.extractArchive(archive, staging);
    const extracted = path.join(staging, safe.root);
    support.assertInside(staging, extracted, 'extracted archive');
    if (!support.isPlainDir(extracted)) fail(`archive did not contain ${safe.root}/`);
    support.assertNoReparsePoints(extracted);
    const stagedExe = path.join(extracted, source.exeName);
    if (!support.isPlainFile(stagedExe)) fail(`archive has no ${source.exeName}`);
    if (!support.isPlainFile(path.join(extracted, source.portableMarker))) {
      fail(`archive has no ${source.portableMarker}; refusing to assume a config location`);
    }
    writeMarker(extracted, source);
    support.ensurePlainDir(path.dirname(target), 'install directory');
    if (support.lstatOrNull(target)) fail(`refusing to overwrite ${target}: it appeared during extraction`);
    fs.renameSync(extracted, target);
    installed = true;
    log(`installed ${source.name} ${source.version} at ${target}`);
  } finally {
    support.removeOwnedDir(staging, log);
  }
  if (installed && part) fs.rmSync(part, { force: true });
  return { dir: target, exe, reused: false, sha256: source.sha256, cached: existingArchive !== null };
}

function launch(options = {}) {
  if (!options.exe) fail('an executable path is required to launch');
  const root = options.root;
  if (!root) fail('an install root is required to launch');
  const spawnFn = options.spawn || spawn;
  const child = spawnFn(options.exe, [], {
    cwd: path.dirname(options.exe),
    stdio: 'inherit',
    env: settings.launchEnv(root, options.env || process.env),
    windowsHide: true,
    shell: false,
    detached: false,
  });
  if (child && typeof child.on === 'function') {
    child.on('error', (error) => {
      support.logLine(`cannot start Craft Anything: ${error.message}`);
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      process.exitCode = code === null ? 1 : code;
    });
  }
  return child;
}

function launchCli(options = {}) {
  if (!options.exe) fail('an executable path is required to start the CLI');
  const root = options.root;
  if (!root) fail('an install root is required to start the CLI');
  const spawnFn = options.spawn || spawn;
  const child = spawnFn(options.exe, ['mcp'], {
    cwd: path.dirname(options.exe),
    stdio: 'inherit',
    env: settings.launchEnv(root, options.env || process.env),
    windowsHide: true,
    shell: false,
    detached: false,
  });
  if (child && typeof child.on === 'function') {
    child.on('error', (error) => {
      support.logLine(`cannot start the Craft Anything CLI: ${error.message}`);
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      process.exitCode = signal ? 1 : (code === null ? 1 : code);
    });
  }
  return child;
}

async function runMcp(options = {}) {
  const env = options.env || process.env;
  const root = options.root || installRoot(env);
  const log = options.log || support.logLine;
  const admitted = sources.resolveSource(options.platform, options.arch);
  const source = options.source || admitted;
  const installed = await ensureInstalled({ ...options, root, env, log, source });
  const config = settings.ensureFirstRunSettings(root, options.settings || {});
  log(`config ${config.created ? 'created' : 'preserved'} at ${config.path}`);
  const cli = path.join(installed.dir, source.cliExeName);
  if (!support.isPlainFile(cli)) fail(`the pinned release has no ${source.cliExeName}`);
  log(`starting ${source.cliExeName} mcp`);
  const child = launchCli({ exe: cli, root, env, spawn: options.spawn });
  return { ...installed, settings: config.path, settingsCreated: config.created, child };
}

async function run(options = {}) {
  const env = options.env || process.env;
  const root = options.root || installRoot(env);
  const log = options.log || support.logLine;
  const installed = await ensureInstalled({ ...options, root, env, log });
  const config = settings.ensureFirstRunSettings(root, options.settings || {});
  log(`config ${config.created ? 'created' : 'preserved'} at ${config.path}`);
  const child = launch({ exe: installed.exe, root, env, spawn: options.spawn });
  return {
    ...installed,
    settings: config.path,
    settingsCreated: config.created,
    child,
  };
}

module.exports = {
  HOME_ENV,
  MARKER_FILE,
  MARKER_SCHEMA,
  appDir,
  configDirFor,
  ensureInstalled,
  installRoot,
  launch,
  launchCli,
  run,
  runMcp,
};
