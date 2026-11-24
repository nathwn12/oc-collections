'use strict';
//
// Offline contract tests for the one no-argument Craft Anything entry.
//
// These are contracts, not runtime proof: downloads, extraction and launch are
// injected. No real archive is fetched, no GUI is started and no host config is
// touched. The pinned hash and the native env key come from primary sources.
//

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const craft = require('../lib/craft.js');
const sources = require('../lib/sources.js');

const PACKAGE_DIR = path.join(__dirname, '..');
const BIN = path.join(PACKAGE_DIR, 'bin', 'rea-shim.js');
const PINNED = 'bd370fbaa2b44dbc13581db5ffd2bf66924ed40e433c7902212aa17ca781de54';

function temporary(t, prefix = 'rea-shim-craft-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A small local ZIP with the shape the real pinned archive has: one top-level
// directory holding the portable marker and the GUI executable.
function makeFixtureZip(t, { root = 'craft-anything-0.6.1-windows-x64-portable', files } = {
  files: { 'portable.txt': 'portable\n', 'craft-anything.exe': 'MZ' },
}) {
  const work = temporary(t, 'rea-shim-zip-');
  const source = path.join(work, 'src');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(source, root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const zip = path.join(work, 'fixture.zip');
  const result = spawnSync('tar', ['-a', '-c', '-f', zip, '-C', source, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return zip;
}

function pinnedSource(zip) {
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  return {
    ...sources.CRAFT_SOURCE,
    url: 'https://example.invalid/craft.zip',
    sha256,
    bytes: fs.statSync(zip).size,
  };
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

test('only win32-x64 is admitted, with an explicit message for every other host', () => {
  const source = sources.resolveSource('win32', 'x64');
  assert.equal(source.version, '0.6.1');
  assert.equal(source.sha256, PINNED);
  assert.equal(source.bytes, 69934191);
  assert.equal(source.fileName, 'craft-anything-0.6.1-windows-x64-portable.zip');
  assert.match(source.url, /^https:\/\/github\.com\/storytold\/craft-anything\/releases\/download\/v0\.6\.1\//);
  assert.equal(source.configEnv, 'CRAFT_ANYTHING_CONFIG_DIR');

  assert.throws(() => sources.resolveSource('linux', 'x64'), /Windows x64 only/);
  assert.throws(() => sources.resolveSource('win32', 'arm64'), /Windows x64 only/);
  assert.throws(() => sources.resolveSource('darwin', 'arm64'), /Windows x64 only/);
  assert.deepEqual(Object.keys(sources.ARCH_MAP), ['win32-x64']);
});

test('the install root is version-independent and needs no extra user setup', (t) => {
  const base = temporary(t);
  const override = path.join(base, 'home');
  assert.equal(craft.installRoot({ REA_SHIM_HOME: override }), path.join(override, 'craft-anything'));
  const local = path.join(base, 'localappdata');
  assert.equal(craft.installRoot({ LOCALAPPDATA: local }), path.join(local, 'rea-shim', 'craft-anything'));
});

test('first run verifies the pin before extraction and installs once; rerun downloads nothing', async (t) => {
  const root = temporary(t);
  const zip = makeFixtureZip(t);
  const source = pinnedSource(zip);
  const log = [];
  let downloads = 0;
  const download = async (url, destination) => {
    downloads += 1;
    assert.equal(url, source.url);
    fs.copyFileSync(zip, destination);
  };

  const first = await craft.ensureInstalled({
    source, root, download, log: (line) => log.push(line), platform: 'win32', arch: 'x64',
  });
  assert.equal(downloads, 1);
  assert.equal(first.reused, false);
  assert.ok(fs.statSync(first.exe).isFile());
  assert.ok(fs.statSync(path.join(first.dir, 'portable.txt')).isFile());
  assert.ok(log.some((line) => line.includes(`sha256 ${source.sha256}`)), 'hash verdict must be logged before extraction');
  assert.ok(log.some((line) => line.includes('extract')));

  const before = fs.readFileSync(path.join(first.dir, 'craft-anything.exe'));
  const second = await craft.ensureInstalled({
    source, root, download, log: () => {}, platform: 'win32', arch: 'x64',
  });
  assert.equal(downloads, 1, 'rerun must not fetch');
  assert.equal(second.reused, true);
  assert.equal(second.exe, first.exe);
  assert.deepEqual(fs.readFileSync(second.exe), before);
});

test('a corrupt or partial payload fails at the hash gate, leaves no install and gives one recovery path', async (t) => {
  const root = temporary(t);
  const zip = makeFixtureZip(t);
  const source = pinnedSource(zip);
  const corrupted = source.sha256[0] === 'a' ? `b${source.sha256.slice(1)}` : `a${source.sha256.slice(1)}`;
  let downloads = 0;
  const download = async (url, destination) => {
    downloads += 1;
    // Right length, wrong bytes: the size gate passes so this reaches the hash gate.
    fs.writeFileSync(destination, Buffer.alloc(source.bytes, 0x41));
  };

  await assert.rejects(
    () => craft.ensureInstalled({
      source: { ...source, sha256: corrupted }, root, download, log: () => {}, platform: 'win32', arch: 'x64',
    }),
    /SHA-256 mismatch[\s\S]*rerun the command/,
  );
  assert.equal(downloads, 1);
  assert.equal(fs.existsSync(craft.appDir(root, source)), false, 'nothing may be installed on a bad hash');
  const parts = fs.readdirSync(root).filter((name) => name.includes('part'));
  assert.deepEqual(parts, [], 'the owned partial download must be removed');

  // Recovery: the same command with a good staged artifact completes.
  const good = await craft.ensureInstalled({
    source, root, download: async (url, destination) => { fs.copyFileSync(zip, destination); },
    log: () => {}, platform: 'win32', arch: 'x64',
  });
  assert.equal(good.reused, false);
  assert.ok(fs.statSync(good.exe).isFile());
});

test('an archive with more than one top-level directory is refused before extraction', async (t) => {
  const root = temporary(t);
  const work = temporary(t, 'rea-shim-bad-zip-');
  const src = path.join(work, 'src');
  const good = 'craft-anything-0.6.1-windows-x64-portable';
  fs.mkdirSync(path.join(src, good), { recursive: true });
  fs.writeFileSync(path.join(src, good, 'portable.txt'), 'x');
  fs.mkdirSync(path.join(src, 'other'), { recursive: true });
  fs.writeFileSync(path.join(src, 'other', 'evil.exe'), 'MZ');
  const zip = path.join(work, 'bad.zip');
  const built = spawnSync('tar', ['-a', '-c', '-f', zip, '-C', src, good, 'other'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const source = pinnedSource(zip);
  await assert.rejects(
    () => craft.ensureInstalled({
      source, root, download: async (url, destination) => { fs.copyFileSync(zip, destination); },
      log: () => {}, platform: 'win32', arch: 'x64',
    }),
    /escapes|top-level|unsafe|traversal/i,
  );
  assert.equal(fs.existsSync(craft.appDir(root, source)), false);
});

test('a good archive staged in the owned cache is used without any download', async (t) => {
  const root = temporary(t);
  const zip = makeFixtureZip(t);
  const source = pinnedSource(zip);
  const cacheDir = path.join(root, 'cache', source.sha256);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.copyFileSync(zip, path.join(cacheDir, source.fileName));
  let downloads = 0;
  const installed = await craft.ensureInstalled({
    source, root,
    download: async () => { downloads += 1; throw new Error('must not download'); },
    log: () => {}, platform: 'win32', arch: 'x64',
  });
  assert.equal(downloads, 0);
  assert.equal(installed.cached, true);
  assert.ok(fs.statSync(installed.exe).isFile());
});

test('a transient Windows rename failure is retried before the verified archive is accepted', async (t) => {
  const root = temporary(t);
  const zip = makeFixtureZip(t);
  const source = pinnedSource(zip);
  let calls = 0;
  const rename = (from, to) => {
    calls += 1;
    if (calls < 3) {
      const error = new Error('EBUSY');
      error.code = 'EBUSY';
      throw error;
    }
    fs.renameSync(from, to);
  };
  const installed = await craft.ensureInstalled({
    source, root, rename, retryDelayMs: 1,
    download: async (url, destination) => { fs.copyFileSync(zip, destination); },
    log: () => {}, platform: 'win32', arch: 'x64',
  });
  assert.equal(calls, 3, 'two transient failures must be retried');
  assert.ok(fs.statSync(installed.exe).isFile());
});

test('exhausted rename retries delete only the owned partial file and install nothing', async (t) => {
  const root = temporary(t);
  const zip = makeFixtureZip(t);
  const source = pinnedSource(zip);
  let calls = 0;
  const rename = () => {
    calls += 1;
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  };
  await assert.rejects(
    () => craft.ensureInstalled({
      source, root, rename, retryDelayMs: 1,
      download: async (url, destination) => { fs.copyFileSync(zip, destination); },
      log: () => {}, platform: 'win32', arch: 'x64',
    }),
    /could not move the verified archive after 4 attempts/,
  );
  assert.equal(calls, 4);
  assert.equal(fs.existsSync(craft.appDir(root, source)), false);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('part')), []);
});

test('a short or over-size payload is refused by size before hashing', async (t) => {
  for (const delta of [-1, 1]) {
    const root = temporary(t);
    const zip = makeFixtureZip(t);
    const source = pinnedSource(zip);
    const expected = source.bytes + delta;
    await assert.rejects(
      () => craft.ensureInstalled({
        source: { ...source, bytes: expected, sha256: 'f'.repeat(64) }, root,
        download: async (url, destination) => { fs.copyFileSync(zip, destination); },
        log: () => {}, platform: 'win32', arch: 'x64',
      }),
      (error) => {
        assert.match(error.message, new RegExp(`is ${source.bytes} bytes; expected ${expected}`));
        assert.doesNotMatch(error.message, /SHA-256 mismatch/);
        return true;
      },
    );
    assert.equal(fs.existsSync(craft.appDir(root, source)), false);
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('part')), []);
  }
});

test('launch sets the native config-dir override and never edits PATH, registers a service or elevates', (t) => {
  const root = temporary(t);
  let seen = null;
  const fakeExe = path.join(root, 'craft-anything.exe');
  const child = craft.launch({
    exe: fakeExe, root,
    spawn: (file, args, options) => { seen = { file, args, options }; return { pid: 1 }; },
    env: {
      PATH: 'C:\\original',
      CRAFT_ANYTHING_CONFIG_DIR: 'C:\\stale',
      craft_anything_config_dir: 'C:\\stale-lower',
    },
  });
  assert.equal(child.pid, 1);
  assert.equal(seen.file, fakeExe);
  assert.deepEqual(seen.args, []);
  assert.equal(seen.options.stdio, 'inherit');
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.detached, false);
  assert.equal(seen.options.windowsHide, true);
  assert.equal(seen.options.env.CRAFT_ANYTHING_CONFIG_DIR, craft.configDirFor(root));
  assert.equal(Object.keys(seen.options.env).filter((k) => k.toLowerCase() === 'craft_anything_config_dir').length, 1);
  assert.equal(seen.options.env.PATH, 'C:\\original', 'PATH must be inherited unchanged');
});

test('run installs, configures and launches once, then reuses with no fetch and no settings write', async (t) => {
  const root = temporary(t);
  const zip = makeFixtureZip(t);
  const source = pinnedSource(zip);
  let downloads = 0;
  const download = async (url, destination) => { downloads += 1; fs.copyFileSync(zip, destination); };
  let spawns = 0;
  const spawn = () => { spawns += 1; return { pid: spawns }; };
  const env = { PATH: process.env.PATH || '' };

  const first = await craft.run({
    root, source, platform: 'win32', arch: 'x64', env, download, spawn, log: () => {},
  });
  assert.equal(first.reused, false);
  assert.equal(first.settingsCreated, true);
  assert.equal(downloads, 1);
  assert.equal(spawns, 1);
  assert.equal(fs.readFileSync(first.settings, 'utf8'), 'auto_mode = false\n');

  fs.writeFileSync(first.settings, 'auto_mode = false\nversion = 3\n[engines]\n', 'utf8');
  const before = fs.readFileSync(first.settings);
  const second = await craft.run({
    root, source, platform: 'win32', arch: 'x64', env, download, spawn, log: () => {},
  });
  assert.equal(downloads, 1, 'second run must not download');
  assert.equal(second.settingsCreated, false);
  assert.equal(spawns, 2);
  assert.deepEqual(fs.readFileSync(second.settings), before, 'existing settings must be byte-identical');
});

test('the shipped source carries no MCP, REA, Ghidra, JDK, agent or updater path', () => {
  const files = [
    'bin/rea-shim.js', 'lib/craft.js', 'lib/settings.js', 'lib/sources.js', 'lib/support.js',
  ].map((name) => path.join(PACKAGE_DIR, name));
  const banned = [
    /--mcp\b/, /rea-agents/, /mcp-rea\.ps1/, /--bootstrap/, /--doctor/, /--print-config/,
    /Ghidra/i, /JDK/i, /@opencode\//, /plugins\.mcp/, /mcp\.servers/, /setInterval/, /cron/i,
    /deep_mode/i, /auto_mode\s*=\s*true/,
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.equal(pattern.test(text), false, `${path.basename(file)} still matches ${pattern}`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.3.0');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    assert.ok(manifest[field] === undefined || Object.keys(manifest[field]).length === 0);
  }
  const haystack = JSON.stringify(manifest).toLowerCase();
  for (const word of ['mcp', 'ghidra', 'jdk', 'stdio']) {
    assert.equal(haystack.includes(word), false, `manifest still names ${word}`);
  }
});

test('the package check script syntax-checks every shipped bin and lib file', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.check, /node --check/);
  for (const dir of ['bin', 'lib']) {
    for (const name of fs.readdirSync(path.join(PACKAGE_DIR, dir))) {
      if (!name.endsWith('.js')) continue;
      assert.ok(
        pkg.scripts.check.includes(`node --check ${dir}/${name}`),
        `scripts.check must syntax-check ${dir}/${name}`,
      );
    }
  }
});

test('the CLI takes no operational argument', () => {
  const version = runCli(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^0\.3\.0\r?\n$/);
  const unknown = runCli(['--mcp']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage: rea-shim/);
});
