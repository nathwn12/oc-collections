// In-place upgrade for the command layer.
//
// One rule decides this file: never point `current.json` at a version that has
// not answered for itself. A candidate is installed into a full npm prefix
// beside the running version, asked for `--version` and made to run a real
// command there, moved into place whole, and asked again from its final path.
// Every earlier failure leaves the pointer byte-identical to what it was, so the
// worst case is a wasted download and a directory that is never named.
//
// The version directory is an npm prefix, not a package: its own
// `node_modules/@nathwn12/janua` is the CLI and its siblings are the CLI's
// dependencies, which is why the whole prefix moves and not just the package.
//
// The running process is never touched: an upgrade changes what the *next*
// client start resolves to, not what is already in memory.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ERROR_CODES, JanuaError, invalidArgs } from './errors.js';

const PACKAGE_NAME = '@nathwn12/janua';

export const POINTER_FILE = 'current.json';
export const LOCK_FILE = 'upgrade.lock';
const VERSIONS_DIR = 'versions';
/** What a pointer names, relative to its version prefix. Never the launcher. */
export const CLI_ENTRY = `node_modules/${PACKAGE_NAME}/bin/janua-cli.js`;
/** The line a candidate must print from a real `run` before it may be current. */
export const RUN_MARKER = 'UPGRADE_OK';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PROBE_TIMEOUT_MS = 15000;
const INSTALL_TIMEOUT_MS = 600000;
// Internal directory names inside `versions/`. `~` cannot appear in a version,
// so a leftover can always be traced back to the version it belongs to.
const STAGE_PREFIX = '.stage-';
const OLD_PREFIX = '.old-';

/**
 * Where versions live: JANUA_HOME if set, otherwise the platform's data dir.
 * `platform` and `env` are injectable so the other platform's branch is testable.
 */
export function resolveHome(env = process.env, platform = process.platform) {
  if (env.JANUA_HOME) return env.JANUA_HOME;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'janua');
  }
  const base = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'janua');
}

/** The pointer, or null when there is none, it is unreadable, or it is malformed. */
export function readPointer(home = resolveHome()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(home, POINTER_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.version !== 'string' || !VERSION_PATTERN.test(parsed.version)) {
    return null;
  }
  // A pointer may only name the CLI entry. Anything else, the launcher above all,
  // would make `janua` spawn itself, so it is treated as no pointer at all.
  const bin = parsed.bin === undefined ? CLI_ENTRY : parsed.bin;
  if (bin !== CLI_ENTRY) return null;
  return { version: parsed.version, bin };
}

/** The absolute bin the pointer names, if that file is really there. */
export function pointerBinPath(home = resolveHome()) {
  const pointer = readPointer(home);
  if (!pointer) return null;
  const bin = join(home, VERSIONS_DIR, pointer.version, pointer.bin);
  return existsSync(bin) ? bin : null;
}

function upgradeFailed(message) {
  return new JanuaError(ERROR_CODES.UPGRADE_FAILED, message);
}

function assertVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw invalidArgs(`"${version}" is not a version like 0.4.0`);
  }
  return version;
}

function describe(err) {
  return err && err.message ? err.message : String(err);
}

// --- process probes -------------------------------------------------------

function probe(bin, args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // A candidate that hangs is a candidate that failed.
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) return { ok: false, code: -1, out: result.error.message };
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, code: result.status ?? -1, out };
}

/**
 * Prove a version prefix is a working install of `version`: the CLI inside it
 * answers `--version` and can execute a real command. Both run through the
 * installed bin, so a missing sibling dependency fails here, not later.
 */
function verify(prefix, version) {
  const bin = join(prefix, CLI_ENTRY);
  if (!existsSync(bin)) return { ok: false, reason: `${prefix} has no ${CLI_ENTRY}` };

  const versioned = probe(bin, ['--version']);
  if (!versioned.ok || versioned.out !== version) {
    return {
      ok: false,
      reason: `--version exit ${versioned.code}, answered "${versioned.out}", want "${version}"`,
    };
  }

  const ran = probe(bin, [
    'run',
    '--',
    process.execPath,
    '-e',
    `process.stdout.write(${JSON.stringify(RUN_MARKER)})`,
  ]);
  if (!ran.ok || ran.out !== RUN_MARKER) {
    return {
      ok: false,
      reason: `run exit ${ran.code}, answered "${ran.out}", want "${RUN_MARKER}"`,
    };
  }

  return { ok: true };
}

// --- npm ------------------------------------------------------------------

function quoteForCmd(arg) {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg}"` : arg;
}

// npm on Windows is a batch shim, and Node refuses to spawn a .cmd without a
// shell. The command line is assembled here instead, with every argument that
// needs it quoted; the version is validated before it can reach this call.
export function npmCommandLine(args) {
  if (process.platform !== 'win32') return { file: 'npm', args, shell: false };
  return { file: ['npm', ...args].map(quoteForCmd).join(' '), args: [], shell: true };
}

function runNpm(args, timeoutMs) {
  const command = npmCommandLine(args);
  const result = spawnSync(command.file, command.args, {
    encoding: 'utf8',
    shell: command.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) throw upgradeFailed(`npm could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ');
    throw upgradeFailed(`npm ${args[0]} failed with exit ${result.status}: ${detail}`);
  }
  return `${result.stdout ?? ''}`;
}

/** The exact install command an upgrade runs for a version. */
export function npmInstallArgs(version) {
  return ['install', PACKAGE_NAME + '@' + version, '--omit=dev', '--no-audit', '--no-fund'];
}

/** Default installer: published package, and its dependencies, into an npm prefix. */
export function npmInstall({ prefix, version }) {
  runNpm(['install', '--prefix', prefix, `${PACKAGE_NAME}@${version}`, '--omit=dev', '--no-audit', '--no-fund'], INSTALL_TIMEOUT_MS);
}

/** Default latest lookup: ask the registry, nothing else. */
export function npmLatest() {
  const out = runNpm(['view', PACKAGE_NAME, 'version'], 60000).trim();
  return assertVersion(out.split('\n').pop().trim());
}

// --- lock -----------------------------------------------------------------

const OWNER_FILE = 'owner.json';

function readOwner(lockDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(lockDir, OWNER_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Remove the lock only when it is still ours; anyone else's is left untouched. */
function release(lockDir, token) {
  const owner = readOwner(lockDir);
  if (!owner || owner.token !== token) return;
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* the next upgrade reports the lock it cannot take */
  }
}

/**
 * Take the one upgrade slot. The lock is a directory, because `mkdir` is the one
 * create that cannot overwrite and cannot race: exactly one upgrader wins, and a
 * holder never removes a lock it does not own. There is no timeout and no
 * reclaim: the old version stays current, and a lock left by a killed upgrade is
 * the operator's call, since only they know whether a `janua upgrade` is still
 * out there. The refusal names the lock and says how to clear it.
 */
function acquireLock(home, { now = Date.now } = {}) {
  const lockDir = join(home, LOCK_FILE);
  const token = randomUUID();

  try {
    mkdirSync(lockDir);
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      throw upgradeFailed(`cannot take ${lockDir}: ${describe(err)}`);
    }
    const owner = readOwner(lockDir);
    const who = owner && Number.isInteger(owner.pid) ? ` (pid ${owner.pid})` : '';
    throw new JanuaError(
      ERROR_CODES.UPGRADE_IN_PROGRESS,
      `another upgrade holds ${lockDir}${who}; if no \`janua upgrade\` is running, `
      + 'delete that directory and run the upgrade again',
    );
  }

  try {
    writeFileSync(
      join(lockDir, OWNER_FILE),
      `${JSON.stringify({ pid: process.pid, startedAt: now(), token })}\n`,
    );
  } catch (err) {
    // The directory is ours: we made it a moment ago and nobody else may hold it.
    rmSync(lockDir, { recursive: true, force: true });
    throw upgradeFailed(`cannot record the upgrade owner in ${lockDir}: ${describe(err)}`);
  }

  return () => release(lockDir, token);
}

// --- staging, moving, and the pointer -------------------------------------

/**
 * Install into a private prefix and prove it there. Nothing is moved while the
 * candidate is still unverified, so a bad release never occupies a version name.
 */
function stage({ versionsDir, version, install, home }) {
  const prefix = join(versionsDir, `${STAGE_PREFIX}${version}~${process.pid}~${randomUUID()}`);
  mkdirSync(prefix, { recursive: true });

  try {
    install({ prefix, version, home });
  } catch (err) {
    rmSync(prefix, { recursive: true, force: true });
    throw err instanceof JanuaError ? err : upgradeFailed(`install failed: ${describe(err)}`);
  }

  // The candidate answers from the prefix, with its siblings where npm put them.
  const check = verify(prefix, version);
  if (!check.ok) {
    rmSync(prefix, { recursive: true, force: true });
    throw upgradeFailed(`${version} is not usable: ${check.reason}`);
  }

  return prefix;
}

function restore(backup, target) {
  try {
    renameSync(backup, target);
  } catch {
    /* the previous tree stays under versions/.old-… for a manual rollback */
  }
}

/**
 * Move the staged prefix onto `versions/<v>` and prove it again from where the
 * pointer will find it. An existing tree is renamed aside first, so a failed
 * swap puts the previous install back instead of leaving a hole. A prefix is a
 * directory tree, so the move is one rename: never a half-copied version.
 */
function swap({ prefix, target, versionsDir, version }) {
  const backup = join(versionsDir, `${OLD_PREFIX}${version}~${randomUUID()}`);
  rmSync(backup, { recursive: true, force: true });
  const hadTarget = existsSync(target);
  if (hadTarget) renameSync(target, backup);

  try {
    renameSync(prefix, target);
  } catch (err) {
    rmSync(prefix, { recursive: true, force: true });
    if (hadTarget) restore(backup, target);
    throw upgradeFailed(`cannot move ${version} into ${target}: ${describe(err)}`);
  }

  // The path the pointer will name, asked from that path.
  const check = verify(target, version);
  if (!check.ok) {
    rmSync(target, { recursive: true, force: true });
    if (hadTarget) restore(backup, target);
    throw upgradeFailed(`${version} does not answer from ${target}: ${check.reason}`);
  }

  if (hadTarget) rmSync(backup, { recursive: true, force: true });
}

/** Clear what a killed upgrade left behind; a backup with no version left is kept. */
function sweep(versionsDir) {
  let entries;
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(STAGE_PREFIX)) {
      rmSync(join(versionsDir, name), { recursive: true, force: true });
      continue;
    }
    if (!name.startsWith(OLD_PREFIX)) continue;
    const version = name.slice(OLD_PREFIX.length).split('~')[0];
    // Only sweep a backup whose version is already installed again: otherwise it
    // is the last copy of that version and the rollback target.
    if (existsSync(join(versionsDir, version))) {
      rmSync(join(versionsDir, name), { recursive: true, force: true });
    }
  }
}

function writePointer(home, version) {
  const target = join(home, POINTER_FILE);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ version, bin: CLI_ENTRY }, null, 2)}\n`);
    renameSync(tmp, target); // atomic replace; until it lands the old pointer stands
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the temp file is worthless either way */
    }
    throw upgradeFailed(`cannot write ${target}: ${describe(err)}`);
  }
}

/**
 * Install `version` (or the newest published one) beside the current install,
 * prove it works, then move the pointer. The previous version is left on disk.
 */
export async function upgrade(options = {}) {
  const {
    version: requested,
    home = resolveHome(),
    install = npmInstall,
    resolveLatest = npmLatest,
    now = Date.now,
  } = options;

  if (requested !== undefined) assertVersion(requested);

  const versionsDir = join(home, VERSIONS_DIR);
  mkdirSync(versionsDir, { recursive: true });

  const releaseLock = acquireLock(home, { now });
  try {
    sweep(versionsDir);

    const from = readPointer(home)?.version ?? null;
    const version = requested === undefined ? resolveLatest() : requested;
    assertVersion(version);
    const started = now();
    const target = join(versionsDir, version);

    if (version === from && existsSync(join(target, CLI_ENTRY))) {
      return { from, to: version, home, alreadyCurrent: true, staged: false, verified: false, switched: false };
    }

    // A version already on disk and still answering is used as it stands: a
    // rollback to the version kept beside the new one costs no network.
    const kept = existsSync(target) ? verify(target, version) : { ok: false };
    let staged = false;

    if (!kept.ok) {
      const prefix = stage({ versionsDir, version, install, home });
      swap({ prefix, target, versionsDir, version });
      staged = true;
    }

    writePointer(home, version);

    return {
      from,
      to: version,
      home,
      versionDir: target,
      previous: from === null ? null : join(versionsDir, from),
      alreadyCurrent: false,
      staged,
      verified: true,
      switched: true,
      durationMs: now() - started,
    };
  } finally {
    releaseLock();
  }
}
