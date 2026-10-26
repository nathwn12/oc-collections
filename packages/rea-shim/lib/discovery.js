'use strict';
//
// Read-only discovery for the normal `rea-shim` run path and for `--doctor`.
//
// The JDK requirement is never a shim constant: it is read from the selected
// Ghidra installation's `Ghidra/application.properties`
// (`application.java.min` and optional `application.java.max`). A bootstrap
// install is only a candidate directory; it is not preferred over an explicit
// environment override.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { lstatOrNull, isPlainDir, isPlainFile, realpathOrNull } = require('./support.js');

const MARKER_FILE = '.rea-shim-install.json';
const MARKER_SCHEMA = 2;
const HOME_ENV = 'REA_SHIM_HOME';
const GHIDRA_ENV = 'GHIDRA_INSTALL_DIR';
const JDK_ENV = 'REA_SHIM_JDK_HOME';
const GHIDRA_OVERRIDE_ENV = 'REA_SHIM_GHIDRA_DIR';
const AGENTS_VERSION_ENV = 'REA_SHIM_AGENTS_VERSION';
const STARTUP_TIMEOUT_ENV = 'REA_GHIDRA_STARTUP_TIMEOUT_MS';
const STARTUP_TIMEOUT_MS = '1500000';
const LEGACY_GHIDRA_ENVS = ['REA_GHIDRA_DIR', GHIDRA_ENV];
const LEGACY_JDK_ENVS = ['REA_JDK_HOME', 'JAVA_HOME'];

function bootstrapRoot(env = process.env) {
  const override = env[HOME_ENV];
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'rea-shim');
}

function readMarker(dir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
    if (!marker || marker.schema !== MARKER_SCHEMA) return null;
    if (typeof marker.name !== 'string' || typeof marker.version !== 'string') return null;
    if (typeof marker.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(marker.sha256)) return null;
    if (typeof marker.url !== 'string' || !/^https:\/\//.test(marker.url)) return null;
    return marker;
  } catch {
    return null;
  }
}

function compareVersionText(a, b) {
  const pa = String(a).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const difference = (pb[index] || 0) - (pa[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function listInstallDirs(base) {
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(base, entry.name));
  } catch {
    return [];
  }
}

// Discovery helpers only read. They never create a directory, download
// anything, or modify an existing install.
function bootstrapGhidraCandidates(env = process.env) {
  const base = path.join(bootstrapRoot(env), 'ghidra');
  const out = [];
  for (const dir of listInstallDirs(base)) {
    const marker = readMarker(dir);
    if (!marker || marker.name !== 'ghidra') continue;
    if (!isPlainFile(path.join(dir, 'Ghidra', 'application.properties'))) continue;
    out.push({
      dir,
      source: `rea-shim bootstrap (Ghidra ${marker.version})`,
      version: marker.version,
      installedAt: marker.installedAt || '',
    });
  }
  // The most recent bootstrap install is the user's latest choice; a version
  // sort alone could silently prefer an older install after upstream moves to
  // a different supported line.
  out.sort((a, b) =>
    String(b.installedAt).localeCompare(String(a.installedAt)) ||
    compareVersionText(b.version, a.version));
  return out;
}

function bootstrapJdkCandidates(env = process.env) {
  const base = path.join(bootstrapRoot(env), 'jdk');
  const out = [];
  for (const dir of listInstallDirs(base)) {
    const marker = readMarker(dir);
    if (!marker || marker.name !== 'jdk') continue;
    if (!isPlainFile(path.join(dir, 'bin', 'java.exe'))) continue;
    out.push({
      home: dir,
      source: `rea-shim bootstrap (JDK ${marker.version})`,
      override: false,
    });
  }
  return out;
}

function scoopRoot(env = process.env) {
  return env.SCOOP || path.join(os.homedir(), 'scoop');
}

function scoopAppCurrent(app, env = process.env) {
  return path.join(scoopRoot(env), 'apps', app, 'current');
}

// Comparison keys are local to discovery: nothing here decides a write, so the
// only job is to recognise the same directory across link spellings.
function comparablePath(target) {
  return String(target).replace(/[\\/]+$/, '').toLowerCase();
}

function candidateKey(target) {
  const real = realpathOrNull(target);
  return comparablePath(real || path.resolve(target));
}

/**
 * Resolve the canonical directory behind a Scoop `current` entry.
 *
 * Scoop publishes the active version of an app as a junction (link) at
 * `<scoop>\apps\<app>\current` pointing at the sibling version directory.
 * Read-only discovery must follow that link, but only when it cannot redirect
 * anywhere else: the entry must be named `current`, live directly in a plain
 * app directory, and resolve to an existing plain directory beside that app
 * directory. The canonical target is returned so nothing downstream reads or
 * launches through the link. Anything else resolves to null, and the
 * write-path checks in support.js never consult this helper.
 */
function resolveScoopCurrent(candidate) {
  const entry = path.resolve(candidate);
  if (path.basename(entry).toLowerCase() !== 'current') return null;
  const stat = lstatOrNull(entry);
  if (!stat || !stat.isSymbolicLink()) return null;
  const appDir = path.dirname(entry);
  if (!isPlainDir(appDir)) return null;
  const appRealDir = realpathOrNull(appDir);
  const target = realpathOrNull(entry);
  if (!appRealDir || !target) return null;
  const targetStat = lstatOrNull(target);
  if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) return null;
  if (comparablePath(path.dirname(target)) !== comparablePath(appRealDir)) return null;
  return target;
}

function resolveGhidra(env = process.env) {
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate.dir) return;
    let dir = candidate.dir;
    let linked = false;
    if (!isPlainDir(dir)) {
      // Read-only discovery may follow a safe Scoop `current` junction. Any
      // other link is still refused, and no install destination goes through
      // this path.
      dir = resolveScoopCurrent(dir);
      if (!dir) return;
      linked = true;
    }
    // Following a link must still land on the expected tool, not just any
    // sibling directory.
    if (linked && !isPlainFile(path.join(dir, 'Ghidra', 'application.properties'))) return;
    const key = candidateKey(dir);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ dir, source: candidate.source });
  };

  if (env[GHIDRA_OVERRIDE_ENV]) {
    add({ dir: path.resolve(env[GHIDRA_OVERRIDE_ENV]), source: GHIDRA_OVERRIDE_ENV });
  }
  for (const name of LEGACY_GHIDRA_ENVS) {
    if (env[name]) add({ dir: path.resolve(env[name]), source: name });
  }
  // A bootstrap install is an official unmodified release verified in place.
  // An explicit environment override above still wins.
  for (const candidate of bootstrapGhidraCandidates(env)) add(candidate);
  add({ dir: scoopAppCurrent('ghidra', env), source: 'scoop apps/ghidra/current' });

  return candidates.length > 0 ? candidates[0] : null;
}

function readProperties(file) {
  const values = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#') || clean.startsWith('!')) continue;
    const equals = clean.indexOf('=');
    if (equals < 0) continue;
    values.set(clean.slice(0, equals).trim(), clean.slice(equals + 1).trim());
  }
  return values;
}

/**
 * Read the JDK bounds declared by the installed Ghidra. This is the only
 * source of the requirement on both the run path and bootstrap. Missing or
 * malformed bounds are a hard failure: guessing a JDK floor is exactly the
 * stale shim constant this package must not carry.
 */
function ghidraJavaRequirement(dir) {
  const propertiesFile = path.join(dir, 'Ghidra', 'application.properties');
  if (!isPlainFile(propertiesFile)) {
    throw new Error(`Ghidra installation ${dir} has no readable Ghidra/application.properties`);
  }
  const properties = readProperties(propertiesFile);
  const version = properties.get('application.version') || null;
  const minimumRaw = String(properties.get('application.java.min') || '').trim();
  const maximumRaw = String(properties.get('application.java.max') || '').trim();
  const minimum = Number(minimumRaw);
  if (!Number.isInteger(minimum) || minimum <= 0) {
    throw new Error(`Ghidra ${dir} does not declare a positive integer application.java.min`);
  }
  let maximum = null;
  if (maximumRaw) {
    maximum = Number(maximumRaw);
    if (!Number.isInteger(maximum) || maximum < minimum) {
      throw new Error(`Ghidra ${dir} declares application.java.max=${maximumRaw}, which is not an integer >= ${minimum}`);
    }
  }
  return { minimum, maximum, version, propertiesFile };
}

function javaRequirementLabel(requirement) {
  if (!requirement) return 'unknown';
  return requirement.maximum === null
    ? `>= ${requirement.minimum}`
    : `${requirement.minimum}..${requirement.maximum}`;
}

function javaMajor(home) {
  let text = '';
  try {
    const result = spawnSync(path.join(home, 'bin', 'java.exe'), ['-version'], {
      timeout: 30000,
      encoding: 'utf8',
      windowsHide: true,
    });
    text = String((result && result.stdout) || '') + String((result && result.stderr) || '');
    if (result && result.error) return null;
  } catch {
    return null;
  }
  const match = text.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  if (match[1] === '1' && match[2]) return Number(match[2]);
  return Number(match[1]);
}

function collectJdkCandidates(env = process.env) {
  const homes = [];
  if (env[JDK_ENV]) homes.push({ home: path.resolve(env[JDK_ENV]), source: JDK_ENV, override: true });
  for (const name of LEGACY_JDK_ENVS) {
    if (env[name]) homes.push({ home: path.resolve(env[name]), source: name, override: false });
  }
  for (const candidate of bootstrapJdkCandidates(env)) homes.push(candidate);

  try {
    const appsDir = path.join(scoopRoot(env), 'apps');
    for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const current = path.join(appsDir, entry.name, 'current');
      // A Scoop JDK is published as `apps\<jdk>\current`, a junction to the
      // sibling version directory; follow only that safe shape.
      const home = isPlainDir(current) ? current : resolveScoopCurrent(current);
      if (home && isPlainFile(path.join(home, 'bin', 'java.exe'))) {
        homes.push({ home, source: `scoop ${entry.name}`, override: false });
      }
    }
  } catch {
    // No scoop tree: not an error, just no candidates from it.
  }

  try {
    const adoptium = 'C:\\Program Files\\Eclipse Adoptium';
    for (const entry of fs.readdirSync(adoptium, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^jdk-/i.test(entry.name)) continue;
      const home = path.join(adoptium, entry.name);
      if (isPlainFile(path.join(home, 'bin', 'java.exe'))) {
        homes.push({ home, source: 'Eclipse Adoptium', override: false });
      }
    }
  } catch {
    // Absent Adoptium root: not an error.
  }
  return homes;
}

function versionTuple(home) {
  const match = String(home).match(/jdk-(\d+(?:[._]\d+)*)/i);
  if (!match) return [];
  return match[1].split(/[._]/).map(Number);
}

function compareHomes(a, b) {
  if (a.major !== b.major) return b.major - a.major;
  const ta = versionTuple(a.home);
  const tb = versionTuple(b.home);
  for (let index = 0; index < Math.max(ta.length, tb.length); index += 1) {
    const difference = (tb[index] || 0) - (ta[index] || 0);
    if (difference !== 0) return difference;
  }
  return a.home < b.home ? -1 : 1;
}

function satisfies(requirement, major) {
  if (!Number.isInteger(major)) return false;
  if (major < requirement.minimum) return false;
  if (requirement.maximum !== null && major > requirement.maximum) return false;
  return true;
}

function resolveJdk(requirement, env = process.env) {
  if (!requirement || !Number.isInteger(requirement.minimum)) {
    throw new Error('cannot resolve a JDK without the Ghidra application.java.min requirement');
  }
  const candidates = collectJdkCandidates(env);
  const seen = new Set();
  const viable = [];
  for (const candidate of candidates) {
    if (!candidate.home) continue;
    const key = candidateKey(candidate.home);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isPlainFile(path.join(candidate.home, 'bin', 'java.exe'))) {
      if (candidate.override) {
        throw new Error(
          `${JDK_ENV}='${candidate.home}' has no bin\\java.exe. ` +
          `Point it at a full JDK satisfying Ghidra's declared ${javaRequirementLabel(requirement)} requirement, or unset it.`,
        );
      }
      continue;
    }
    const major = javaMajor(candidate.home);
    if (major === null) {
      if (candidate.override) {
        throw new Error(
          `${JDK_ENV}='${candidate.home}' exists but 'bin\\java.exe -version' gave no parseable version. ` +
          `Point it at a full JDK satisfying Ghidra's declared ${javaRequirementLabel(requirement)} requirement.`,
        );
      }
      continue;
    }
    if (!satisfies(requirement, major)) {
      if (candidate.override) {
        throw new Error(
          `${JDK_ENV}='${candidate.home}' is java major ${major}, outside Ghidra's declared ` +
          `${javaRequirementLabel(requirement)} requirement.`,
        );
      }
      continue;
    }
    if (candidate.override) return { home: candidate.home, major, source: candidate.source };
    viable.push({ home: candidate.home, major, source: candidate.source });
  }
  if (viable.length === 0) return null;
  viable.sort(compareHomes);
  return viable[0];
}

module.exports = {
  AGENTS_VERSION_ENV,
  GHIDRA_ENV,
  GHIDRA_OVERRIDE_ENV,
  HOME_ENV,
  JDK_ENV,
  LEGACY_GHIDRA_ENVS,
  LEGACY_JDK_ENVS,
  MARKER_FILE,
  MARKER_SCHEMA,
  STARTUP_TIMEOUT_ENV,
  STARTUP_TIMEOUT_MS,
  bootstrapGhidraCandidates,
  bootstrapJdkCandidates,
  bootstrapRoot,
  collectJdkCandidates,
  compareVersionText,
  ghidraJavaRequirement,
  javaMajor,
  javaRequirementLabel,
  readMarker,
  readProperties,
  resolveGhidra,
  resolveJdk,
  resolveScoopCurrent,
  satisfies,
  scoopAppCurrent,
};
