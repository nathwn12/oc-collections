// Upgrade tests run against a temporary JANUA_HOME and locally built version
// prefixes, so they never touch the network, the real home, or the global
// install. The installer is injected everywhere it would have been npm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CLI_ENTRY,
  LOCK_FILE,
  POINTER_FILE,
  RUN_MARKER,
  npmCommandLine,
  npmInstallArgs,
  readPointer,
  resolveHome,
  upgrade,
} from '../lib/upgrade.js';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin');
const LAUNCHER = join(BIN, 'janua.js');
const CLI = join(BIN, 'janua-cli.js');
const UPGRADE_MODULE = pathToFileURL(join(here, '..', 'lib', 'upgrade.js')).href;
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const DEP_NAME = 'janua-test-dep';

/** A throwaway root with its own `home` and `fixtures`, removed when the test ends. */
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'janua-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home: join(root, 'home'), fixtures: join(root, 'fixtures') };
}

/**
 * A stand-in for one published version, laid out as npm lays a prefix out: the
 * package under `node_modules/@nathwn12/janua`, its dependency beside it. The
 * CLI imports that dependency, so a prefix that lost its siblings cannot start.
 */
function buildVersion(fixtures, version, { versionOutput = version, runOutput = RUN_MARKER, dep = true, postMoveLie = false } = {}) {
  const root = join(fixtures, version);
  const pkgDir = join(root, 'node_modules', '@nathwn12', 'janua');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    `${JSON.stringify({ name: '@nathwn12/janua', version, type: 'module' })}\n`,
  );

  if (dep) {
    const depDir = join(root, 'node_modules', DEP_NAME);
    mkdirSync(join(depDir, 'src'), { recursive: true });
    writeFileSync(
      join(depDir, 'package.json'),
      `${JSON.stringify({ name: DEP_NAME, version: '1.0.0', type: 'module', exports: './src/index.js' })}\n`,
    );
    writeFileSync(join(depDir, 'src', 'index.js'), 'export const depReady = true;\n');
  }

  // `postMoveLie` answers honestly under `.stage-` and wrongly anywhere else, so
  // the staged check passes and only the post-move check can catch it.
  const lyingVersion = postMoveLie ? '0.0.0' : versionOutput;
  const lyingRun = postMoveLie ? 'BROKEN' : runOutput;

  writeFileSync(join(pkgDir, 'bin', 'janua-cli.js'), `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { depReady } from ${JSON.stringify(DEP_NAME)};
if (!depReady) process.exit(3);
const moved = !process.argv[1].includes('.stage-');
const saysVersion = moved ? ${JSON.stringify(lyingVersion)} : ${JSON.stringify(versionOutput)};
const saysRun = moved ? ${JSON.stringify(lyingRun)} : ${JSON.stringify(runOutput)};
const args = process.argv.slice(2);
const [first] = args;
if (first === '--version') {
  process.stdout.write(saysVersion + '\\n');
  process.exit(0);
}
if (first === 'run') {
  // Run the command after -- for real, like the real CLI does, then answer.
  const command = args[args.indexOf('--') + 1];
  if (!command) process.exit(2);
  const child = spawnSync(command, args.slice(args.indexOf('--') + 2), { encoding: 'utf8' });
  if (child.status !== 0) {
    process.stderr.write(String(child.stdout || '') + String(child.stderr || ''));
    process.exit(child.status ?? 1);
  }
  process.stdout.write(saysRun);
  process.exit(0);
}
if (first === 'serve') {
  process.stdout.write('READY\\n');
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
`);

  return root;
}

/** What npm would have produced: the whole prefix, siblings included. */
function installerFor(fixtures) {
  return ({ prefix, version }) => {
    rmSync(prefix, { recursive: true, force: true });
    cpSync(join(fixtures, version), prefix, { recursive: true });
  };
}

function pointerText(home) {
  return readFileSync(join(home, POINTER_FILE), 'utf8');
}

function alive(child) {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(child.pid, 0); // existence probe only
    return true;
  } catch {
    return false;
  }
}

function startVersion(dir) {
  const child = spawn(process.execPath, [join(dir, CLI_ENTRY), 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no READY within 10s (got "${out}")`)), 10000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (out.includes('READY')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code} before READY`));
    });
  });
}

function launcherRun(home, args) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, JANUA_HOME: home },
  });
}

/**
 * A second process that upgrades the same home, with a slow installer, so two
 * upgrades really are in flight at once. It is a real CLI process: it imports
 * the module under test and calls it exactly as `janua upgrade` does.
 */
function upgradeWorker(root, name, { delayMs }) {
  const file = join(root, `${name}.mjs`);
  writeFileSync(file, `
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const { upgrade } = await import(${JSON.stringify(UPGRADE_MODULE)});
const [home, fixtures, version, delay, flag] = process.argv.slice(2);
try {
  const receipt = await upgrade({
    version,
    home,
    install: ({ prefix, version: v }) => {
      writeFileSync(flag, 'installing');
      // Hold the lock long enough to collide, without spinning a core.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delay));
      rmSync(prefix, { recursive: true, force: true });
      cpSync(join(fixtures, v), prefix, { recursive: true });
    },
  });
  process.stdout.write('SWITCHED ' + receipt.to + '\\n');
} catch (err) {
  process.stdout.write('BUSY ' + (err && err.code) + '\\n');
  process.exit(1);
}
`);
  return file;
}

function waitForFile(path, timeoutMs) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() > until) return reject(new Error(`${path} never appeared`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('upgrade stages a whole prefix, verifies it, and switches the pointer', async (t) => {
  const { home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  buildVersion(fixtures, '0.0.2');

  const first = await upgrade({ version: '0.0.1', home, install });
  assert.equal(first.from, null);
  assert.equal(first.verified, true);
  assert.equal(first.switched, true);
  assert.deepEqual(readPointer(home), { version: '0.0.1', bin: CLI_ENTRY });

  const second = await upgrade({ version: '0.0.2', home, install });
  assert.equal(second.from, '0.0.1');
  assert.equal(second.to, '0.0.2');
  assert.deepEqual(readPointer(home), { version: '0.0.2', bin: CLI_ENTRY });

  // The version directory is an npm prefix: the package and its sibling dep.
  const prefix = join(home, 'versions', '0.0.2');
  assert.ok(existsSync(join(prefix, CLI_ENTRY)), 'the package is under node_modules');
  assert.ok(existsSync(join(prefix, 'node_modules', DEP_NAME, 'src', 'index.js')), 'the dependency came along');
  const marker = join(home, 'ran.txt');
  const ran = spawnSync(
    process.execPath,
    [
      join(prefix, CLI_ENTRY),
      'run',
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('ignored')`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(ran.status, 0, 'the moved tree runs with its dependency');
  assert.equal(ran.stdout, RUN_MARKER);
  assert.equal(readFileSync(marker, 'utf8'), 'ran', 'run executed the command it was handed');

  // The old version keeps its tree: what was running stays runnable.
  assert.ok(existsSync(join(home, 'versions', '0.0.1', CLI_ENTRY)), 'the previous version stays on disk');
  assert.equal(readdirSync(join(home, 'versions')).some((name) => name.startsWith('.stage-')), false);
  assert.equal(readdirSync(join(home, 'versions')).some((name) => name.startsWith('.old-')), false);
  assert.equal(existsSync(join(home, LOCK_FILE)), false, 'the lock is released');
});

test('a candidate that cannot load its sibling dependency is refused', async (t) => {
  const { home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  await upgrade({ version: '0.0.1', home, install });
  const before = pointerText(home);

  // The package alone: no sibling, so the import fails and the CLI cannot start.
  buildVersion(fixtures, '0.0.2', { dep: false });
  await assert.rejects(upgrade({ version: '0.0.2', home, install }), (err) => {
    assert.equal(err.code, 'upgrade_failed');
    assert.match(err.message, /--version exit/);
    return true;
  });

  assert.equal(pointerText(home), before);
  assert.equal(existsSync(join(home, 'versions', '0.0.2')), false);
  assert.equal(existsSync(join(home, LOCK_FILE)), false);
});

test('an upgrade to the version already current does nothing, unless its tree is gone', async (t) => {
  const { home, fixtures } = sandbox(t);
  buildVersion(fixtures, '0.0.1');
  await upgrade({ version: '0.0.1', home, install: installerFor(fixtures) });

  let installs = 0;
  const install = (options) => {
    installs += 1;
    installerFor(fixtures)(options);
  };

  const receipt = await upgrade({ version: '0.0.1', home, install });
  assert.equal(receipt.alreadyCurrent, true);
  assert.equal(receipt.switched, false);
  assert.equal(installs, 0, 'the current version is not reinstalled');
  assert.equal(readPointer(home).version, '0.0.1');

  // The pointer outlives a deleted tree: the same command repairs it instead of
  // reporting success over a version that is not there.
  rmSync(join(home, 'versions', '0.0.1'), { recursive: true, force: true });
  const repaired = await upgrade({ version: '0.0.1', home, install });
  assert.equal(repaired.switched, true);
  assert.equal(installs, 1);
  assert.ok(existsSync(join(home, 'versions', '0.0.1', CLI_ENTRY)));
  assert.equal(readPointer(home).version, '0.0.1');
});

test('a candidate that fails either check is rejected and the pointer does not move', async (t) => {
  const { home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  await upgrade({ version: '0.0.1', home, install });
  const before = pointerText(home);

  // Answers the wrong version.
  buildVersion(fixtures, '0.0.2', { versionOutput: '9.9.9' });
  await assert.rejects(upgrade({ version: '0.0.2', home, install }), (err) => {
    assert.equal(err.code, 'upgrade_failed');
    assert.match(err.message, /--version/);
    return true;
  });
  assert.equal(pointerText(home), before);
  assert.equal(existsSync(join(home, 'versions', '0.0.2')), false);

  // Answers --version correctly, then fails a real command.
  buildVersion(fixtures, '0.0.3', { runOutput: 'WRONG' });
  await assert.rejects(upgrade({ version: '0.0.3', home, install }), (err) => {
    assert.equal(err.code, 'upgrade_failed');
    assert.match(err.message, /run exit 0, answered "WRONG"/);
    return true;
  });
  assert.equal(pointerText(home), before);
  assert.equal(existsSync(join(home, 'versions', '0.0.3')), false);
  assert.equal(readdirSync(join(home, 'versions')).some((name) => name.startsWith('.stage-')), false);
  assert.equal(existsSync(join(home, LOCK_FILE)), false);
});

test('a failed install writes no pointer at all', async (t) => {
  const { home } = sandbox(t);

  await assert.rejects(
    upgrade({
      version: '0.0.1',
      home,
      install: () => {
        throw new Error('registry is down');
      },
    }),
    (err) => {
      assert.equal(err.code, 'upgrade_failed');
      assert.match(err.message, /registry is down/);
      return true;
    },
  );

  assert.equal(existsSync(join(home, POINTER_FILE)), false);
  assert.equal(existsSync(join(home, LOCK_FILE)), false);
  assert.equal(readdirSync(join(home, 'versions')).length, 0);
});

test('rollback re-points at the version kept on disk without installing anything', async (t) => {
  const { home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  buildVersion(fixtures, '0.0.2');
  await upgrade({ version: '0.0.1', home, install });
  await upgrade({ version: '0.0.2', home, install });

  const back = await upgrade({
    version: '0.0.1',
    home,
    install: () => {
      throw new Error('a kept version must not be reinstalled');
    },
  });

  assert.equal(back.from, '0.0.2');
  assert.equal(back.to, '0.0.1');
  assert.equal(back.staged, false, 'the kept prefix was reused');
  assert.equal(back.verified, true);
  assert.equal(back.switched, true);
  assert.equal(readPointer(home).version, '0.0.1');
  assert.ok(existsSync(join(home, 'versions', '0.0.2', CLI_ENTRY)), 'the newer version stays to roll forward again');
});

test('a running old version survives the switch', async (t) => {
  const { home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  buildVersion(fixtures, '0.0.2');
  await upgrade({ version: '0.0.1', home, install });

  const running = await startVersion(join(home, 'versions', '0.0.1'));
  t.after(() => running.kill());
  assert.equal(alive(running), true, 'the old version is running');

  await upgrade({ version: '0.0.2', home, install });

  assert.equal(readPointer(home).version, '0.0.2');
  assert.equal(alive(running), true, 'the process started before the upgrade is untouched');
});

test('the launcher runs the version the pointer names, and its own copy without one', async (t) => {
  const { root, home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  buildVersion(fixtures, '0.0.2');
  await upgrade({ version: '0.0.1', home, install });
  await upgrade({ version: '0.0.2', home, install });

  const pointed = launcherRun(home, ['--version']);
  assert.equal(pointed.status, 0);
  assert.equal(pointed.stdout.trim(), '0.0.2');

  const pointedRun = launcherRun(home, ['run', '--', process.execPath, '-e', `process.stdout.write('${RUN_MARKER}')`]);
  assert.equal(pointedRun.status, 0);
  assert.equal(pointedRun.stdout, RUN_MARKER);

  // A pointer that names a launcher instead of the CLI is ignored, not followed:
  // following it would be a spawn loop.
  const looped = join(root, 'loop-home');
  mkdirSync(looped, { recursive: true });
  writeFileSync(join(looped, POINTER_FILE), `${JSON.stringify({ version: '0.0.2', bin: 'bin/janua.js' })}\n`);
  assert.equal(readPointer(looped), null);

  const fallback = launcherRun(join(root, 'empty-home'), ['--version']);
  assert.equal(fallback.status, 0);
  assert.equal(fallback.stdout.trim(), pkg.version, 'no pointer means this checkout answers');
});

test('a swap whose moved tree does not answer is undone and the previous copy returns', async (t) => {
  const { home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  await upgrade({ version: '0.0.1', home, install });
  const before = pointerText(home);

  // A broken tree already at the target name, so the swap has to move it aside,
  // and a candidate that only tells the truth while it sits under `.stage-`.
  const target = join(home, 'versions', '0.0.2');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'original.txt'), 'previous copy\n');
  buildVersion(fixtures, '0.0.2', { postMoveLie: true });

  await assert.rejects(upgrade({ version: '0.0.2', home, install }), (err) => {
    assert.equal(err.code, 'upgrade_failed');
    assert.match(err.message, /does not answer from/);
    return true;
  });

  assert.equal(pointerText(home), before, 'the pointer is byte-identical');
  assert.equal(
    readFileSync(join(target, 'original.txt'), 'utf8'),
    'previous copy\n',
    'the displaced copy is put back',
  );
  assert.equal(existsSync(join(target, CLI_ENTRY)), false, 'the unverified tree is not left in place');
  assert.equal(
    readdirSync(join(home, 'versions')).some((name) => name.startsWith('.old-') || name.startsWith('.stage-')),
    false,
    'no backup or stage directory survives',
  );
});

test('a concurrent upgrade is refused while another one holds the lock', async (t) => {
  const { root, home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  buildVersion(fixtures, '0.0.2');
  await upgrade({ version: '0.0.1', home, install });
  const before = pointerText(home);

  const flag = join(root, 'first-is-installing');
  const worker = upgradeWorker(root, 'slow-upgrade', { delayMs: 1500 });
  const first = spawn(process.execPath, [worker, home, fixtures, '0.0.2', '1500', flag], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => first.kill());
  let firstOut = '';
  first.stdout.on('data', (chunk) => {
    firstOut += chunk.toString();
  });
  first.stderr.on('data', (chunk) => {
    firstOut += chunk.toString();
  });
  await waitForFile(flag, 10000);

  const second = spawnSync(
    process.execPath,
    [worker, home, fixtures, '0.0.2', '0', join(root, 'second-is-installing')],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(second.status, 1, 'the second upgrade must fail, not wait');
  assert.match(`${second.stdout}${second.stderr}`, /BUSY upgrade_in_progress/);

  await new Promise((resolve) => first.on('exit', resolve));
  assert.match(firstOut, /SWITCHED 0\.0\.2/);
  assert.equal(readPointer(home).version, '0.0.2', 'the upgrade that held the lock finished');
  assert.equal(existsSync(join(home, LOCK_FILE)), false);
  assert.notEqual(pointerText(home), before);
});

test('only the owner removes the lock, and a foreign one is left byte-identical', async (t) => {
  const { home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  buildVersion(fixtures, '0.0.2');
  await upgrade({ version: '0.0.1', home, install });
  assert.equal(existsSync(join(home, LOCK_FILE)), false, 'the owner removed its own lock');

  const before = pointerText(home);
  const lockDir = join(home, LOCK_FILE);
  const ownerFile = join(lockDir, 'owner.json');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(ownerFile, `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'someone-else' })}\n`);
  const lockBody = readFileSync(ownerFile, 'utf8');

  await assert.rejects(upgrade({ version: '0.0.2', home, install }), (err) => {
    assert.equal(err.code, 'upgrade_in_progress');
    return true;
  });

  assert.equal(pointerText(home), before, 'the pointer did not move');
  assert.equal(readFileSync(ownerFile, 'utf8'), lockBody, "another owner's lock is untouched");
  assert.deepEqual(readdirSync(lockDir), ['owner.json']);
});

test('a lock left by a crash blocks the next upgrade until someone removes it', async (t) => {
  const { home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  buildVersion(fixtures, '0.0.2');
  await upgrade({ version: '0.0.1', home, install });
  const before = pointerText(home);

  // An old pid is not evidence that the upgrade is gone, so the lock is honoured
  // rather than reclaimed: only the operator knows what is still running.
  const lockDir = join(home, LOCK_FILE);
  const ownerFile = join(lockDir, 'owner.json');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    ownerFile,
    `${JSON.stringify({ pid: 2147483646, startedAt: Date.now() - 86400000, token: 'crashed' })}\n`,
  );

  await assert.rejects(upgrade({ version: '0.0.2', home, install }), (err) => {
    assert.equal(err.code, 'upgrade_in_progress');
    assert.ok(err.message.includes(lockDir), 'the message names the lock path');
    assert.match(err.message, /2147483646/, 'the message names the owner pid');
    assert.match(err.message, /delete that directory/, 'the message names the recovery');
    return true;
  });

  assert.equal(pointerText(home), before, 'the old version stays current');
  assert.ok(existsSync(ownerFile), 'the lock is still there, untouched');

  // The recovery the message names: confirm nothing is running, delete, retry.
  rmSync(lockDir, { recursive: true, force: true });
  const receipt = await upgrade({ version: '0.0.2', home, install });
  assert.equal(receipt.switched, true);
  assert.equal(readPointer(home).version, '0.0.2');
});

test('a lock left after the pointer moved still serves the new version, and recovers', async (t) => {
  const { home, fixtures } = sandbox(t);
  const install = installerFor(fixtures);
  buildVersion(fixtures, '0.0.1');
  buildVersion(fixtures, '0.0.2');
  await upgrade({ version: '0.0.1', home, install });
  await upgrade({ version: '0.0.2', home, install });

  // The kill landed after the pointer write and before the release: the new
  // version is installed, verified, and current, and only the lock is left over.
  const lockDir = join(home, LOCK_FILE);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, 'owner.json'),
    `${JSON.stringify({ pid: 2147483646, startedAt: Date.now() - 86400000, token: 'interrupted' })}\n`,
  );

  const pointed = launcherRun(home, ['--version']);
  assert.equal(pointed.status, 0, 'the launcher still serves a version');
  assert.equal(pointed.stdout.trim(), '0.0.2', 'the verified new version is the current one');
  const ran = launcherRun(home, ['run', '--', process.execPath, '-e', "process.stdout.write('M')"]);
  assert.equal(ran.status, 0);
  assert.equal(ran.stdout, RUN_MARKER, 'the new version still runs commands');

  await assert.rejects(upgrade({ version: '0.0.1', home, install }), (err) => {
    assert.equal(err.code, 'upgrade_in_progress');
    assert.match(err.message, /delete that directory/);
    return true;
  });
  assert.equal(readPointer(home).version, '0.0.2', 'the refusal changed nothing');

  rmSync(lockDir, { recursive: true, force: true });
  const receipt = await upgrade({ version: '0.0.1', home, install });
  assert.equal(receipt.switched, true, 'the upgrade proceeds once the lock is gone');
  assert.equal(readPointer(home).version, '0.0.1');
  assert.ok(existsSync(join(home, 'versions', '0.0.2', CLI_ENTRY)), 'the interrupted version is still installed');
});

test('the home comes from JANUA_HOME, then the platform data directory', () => {
  assert.equal(resolveHome({ JANUA_HOME: join('some', 'home') }, 'win32'), join('some', 'home'));

  assert.equal(
    resolveHome({ LOCALAPPDATA: join('base', 'Local') }, 'win32'),
    join('base', 'Local', 'janua'),
  );
  assert.equal(
    resolveHome({ XDG_DATA_HOME: join('base', 'share') }, 'linux'),
    join('base', 'share', 'janua'),
  );
  assert.match(resolveHome({}, 'linux'), /[\\/]\.local[\\/]share[\\/]janua$/);
});

test('the default install asks for the published package and no lifecycle noise', () => {
  assert.deepEqual(npmInstallArgs('1.2.3'), [
    'install',
    '@nathwn12/janua@1.2.3',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ]);

  // The command must name npm itself, and a prefix with a space must stay one
  // argument. Without the leading `npm` the shell runs a command called install.
  const line = npmCommandLine(['install', '--prefix', join('a b', 'c'), '@nathwn12/janua@1.2.3']);
  if (process.platform === 'win32') {
    assert.equal(line.shell, true);
    assert.equal(line.file, `npm install --prefix "${join('a b', 'c')}" @nathwn12/janua@1.2.3`);
  } else {
    assert.equal(line.shell, false);
    assert.equal(line.file, 'npm');
    assert.deepEqual(line.args, ['install', '--prefix', join('a b', 'c'), '@nathwn12/janua@1.2.3']);
  }
});
