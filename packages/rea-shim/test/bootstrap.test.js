'use strict';
//
// Offline contract tests for the explicit `--bootstrap` installer, the
// upstream acceptance checks, and the read-only run-path discovery.
//
// These tests are contracts, not runtime proof. They use local ZIP fixtures,
// injected runners and fixture JSON; they never download anything or start a
// real Ghidra. The acceptance proof is a clean Windows Sandbox run documented
// in docs/GUIDE.md. No claim here says an engine was exercised.
//

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const support = require('../lib/support.js');
const discovery = require('../lib/discovery.js');
const sources = require('../lib/sources.js');
const install = require('../lib/install.js');
const checks = require('../lib/checks.js');
const bootstrap = require('../lib/bootstrap.js');

const PACKAGE_DIR = path.join(__dirname, '..');
const BIN = path.join(PACKAGE_DIR, 'bin', 'rea-shim.js');
const WINDOWS = process.platform === 'win32';
const WINDOWS_ONLY = WINDOWS ? false : 'archive extraction and junctions are Windows-only here';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function temporary(t, prefix = 'rea-shim-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 90000,
  });
}

function cleanEnv(extra = {}) {
  return {
    JAVA_HOME: '',
    GHIDRA_INSTALL_DIR: '',
    REA_JDK_HOME: '',
    REA_GHIDRA_DIR: '',
    REA_SHIM_JDK_HOME: '',
    REA_SHIM_GHIDRA_DIR: '',
    REA_SHIM_AGENTS_VERSION: '9.9.9',
    ...extra,
  };
}

// A fake `npm` on PATH. It records the command line and every spelling of
// `npm_config_cache` in the environment the child actually received, then
// emulates npm's cache write into the first entry - the value Windows'
// case-insensitive block lookup produces - so a test can prove where npm
// would have written. Output goes to a JSON file because stdout is returned
// to `defaultRunNpm` as the command result.
function makeFakeNpmProbe(t, { exitCode = 0 } = {}) {
  const bin = temporary(t, 'rea-shim-fake-npm-');
  const dump = path.join(bin, 'npm-calls.json');
  const script = path.join(bin, 'probe.js');
  fs.writeFileSync(script, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const dump = process.argv[2];',
    'const args = process.argv.slice(3);',
    "const cache = Object.entries(process.env)",
    "  .filter(([key]) => key.toLowerCase() === 'npm_config_cache')",
    '  .map(([key, value]) => ({ key, value }));',
    'let calls = [];',
    'try { calls = JSON.parse(fs.readFileSync(dump, "utf8")); } catch {}',
    'calls.push({ args, cache });',
    'fs.writeFileSync(dump, JSON.stringify(calls));',
    '// Emulate npm writing through the cache it resolves. Windows env lookup is',
    '// case-insensitive, so the first surviving entry is the value npm gets.',
    'if (cache.length > 0) {',
    '  const store = path.join(cache[0].value, "_cacache");',
    '  fs.mkdirSync(store, { recursive: true });',
    '  fs.writeFileSync(path.join(store, "npm-probe"), "fake npm wrote this");',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'npm.cmd'), [
    '@echo off',
    `"%PROBE_NODE%" "%PROBE_SCRIPT%" "%PROBE_DUMP%" %*`,
    `exit /b ${exitCode}`,
    '',
  ].join('\r\n'));
  return {
    bin,
    dump,
    exitCode,
    env: {
      PROBE_NODE: process.execPath,
      PROBE_SCRIPT: script,
      PROBE_DUMP: dump,
    },
    calls() {
      return JSON.parse(fs.readFileSync(dump, 'utf8'));
    },
  };
}

function pollutedNpmEnv(probe, outside) {
  return {
    ...process.env,
    ...probe.env,
    PATH: `${probe.bin};${process.env.PATH || ''}`,
    NPM_CONFIG_CACHE: outside,
    Npm_Config_Cache: outside,
    npm_CONFIG_cache: outside,
  };
}

function makeZip(t, archiveRoot, files) {
  const work = temporary(t, 'rea-shim-zip-');
  const source = path.join(work, 'src');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(source, archiveRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const zip = path.join(work, 'fixture.zip');
  const result = spawnSync('tar', ['-a', '-c', '-f', zip, '-C', source, archiveRoot], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return zip;
}

function writeFakeGhidra(dir, { version = '12.1.4', minimum = '21', maximum = '' } = {}) {
  fs.mkdirSync(path.join(dir, 'Ghidra'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Ghidra', 'application.properties'), [
    `application.version=${version}`,
    `application.java.min=${minimum}`,
    `application.java.max=${maximum}`,
  ].join('\n'));
  fs.mkdirSync(path.join(dir, 'support'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'support', 'analyzeHeadless.bat'), '@echo off\r\n');
  const decompiler = path.join(dir, 'Ghidra', 'Features', 'Decompiler', 'os', 'win_x86_64');
  fs.mkdirSync(decompiler, { recursive: true });
  fs.writeFileSync(path.join(decompiler, 'decompile.exe'), 'MZ');
}

function makeFakeScoopApp(t, app, versionDir, files) {
  const scoopRoot = temporary(t, 'rea-shim-scoop-');
  const appDir = path.join(scoopRoot, 'apps', app);
  const version = path.join(appDir, versionDir);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(version, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.mkdirSync(version, { recursive: true });
  const current = path.join(appDir, 'current');
  fs.symlinkSync(version, current, 'junction');
  return { scoopRoot, appDir, version, current };
}

function realpathLower(target) {
  return fs.realpathSync.native(target).replace(/[\\/]+$/, '').toLowerCase();
}

// The DOS 8.3 short name of an existing directory, when the volume hands one
// out, or null. GitHub's Windows runner exposes its profile as
// `C:\Users\RUNNER~1` while the handle path is `C:\Users\runneradmin`; this
// reproduces that pair hermetically so a validator that mistakes an alias for
// a reparse point fails a test instead of the runner.
function shortPathAlias(target) {
  if (!WINDOWS) return null;
  const result = spawnSync(`for %I in ("${target}") do @echo %~sI`, {
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.status !== 0) return null;
  const short = String(result.stdout || '').trim();
  if (!short || short.toLowerCase() === String(target).toLowerCase()) return null;
  return short;
}

function release(tag, assetNames, extra = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/NationalSecurityAgency/ghidra/releases/tag/${tag}`,
    body: '',
    assets: assetNames.map((name) => ({
      name,
      browser_download_url: `https://github.com/NationalSecurityAgency/ghidra/releases/download/${tag}/${name}`,
      digest: `sha256:${HASH_A}`,
    })),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parseJavaMajor handles modern, LTS and legacy version strings', () => {
  assert.equal(bootstrap.parseJavaMajor('openjdk version "25.0.4.1" 2026-08-18 LTS'), 25);
  assert.equal(bootstrap.parseJavaMajor('openjdk version "21.0.12.1" 2026-08-18 LTS'), 21);
  assert.equal(bootstrap.parseJavaMajor('java version "1.8.0_504"'), 8);
  assert.equal(bootstrap.parseJavaMajor('not a version'), null);
});

test('bootstrap accepts only exact upstream versions', () => {
  assert.equal(sources.normalizeExactVersion('6.8.0'), '6.8.0');
  assert.equal(sources.normalizeExactVersion('"6.8.0"'), '6.8.0');
  assert.equal(sources.normalizeExactVersion('6.8.0-beta.1'), '6.8.0-beta.1');
  assert.throws(() => sources.normalizeExactVersion('latest'), /not an exact released version/);
  assert.throws(() => sources.normalizeExactVersion('6.8'), /not an exact released version/);
  assert.throws(() => sources.normalizeExactVersion('rea-agents@6.8.0'), /not an exact released version/);
});

test('resolveUpstreamRelease pins exact and never accepts a dist-tag', () => {
  const pinned = sources.resolveUpstreamRelease({
    env: { REA_SHIM_AGENTS_VERSION: '6.8.0' },
    runNpm: () => { throw new Error('npm must not run for a pin'); },
  });
  assert.equal(pinned.version, '6.8.0');
  assert.equal(pinned.source, 'REA_SHIM_AGENTS_VERSION=6.8.0');
  assert.throws(
    () => sources.resolveUpstreamRelease({ env: { REA_SHIM_AGENTS_VERSION: 'latest' }, runNpm: () => '6.8.0' }),
    /not an exact released version/,
  );

  const calls = [];
  const resolved = sources.resolveUpstreamRelease({
    env: {},
    runNpm: (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'view' && args[1] === 'rea-agents') return '6.8.0';
      if (args.includes('dist.integrity')) return '"sha512-abc123"';
      throw new Error(`unexpected npm ${args.join(' ')}`);
    },
  });
  assert.equal(resolved.version, '6.8.0');
  assert.equal(resolved.integrity, 'sha512-abc123');
  assert.deepEqual(calls, [
    'view rea-agents version',
    'view rea-agents@6.8.0 dist.integrity --json',
  ]);
});

// ---------------------------------------------------------------------------
// Archive safety
// ---------------------------------------------------------------------------

test('archive entry validation rejects traversal, absolute paths and unsafe names', () => {
  const safe = support.assertSafeArchiveEntries([
    'jdk-21/',
    'jdk-21/bin/java.exe',
  ]);
  assert.equal(safe.root, 'jdk-21');
  assert.deepEqual(safe.entries, ['jdk-21', 'jdk-21/bin/java.exe']);

  for (const entries of [
    ['../evil.txt'],
    ['/absolute.txt'],
    ['C:/absolute.txt'],
    ['jdk-21/../../evil.txt'],
    ['jdk-21//empty.txt'],
    ['jdk-21/stream:name.txt'],
    ['jdk-21/CON'],
    ['jdk-21/trailing.'],
    ['jdk-21/trailing '],
    ['jdk-21/\u0001control'],
    ['one/a.txt', 'two/b.txt'],
  ]) {
    assert.throws(() => support.assertSafeArchiveEntries(entries));
  }
  assert.throws(
    () => support.assertSafeArchiveEntries(['jdk-21/', 'other/file.txt']),
    /do not share one top-level directory/,
  );
});

test('verbose archive listings reject links, devices and special entries', () => {
  assert.doesNotThrow(() => support.assertArchiveListingSafe([
    '-rw-r--r--  0 user group 10 2026-10-26 00:00 jdk-21/bin/java.exe',
    'drwxr-xr-x  0 user group  0 2026-10-26 00:00 jdk-21/',
  ]));
  for (const line of [
    'lrwxrwxrwx  0 user group 10 2026-10-26 00:00 jdk-21/link',
    'hrw-r--r--  0 user group 10 2026-10-26 00:00 jdk-21/hard',
    'crw-r--r--  0 user group 10 2026-10-26 00:00 jdk-21/device',
    'prw-r--r--  0 user group 10 2026-10-26 00:00 jdk-21/fifo',
  ]) {
    assert.throws(() => support.assertArchiveListingSafe([line]), /not a regular file or directory/);
  }
});

test('ensurePlainDir refuses to write through a junction or a file', { skip: WINDOWS_ONLY }, (t) => {
  const root = temporary(t);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const link = path.join(root, 'link');
  fs.symlinkSync(real, link, 'junction');
  assert.throws(() => support.ensurePlainDir(path.join(link, 'child'), 'test'), /symbolic link|reparse/);

  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => support.ensurePlainDir(path.join(file, 'child'), 'test'), /not a directory/);
});

test('assertNoReparsePoints refuses a link inside an extracted tree', { skip: WINDOWS_ONLY }, (t) => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'tree'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tree', 'file.txt'), 'ok');
  assert.doesNotThrow(() => support.assertNoReparsePoints(path.join(root, 'tree')));

  fs.mkdirSync(path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'tree', 'link'), 'junction');
  assert.throws(() => support.assertNoReparsePoints(path.join(root, 'tree')), /symbolic link|reparse/);
});

test('a DOS 8.3 short path is canonicalized, not refused as a reparse point', { skip: WINDOWS_ONLY }, (t) => {
  const longRoot = temporary(t, 'rea-shim-alias-long-root-');
  const shortRoot = shortPathAlias(longRoot);
  if (!shortRoot) return t.skip('this volume hands out no distinct 8.3 short name');

  // The runner's shape: the same directory named by a short component whose
  // handle path is the long name. Every write-path validator must accept it.
  const nested = path.join(shortRoot, 'nested', 'deeper');
  assert.doesNotThrow(() => support.assertPlainAncestors(nested, 'install root'));
  support.ensurePlainDir(nested, 'install root');
  assert.equal(realpathLower(nested), realpathLower(path.join(longRoot, 'nested', 'deeper')));
});

test('an aliased staging tree is not mistaken for an archive escape', { skip: WINDOWS_ONLY }, (t) => {
  const longRoot = temporary(t, 'rea-shim-alias-long-root-');
  const shortRoot = shortPathAlias(longRoot);
  if (!shortRoot) return t.skip('this volume hands out no distinct 8.3 short name');

  // Extraction staging named through a short component resolves inside itself;
  // the alias must not read as an entry that escaped the staging directory.
  fs.mkdirSync(path.join(longRoot, 'Ghidra', 'Features'), { recursive: true });
  fs.writeFileSync(path.join(longRoot, 'Ghidra', 'application.properties'), 'application.version=12.2\n');
  assert.doesNotThrow(() => support.assertNoReparsePoints(shortRoot));

  // The alias stays tolerant only of spelling: a real link is still refused.
  const outside = temporary(t, 'rea-shim-alias-outside-');
  fs.symlinkSync(outside, path.join(shortRoot, 'link'), 'junction');
  assert.throws(() => support.assertNoReparsePoints(shortRoot), /symbolic link|reparse/);
});

test('an ancestor junction resolving outside the trusted root is still refused', { skip: WINDOWS_ONLY }, (t) => {
  const root = temporary(t, 'rea-shim-escape-root-');
  const outside = temporary(t, 'rea-shim-escape-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external sentinel');
  fs.symlinkSync(outside, path.join(root, 'link'), 'junction');

  // Alias canonicalization must not become link tolerance: an ancestor that
  // redirects to another tree is refused and nothing is created there.
  const nested = path.join(root, 'link', 'nested', 'deeper');
  assert.throws(() => support.assertPlainAncestors(nested, 'install root'), /symbolic link|reparse/);
  assert.throws(() => support.ensurePlainDir(nested, 'install root'), /symbolic link|reparse/);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

test('downloadFile never deletes a pre-existing destination', async (t) => {
  const destination = path.join(temporary(t), 'keep.bin');
  fs.writeFileSync(destination, 'sentinel');
  await assert.rejects(
    () => support.downloadFile('https://example.invalid/archive.zip', destination),
    /refusing to overwrite the existing file/,
  );
  assert.equal(fs.readFileSync(destination, 'utf8'), 'sentinel');
});

// ---------------------------------------------------------------------------
// Ghidra and JDK release resolution
// ---------------------------------------------------------------------------

test('selectGhidraRelease picks the highest patch in the accepted line only', () => {
  const releases = [
    release('Ghidra_12.2_build', ['ghidra_12.2_PUBLIC_20261016.zip']),
    release('Ghidra_12.1.4_build', ['ghidra_12.1.4_PUBLIC_20260921.zip']),
    release('Ghidra_12.1.3_build', ['ghidra_12.1.3_PUBLIC_20260801.zip']),
    release('Ghidra_12.1.5_build', ['ghidra_12.1.5_PUBLIC_20261001.zip'], { draft: true }),
    release('Ghidra_12.1.6_build', ['ghidra_12.1.6_PUBLIC_20261002.zip'], { prerelease: true }),
    release('Ghidra_11.4_build', ['ghidra_11.4_PUBLIC_20250101.zip']),
  ];
  assert.equal(sources.selectGhidraRelease(releases, '12.1.4').tag.version, '12.1.4');
  assert.equal(
    sources.selectGhidraRelease(releases.concat(release('Ghidra_12.1.5_build', ['ghidra_12.1.5_PUBLIC_20261001.zip'])), '12.1.4').tag.version,
    '12.1.5',
  );
  assert.equal(sources.selectGhidraRelease(releases, '12.2').tag.version, '12.2');
  assert.throws(
    () => sources.selectGhidraRelease([releases[0]], '12.1.4'),
    /no published official NSA Ghidra release/,
  );
});

test('hashFromText ties a hash to the exact filename and refuses ambiguity', () => {
  const file = 'ghidra_12.1.4_PUBLIC_20260921.zip';
  assert.equal(sources.hashFromText(`${HASH_A}  ${file}\n`, file), HASH_A);
  assert.equal(sources.hashFromText(`${file}  ${HASH_A}\n`, file), HASH_A);
  assert.equal(sources.hashFromText(`SHA256 (${file}) = ${HASH_A}\n`, file), HASH_A);
  assert.equal(sources.hashFromText(`| ${file} | ${HASH_A} |\n`, file), HASH_A);
  assert.equal(sources.hashFromText(`SHA-256: ${HASH_A}\n`, file), HASH_A);
  assert.throws(
    () => sources.hashFromText(`${HASH_A}  ${file}\n${HASH_B}  ${file}\n`, file),
    /conflicting SHA-256/,
  );
  assert.throws(
    () => sources.hashFromText(`SHA-256: ${HASH_A}\nSHA-256: ${HASH_B}\n`, file),
    /multiple SHA-256 values/,
  );
  assert.equal(sources.hashFromText('no hash here', file), null);
});

test('resolveGhidraHash uses the official digest, then checksum asset, then release notes', async () => {
  const assetName = 'ghidra_12.1.4_PUBLIC_20260921.zip';
  const base = release('Ghidra_12.1.4_build', [assetName]);
  const candidate = {
    release: base,
    tag: sources.parseGhidraTag(base.tag_name),
    asset: base.assets[0],
  };
  assert.deepEqual(await sources.resolveGhidraHash(candidate), {
    sha256: HASH_A,
    source: 'GitHub release asset digest',
  });

  const sidecar = release('Ghidra_12.1.4_build', [assetName, `${assetName}.sha256`]);
  sidecar.assets[0].digest = null;
  const fetched = [];
  const fromSidecar = await sources.resolveGhidraHash(
    { release: sidecar, tag: sources.parseGhidraTag(sidecar.tag_name), asset: sidecar.assets[0] },
    { fetchText: async (url) => { fetched.push(url); return `${HASH_B}  ${assetName}\n`; } },
  );
  assert.deepEqual(fromSidecar, { sha256: HASH_B, source: 'official release checksum asset' });
  assert.equal(fetched.length, 1);

  const body = release('Ghidra_12.1.4_build', [assetName], { body: `SHA256 (${assetName}) = ${HASH_B}` });
  body.assets[0].digest = null;
  assert.deepEqual(
    await sources.resolveGhidraHash({ release: body, tag: sources.parseGhidraTag(body.tag_name), asset: body.assets[0] }),
    { sha256: HASH_B, source: 'official release notes' },
  );

  const none = release('Ghidra_12.1.4_build', [assetName], { body: 'no checksum published' });
  none.assets[0].digest = null;
  await assert.rejects(
    () => sources.resolveGhidraHash({ release: none, tag: sources.parseGhidraTag(none.tag_name), asset: none.assets[0] }),
    /publishes no verifiable SHA-256/,
  );
});

test('selectJdkRelease picks the latest official Temurin for the declared major', () => {
  const jdk = (major, semver, checksum = HASH_A) => ({
    release_name: `jdk-${semver.replace(/\.0\.LTS$/, '')}`,
    version: { major, semver, openjdk_version: semver },
    binary: {
      image_type: 'jdk',
      os: 'windows',
      architecture: 'x64',
      package: {
        name: `OpenJDK${major}U-jdk_x64_windows_hotspot_${semver.replace(/[.+-]/g, '_')}.zip`,
        link: `https://github.com/adoptium/temurin${major}-binaries/releases/download/${semver}/jdk.zip`,
        checksum,
      },
    },
  });
  const assets = [jdk(21, '21.0.9+10.0.LTS'), jdk(21, '21.0.10+7.0.LTS'), jdk(17, '17.0.16+8.0.LTS')];
  const chosen = sources.selectJdkRelease(assets, { minimum: 21, maximum: null });
  assert.equal(chosen.major, 21);
  assert.match(chosen.version, /21\.0\.10/);
  assert.equal(chosen.sha256, HASH_A);
  assert.match(chosen.dirName, /^temurin-/);

  const noChecksum = [jdk(21, '21.0.10+7.0.LTS', '')];
  assert.throws(
    () => sources.selectJdkRelease(noChecksum, { minimum: 21, maximum: null }),
    /no official Eclipse Temurin/,
  );
  assert.throws(
    () => sources.selectJdkRelease([jdk(17, '17.0.16+8.0.LTS')], { minimum: 21, maximum: null }),
    /no official Eclipse Temurin/,
  );
});

test('resolveGhidraRelease assembles the official release and its hash source', async () => {
  const assetName = 'ghidra_12.1.4_PUBLIC_20260921.zip';
  const fixture = [release('Ghidra_12.1.4_build', [assetName])];
  const resolved = await sources.resolveGhidraRelease({ supportedVersion: '12.1.4', releases: fixture });
  assert.equal(resolved.version, '12.1.4');
  assert.equal(resolved.build, '20260921');
  assert.equal(resolved.fileName, assetName);
  assert.equal(resolved.sha256, HASH_A);
  assert.equal(resolved.hashSource, 'GitHub release asset digest');
  assert.match(resolved.url, /^https:\/\/github\.com\/NationalSecurityAgency\/ghidra\/releases\/download\//);
});

test('resolveJdkRelease reads the official Adoptium asset and checksum', async () => {
  const assets = [{
    release_name: 'jdk-21.0.10+7',
    version: { major: 21, semver: '21.0.10+7.0.LTS', openjdk_version: '21.0.10+7-LTS' },
    binary: {
      image_type: 'jdk',
      os: 'windows',
      architecture: 'x64',
      package: {
        name: 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.10_7.zip',
        link: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.10+7/OpenJDK21U-jdk_x64_windows_hotspot_21.0.10_7.zip',
        checksum: HASH_A,
      },
    },
  }];
  const resolved = await sources.resolveJdkRelease({
    requirement: { minimum: 21, maximum: null },
    fetchJson: async () => assets,
  });
  assert.equal(resolved.major, 21);
  assert.equal(resolved.version, 'jdk-21.0.10+7');
  assert.equal(resolved.sha256, HASH_A);
  assert.equal(resolved.hashSource, 'Adoptium API binary.package.checksum');
});

test('readUpstreamPolicy reads the accepted line from the installed release', async (t) => {
  const prefix = temporary(t);
  const packageDir = path.join(prefix, 'node_modules', 'rea-agents');
  fs.mkdirSync(path.join(packageDir, 'dist', 'ghidra'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(packageDir, 'dist', 'ghidra', 'GhidraReleasePolicy.js'), [
    "export const SUPPORTED_GHIDRA_VERSION = '12.1.4';",
    "export const ghidraReleaseLine = () => '12.1.x';",
    "export const ghidraReleaseAccepted = (value) => /^12\\.1\\./.test(value);",
    '',
  ].join('\n'));

  const policy = await sources.readUpstreamPolicy(prefix);
  assert.equal(policy.supportedVersion, '12.1.4');
  assert.equal(policy.line, '12.1.x');
  assert.equal(policy.accepts('12.1.5'), true);
  assert.equal(policy.accepts('12.2'), false);

  const missing = temporary(t);
  await assert.rejects(
    () => sources.readUpstreamPolicy(missing),
    /refuses to guess which Ghidra line upstream supports/,
  );
});

// ---------------------------------------------------------------------------
// Ghidra / JDK local verification
// ---------------------------------------------------------------------------

test('ghidraJavaRequirement is read from the installation, never a constant', (t) => {
  const dir = temporary(t);
  writeFakeGhidra(dir, { version: '12.1.4', minimum: '21' });
  const requirement = discovery.ghidraJavaRequirement(dir);
  assert.equal(requirement.minimum, 21);
  assert.equal(requirement.maximum, null);
  assert.equal(requirement.version, '12.1.4');

  writeFakeGhidra(dir, { version: '12.2', minimum: '25' });
  assert.equal(discovery.ghidraJavaRequirement(dir).minimum, 25);

  writeFakeGhidra(dir, { minimum: '' });
  assert.throws(() => discovery.ghidraJavaRequirement(dir), /positive integer application\.java\.min/);

  writeFakeGhidra(dir, { minimum: '21', maximum: '20' });
  assert.throws(() => discovery.ghidraJavaRequirement(dir), /not an integer >= 21/);
});

test('the JDK requirement is applied as an inclusive range', () => {
  assert.equal(discovery.satisfies({ minimum: 21, maximum: null }, 21), true);
  assert.equal(discovery.satisfies({ minimum: 21, maximum: null }, 25), true);
  assert.equal(discovery.satisfies({ minimum: 21, maximum: null }, 17), false);
  assert.equal(discovery.satisfies({ minimum: 21, maximum: 21 }, 25), false);
  assert.equal(discovery.satisfies({ minimum: 21, maximum: 25 }, 25), true);
  assert.equal(discovery.satisfies({ minimum: 21, maximum: 25 }, 26), false);
  assert.equal(discovery.javaRequirementLabel({ minimum: 21, maximum: null }), '>= 21');
  assert.equal(discovery.javaRequirementLabel({ minimum: 21, maximum: 25 }), '21..25');
});

test('verifyGhidra requires the exact version and an upstream-accepted line', (t) => {
  const dir = temporary(t);
  writeFakeGhidra(dir, { version: '12.1.4', minimum: '21' });
  const policy = { accepted: true, accepts: (value) => value.startsWith('12.1.'), line: '12.1.x', supportedVersion: '12.1.4' };
  assert.doesNotThrow(() => bootstrap.verifyGhidra(dir, { version: '12.1.4' }, policy));

  assert.throws(
    () => bootstrap.verifyGhidra(dir, { version: '12.1.5' }, policy),
    /reports 12\.1\.4, expected 12\.1\.5/,
  );
  assert.throws(
    () => bootstrap.verifyGhidra(dir, { version: '12.1.4' }, { ...policy, accepts: () => false }),
    /upstream rea-agents policy accepts 12\.1\.x/,
  );
});

// ---------------------------------------------------------------------------
// Upstream acceptance contracts
// ---------------------------------------------------------------------------

function healthyDoctor(version = '12.1.4') {
  return {
    healthy: false, // a clean host has no skill registration yet
    identity: { cli_package_version: '6.8.0' },
    providerInspections: [{
      id: 'ghidra',
      available: true,
      providerVersion: version,
      checks: checks.GHIDRA_PROVIDER_CHECKS.map((name) => ({ name, ok: true })),
    }],
  };
}

function healthyMcp(version = '6.8.0') {
  return {
    healthy: true,
    server: { name: 'rea', version },
    inventory: {
      tools: { expected: 229, observed: 229, missing: [], unexpected: [], duplicates: [] },
      prompts: { expected: 6, observed: 6, missing: [], unexpected: [], duplicates: [] },
    },
    identity: {
      expected_package_version: version,
      observed_package_version: version,
      expected_catalog_digest: 'digest',
      observed_catalog_digest: 'digest',
    },
    request_flow: { ok: true },
  };
}

function healthyAnalysis(version = '12.1.4') {
  // The exact shape `rea analyze --full-output --format json` produces in
  // rea-agents 6.8.0: a CLI result envelope around the evidence record. The
  // evidence provider is the composed workflow; the observed Ghidra identity
  // is nested in the workflow profile's upstream_analysis_profile parameter.
  return {
    ok: true,
    data: {
      evidence_id: `ev_${'a'.repeat(64)}`,
      provider: { id: 'rea-workflow', name: 'REA composed investigation workflow', version: '1' },
      subject: { format: 'raw-binary', architecture: '6502' },
      analysis_profile: {
        provider: { id: 'rea-workflow', name: 'REA composed investigation workflow', version: '1' },
        parameters: {
          upstream_analysis_profile: {
            provider: { id: 'ghidra', name: 'Ghidra', version },
          },
        },
      },
      operation: 'binary_overview',
      predicate_type: 'rea.analysis',
    },
    meta: { command: 'analyze', duration: '1ms' },
  };
}

test('the Ghidra provider gate ignores unrelated setup checks but requires every provider check', () => {
  const expected = { version: '12.1.4', agentsVersion: '6.8.0' };
  const report = healthyDoctor();
  const result = checks.evaluateDoctorReport(report, expected);
  assert.equal(result.providerVersion, '12.1.4');
  assert.equal(result.globalHealthy, false);

  const missingVersion = healthyDoctor();
  missingVersion.providerInspections[0].providerVersion = null;
  assert.throws(() => checks.evaluateDoctorReport(missingVersion, expected), /did not report the observed Ghidra provider version/);

  const mismatch = healthyDoctor('12.2');
  assert.throws(() => checks.evaluateDoctorReport(mismatch, expected), /saw Ghidra 12\.2/);

  const wrongPackage = healthyDoctor();
  wrongPackage.identity.cli_package_version = '6.7.0';
  assert.throws(() => checks.evaluateDoctorReport(wrongPackage, expected), /observed rea-agents 6\.7\.0/);

  const failed = healthyDoctor();
  failed.providerInspections[0].checks.find((check) => check.name === 'java').ok = false;
  assert.throws(() => checks.evaluateDoctorReport(failed, expected), /Ghidra java check failed/);

  const absent = healthyDoctor();
  absent.providerInspections[0].checks = absent.providerInspections[0].checks.filter((check) => check.name !== 'headless');
  assert.throws(() => checks.evaluateDoctorReport(absent, expected), /Ghidra headless check was not reported/);
});

test('the MCP gate requires the exact observed package version and full inventory', () => {
  assert.deepEqual(checks.evaluateMcpDoctorReport(healthyMcp(), { version: '6.8.0' }), {
    tools: 229,
    prompts: 6,
    packageVersion: '6.8.0',
  });
  const wrongServer = healthyMcp();
  wrongServer.server.version = '6.7.0';
  assert.throws(() => checks.evaluateMcpDoctorReport(wrongServer, { version: '6.8.0' }), /server version 6\.7\.0/);

  const wrongObserved = healthyMcp();
  wrongObserved.identity.observed_package_version = '6.7.0';
  assert.throws(() => checks.evaluateMcpDoctorReport(wrongObserved, { version: '6.8.0' }), /observed package 6\.7\.0/);

  const noExpected = healthyMcp();
  delete noExpected.identity.expected_package_version;
  assert.throws(() => checks.evaluateMcpDoctorReport(noExpected, { version: '6.8.0' }), /no expected package version/);

  const missing = healthyMcp();
  missing.inventory.tools.missing = ['binary_session'];
  missing.inventory.tools.observed = 228;
  assert.throws(() => checks.evaluateMcpDoctorReport(missing, { version: '6.8.0' }), /observed 228|missing tools/);

  const brokenFlow = healthyMcp();
  brokenFlow.request_flow.ok = false;
  assert.throws(() => checks.evaluateMcpDoctorReport(brokenFlow, { version: '6.8.0' }), /request flow/);
});

test('the analysis gate requires the real ok:true CLI envelope, provider identity and exact observed Ghidra version', () => {
  assert.deepEqual(checks.evaluateAnalysisReport(healthyAnalysis(), { version: '12.1.4' }), {
    evidenceId: healthyAnalysis().data.evidence_id,
    providerVersion: '12.1.4',
  });

  // The pre-fix parser accepted the bare evidence record. The CLI never emits
  // that shape, so it must not be accepted as proof of a successful analysis.
  const bareEvidence = healthyAnalysis().data;
  assert.throws(
    () => checks.evaluateAnalysisReport(bareEvidence, { version: '12.1.4' }),
    /did not return an ok:true CLI envelope/,
  );

  const notOk = healthyAnalysis();
  notOk.ok = false;
  notOk.error = { code: 'provider_unavailable', message: 'Ghidra is not installed' };
  assert.throws(
    () => checks.evaluateAnalysisReport(notOk, { version: '12.1.4' }),
    /did not return an ok:true CLI envelope: provider_unavailable: Ghidra is not installed/,
  );

  const noData = healthyAnalysis();
  delete noData.data;
  assert.throws(
    () => checks.evaluateAnalysisReport(noData, { version: '12.1.4' }),
    /no evidence data in its CLI envelope/,
  );

  const noProfile = healthyAnalysis();
  delete noProfile.data.analysis_profile;
  assert.throws(
    () => checks.evaluateAnalysisReport(noProfile, { version: '12.1.4' }),
    /returned no analysis profile/,
  );

  // The evidence provider is the composed workflow; Ghidra is only in the
  // workflow profile's upstream_analysis_profile parameter. A Ghidra identity
  // at the outer profile is not the upstream report and must not pass.
  const outerProviderOnly = healthyAnalysis();
  outerProviderOnly.data.analysis_profile.provider = { id: 'ghidra', name: 'Ghidra', version: '12.1.4' };
  delete outerProviderOnly.data.analysis_profile.parameters;
  assert.throws(
    () => checks.evaluateAnalysisReport(outerProviderOnly, { version: '12.1.4' }),
    /Ghidra provider/,
  );

  const noVersion = healthyAnalysis();
  delete noVersion.data.analysis_profile.parameters.upstream_analysis_profile.provider.version;
  assert.throws(
    () => checks.evaluateAnalysisReport(noVersion, { version: '12.1.4' }),
    /did not report the observed Ghidra provider version/,
  );

  const wrongVersion = healthyAnalysis('12.2');
  assert.throws(
    () => checks.evaluateAnalysisReport(wrongVersion, { version: '12.1.4' }),
    /used Ghidra 12\.2/,
  );

  const wrongProvider = healthyAnalysis();
  wrongProvider.data.analysis_profile.parameters.upstream_analysis_profile.provider = {
    id: 'hopper',
    name: 'Hopper',
    version: '5',
  };
  assert.throws(
    () => checks.evaluateAnalysisReport(wrongProvider, { version: '12.1.4' }),
    /Ghidra provider.*hopper/,
  );

  const noName = healthyAnalysis();
  delete noName.data.analysis_profile.parameters.upstream_analysis_profile.provider.name;
  assert.throws(
    () => checks.evaluateAnalysisReport(noName, { version: '12.1.4' }),
    /did not report the Ghidra provider identity/,
  );

  const noEvidence = healthyAnalysis();
  delete noEvidence.data.evidence_id;
  assert.throws(
    () => checks.evaluateAnalysisReport(noEvidence, { version: '12.1.4' }),
    /evidence id/,
  );

  const wrongSubject = healthyAnalysis();
  wrongSubject.data.subject = { format: 'pe', architecture: 'x86-64' };
  assert.throws(
    () => checks.evaluateAnalysisReport(wrongSubject, { version: '12.1.4' }),
    /raw-binary 6502 subject/,
  );
});

test('runUpstreamChecks uses one exact version for all three checks and stops on failure', async (t) => {
  const calls = [];
  const success = async ({ label, args, agentsVersion }) => {
    calls.push({ label, args, agentsVersion });
    if (label === 'doctor') return { status: 0, stdout: JSON.stringify(healthyDoctor()), stderr: '', error: null };
    if (label === 'mcp') return { status: 0, stdout: JSON.stringify(healthyMcp()), stderr: '', error: null };
    if (label === 'analyze') return { status: 0, stdout: JSON.stringify(healthyAnalysis()), stderr: '', error: null };
    throw new Error(`unexpected ${label}`);
  };
  const temp = path.join(temporary(t), 'tmp');
  const result = await checks.runUpstreamChecks({
    agentsVersion: '6.8.0',
    script: path.join(PACKAGE_DIR, 'fake-rea.mjs'),
    env: {},
    tempDir: temp,
    ghidra: { version: '12.1.4' },
    run: success,
    log: () => {},
  });
  assert.deepEqual(calls.map((call) => call.label), ['doctor', 'mcp', 'analyze']);
  assert.ok(calls.every((call) => call.agentsVersion === '6.8.0'));
  assert.deepEqual(
    calls.find((call) => call.label === 'analyze').args.slice(2),
    ['--provider', 'ghidra', '--target-format', 'raw-binary', '--architecture', '6502', '--entry-point', '0x0', '--full-output', '--format', 'json'],
  );
  assert.equal(result.analysis.evidenceId, healthyAnalysis().data.evidence_id);
  assert.equal(result.mcp.tools, 229);
  assert.equal(result.packageVersion, '6.8.0');

  const failedCalls = [];
  await assert.rejects(
    () => checks.runUpstreamChecks({
      agentsVersion: '6.8.0',
      script: path.join(PACKAGE_DIR, 'fake-rea.mjs'),
      env: {},
      tempDir: path.join(temporary(t), 'tmp-failed'),
      ghidra: { version: '12.1.4' },
      run: async ({ label }) => {
        failedCalls.push(label);
        return {
          status: 1,
          stdout: JSON.stringify({
            healthy: false,
            providerInspections: [{
              id: 'ghidra',
              available: false,
              providerVersion: '12.2',
              checks: checks.GHIDRA_PROVIDER_CHECKS.map((name) => ({ name, ok: false, detail: '12.2; accepted releases are 12.1.x' })),
            }],
          }),
          stderr: '',
          error: null,
        };
      },
      log: () => {},
    }),
    /rea doctor failed/,
  );
  assert.deepEqual(failedCalls, ['doctor']);
});

test('runUpstreamChecks refuses a non-exact upstream package version', async (t) => {
  await assert.rejects(
    () => checks.runUpstreamChecks({
      agentsVersion: '6.8',
      script: path.join(PACKAGE_DIR, 'fake-rea.mjs'),
      env: {},
      tempDir: path.join(temporary(t), 'tmp'),
      ghidra: { version: '12.1.4' },
      run: async () => { throw new Error('must not run'); },
      log: () => {},
    }),
    /needs an exact agents version/,
  );
});

test('runUpstreamChecks accepts a global doctor exit when every Ghidra provider check is green', async (t) => {
  const calls = [];
  const run = async ({ label }) => {
    calls.push(label);
    if (label === 'doctor') {
      return { status: 1, stdout: JSON.stringify(healthyDoctor()), stderr: '', error: null };
    }
    if (label === 'mcp') return { status: 0, stdout: JSON.stringify(healthyMcp()), stderr: '', error: null };
    if (label === 'analyze') return { status: 0, stdout: JSON.stringify(healthyAnalysis()), stderr: '', error: null };
    throw new Error(`unexpected ${label}`);
  };
  const result = await checks.runUpstreamChecks({
    agentsVersion: '6.8.0',
    script: path.join(PACKAGE_DIR, 'fake-rea.mjs'),
    env: {},
    tempDir: path.join(temporary(t), 'tmp'),
    ghidra: { version: '12.1.4' },
    run,
    log: () => {},
  });
  assert.deepEqual(calls, ['doctor', 'mcp', 'analyze']);
  assert.equal(result.doctor.globalHealthy, false);
  assert.equal(result.mcp.packageVersion, '6.8.0');
});

test('bootstrap discovery prefers the most recently installed Ghidra', (t) => {
  const root = temporary(t);
  const fixtures = [
    { version: '12.1.4', installedAt: '2026-10-26T00:00:00.000Z' },
    { version: '12.2', installedAt: '2026-10-20T00:00:00.000Z' },
  ];
  for (const fixture of fixtures) {
    const dir = path.join(root, 'ghidra', `ghidra-${fixture.version}`);
    fs.mkdirSync(path.join(dir, 'Ghidra'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Ghidra', 'application.properties'), `application.version=${fixture.version}\n`);
    fs.writeFileSync(path.join(dir, install.MARKER_FILE), JSON.stringify({
      schema: 2,
      name: 'ghidra',
      version: fixture.version,
      sha256: HASH_A,
      url: 'https://example.invalid/ghidra.zip',
      installedAt: fixture.installedAt,
    }));
  }
  const candidates = discovery.bootstrapGhidraCandidates({ REA_SHIM_HOME: root });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].version, '12.1.4');
  assert.equal(candidates[1].version, '12.2');
});

// ---------------------------------------------------------------------------
// Read-only discovery through Scoop `current` junctions
// ---------------------------------------------------------------------------

test('scoop apps/ghidra/current junction resolves to the canonical Ghidra install', { skip: WINDOWS_ONLY }, (t) => {
  const home = temporary(t, 'rea-shim-home-');
  const fake = makeFakeScoopApp(t, 'ghidra', '12.2-20261016', {
    'Ghidra/application.properties': 'application.version=12.2\napplication.java.min=21\n',
  });
  const resolved = discovery.resolveGhidra({ SCOOP: fake.scoopRoot, REA_SHIM_HOME: home });
  assert.ok(resolved, 'the scoop apps/ghidra/current junction must be discovered');
  assert.equal(resolved.source, 'scoop apps/ghidra/current');
  assert.equal(realpathLower(resolved.dir), realpathLower(fake.version));
  assert.notEqual(resolved.dir.toLowerCase(), fake.current.toLowerCase());
  const requirement = discovery.ghidraJavaRequirement(resolved.dir);
  assert.equal(requirement.version, '12.2');
  assert.equal(requirement.minimum, 21);
});

test('scoop JDK current junction resolves to the canonical JDK home', { skip: WINDOWS_ONLY }, (t) => {
  const home = temporary(t, 'rea-shim-home-');
  const fake = makeFakeScoopApp(t, 'openjdk', 'jdk-21.0.2-13', { 'bin/java.exe': 'fixture' });
  const candidates = discovery.collectJdkCandidates({ SCOOP: fake.scoopRoot, REA_SHIM_HOME: home });
  const jdk = candidates.find((candidate) => candidate.source === 'scoop openjdk');
  assert.ok(jdk, 'the scoop JDK current junction must be discovered');
  assert.equal(jdk.override, false);
  assert.equal(realpathLower(jdk.home), realpathLower(fake.version));
  assert.notEqual(jdk.home.toLowerCase(), fake.current.toLowerCase());
  assert.ok(support.isPlainFile(path.join(jdk.home, 'bin', 'java.exe')));
});

test('the same scoop junction is still refused as a write destination', { skip: WINDOWS_ONLY }, (t) => {
  const home = temporary(t, 'rea-shim-home-');
  const fake = makeFakeScoopApp(t, 'ghidra', '12.2-20261016', {
    'Ghidra/application.properties': 'application.version=12.2\napplication.java.min=21\n',
  });
  assert.ok(discovery.resolveGhidra({ SCOOP: fake.scoopRoot, REA_SHIM_HOME: home }), 'read-only discovery accepts it');
  const nested = path.join(fake.current, 'rea-shim-nested');
  assert.throws(() => support.ensurePlainDir(nested, 'install root'), /symbolic link|reparse/);
  assert.throws(() => support.assertPlainAncestors(nested, 'install root'), /symbolic link|reparse/);
  assert.equal(fs.existsSync(path.join(fake.version, 'rea-shim-nested')), false);
});

test('only a safe sibling current junction is followed', { skip: WINDOWS_ONLY }, (t) => {
  const home = temporary(t, 'rea-shim-home-');
  const scoopRoot = temporary(t, 'rea-shim-scoop-');
  const appDir = path.join(scoopRoot, 'apps', 'ghidra');
  const version = path.join(appDir, '12.2-20261016');
  fs.mkdirSync(path.join(version, 'Ghidra'), { recursive: true });
  fs.writeFileSync(path.join(version, 'Ghidra', 'application.properties'), 'application.version=12.2\napplication.java.min=21\n');
  const outside = path.join(scoopRoot, 'outside-ghidra');
  fs.mkdirSync(path.join(outside, 'Ghidra'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'Ghidra', 'application.properties'), 'application.version=12.2\napplication.java.min=21\n');

  fs.symlinkSync(outside, path.join(appDir, 'current'), 'junction');
  assert.equal(discovery.resolveScoopCurrent(path.join(appDir, 'current')), null);
  assert.equal(discovery.resolveGhidra({ SCOOP: scoopRoot, REA_SHIM_HOME: home }), null);

  fs.symlinkSync(version, path.join(appDir, 'latest'), 'junction');
  assert.equal(discovery.resolveScoopCurrent(path.join(appDir, 'latest')), null);

  const plain = path.join(appDir, 'plain');
  fs.mkdirSync(plain);
  assert.equal(discovery.resolveScoopCurrent(plain), null);
});

// ---------------------------------------------------------------------------
// Installer mechanics
// ---------------------------------------------------------------------------

test('ensureArtifact installs once, reuses by marker, and preserves foreign targets', { skip: WINDOWS_ONLY }, async (t) => {
  const root = temporary(t);
  const zip = makeZip(t, 'ghidra_0.0.1_PUBLIC', {
    'Ghidra/application.properties': 'application.version=0.0.1\napplication.java.min=21\n',
    'bin/java.exe': 'fake',
  });
  const sha256 = await support.sha256File(zip);
  const entry = {
    kind: 'ghidra',
    name: 'Fake Ghidra',
    version: '0.0.1',
    dirName: 'ghidra-0.0.1',
    fileName: 'fake-ghidra.zip',
    url: 'https://example.invalid/fake-ghidra.zip',
    sha256,
    hashSource: 'fixture',
    expectedRootPattern: /^ghidra_/,
  };
  let downloads = 0;
  const download = async (url, destination) => {
    downloads += 1;
    fs.copyFileSync(zip, destination);
  };

  const first = await install.ensureArtifact(entry, { root, download, log: () => {} });
  assert.equal(first.reused, false);
  assert.ok(fs.existsSync(path.join(first.dir, 'Ghidra', 'application.properties')));
  assert.ok(fs.existsSync(path.join(first.dir, install.MARKER_FILE)));
  assert.equal(downloads, 1);

  const second = await install.ensureArtifact(entry, { root, download, log: () => {} });
  assert.equal(second.reused, true);
  assert.equal(downloads, 1);

  const candidates = discovery.bootstrapGhidraCandidates({ REA_SHIM_HOME: root });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].version, '0.0.1');

  const foreignRoot = temporary(t);
  const foreignTarget = path.join(foreignRoot, 'ghidra', entry.dirName);
  fs.mkdirSync(foreignTarget, { recursive: true });
  fs.writeFileSync(path.join(foreignTarget, 'sentinel.txt'), 'keep me');
  await assert.rejects(
    () => install.ensureArtifact(entry, { root: foreignRoot, download, log: () => {} }),
    /refusing to overwrite/,
  );
  assert.equal(fs.readFileSync(path.join(foreignTarget, 'sentinel.txt'), 'utf8'), 'keep me');
});

test('ensureArtifact refuses a mismatched pre-existing cache entry without deleting it', { skip: WINDOWS_ONLY }, async (t) => {
  const root = temporary(t);
  const zip = makeZip(t, 'jdk-0.0.1', { 'bin/java.exe': 'fake' });
  const sha256 = await support.sha256File(zip);
  const entry = {
    kind: 'jdk',
    name: 'Fake JDK',
    version: '0.0.1',
    dirName: 'jdk-0.0.1',
    fileName: 'fake-jdk.zip',
    url: 'https://example.invalid/fake-jdk.zip',
    sha256,
    hashSource: 'fixture',
  };
  const cacheDir = path.join(root, 'cache', sha256);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, entry.fileName);
  fs.writeFileSync(cached, 'do not delete me');

  await assert.rejects(
    () => install.ensureArtifact(entry, { root, download: async () => { throw new Error('must not download'); }, log: () => {} }),
    /does not match the official SHA-256/,
  );
  assert.equal(fs.readFileSync(cached, 'utf8'), 'do not delete me');
  assert.equal(fs.existsSync(path.join(root, 'jdk', entry.dirName)), false);
});

test('ensureArtifact deletes only its own failed download and installs nothing on mismatch', { skip: WINDOWS_ONLY }, async (t) => {
  const root = temporary(t);
  const zip = makeZip(t, 'jdk-0.0.1', { 'bin/java.exe': 'fake' });
  const real = await support.sha256File(zip);
  const wrong = `${real[0] === 'a' ? 'b' : 'a'}${real.slice(1)}`;
  const entry = {
    kind: 'jdk',
    name: 'Fake JDK',
    version: '0.0.1',
    dirName: 'jdk-0.0.1',
    fileName: 'fake-jdk.zip',
    url: 'https://example.invalid/fake-jdk.zip',
    sha256: wrong,
    hashSource: 'fixture',
  };
  await assert.rejects(
    () => install.ensureArtifact(entry, { root, download: async (url, destination) => fs.copyFileSync(zip, destination), log: () => {} }),
    /SHA-256 mismatch/,
  );
  assert.equal(fs.existsSync(path.join(root, 'jdk', entry.dirName)), false);
  const cache = path.join(root, 'cache', wrong);
  const leftovers = fs.existsSync(cache) ? fs.readdirSync(cache).filter((name) => name.includes('.part-')) : [];
  assert.deepEqual(leftovers, []);
});

test('ensureArtifact refuses a target whose parent is a junction', { skip: WINDOWS_ONLY }, async (t) => {
  const root = temporary(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'ghidra'), 'junction');
  const entry = {
    kind: 'ghidra',
    name: 'Fake Ghidra',
    version: '0.0.1',
    dirName: 'ghidra-0.0.1',
    fileName: 'fake-ghidra.zip',
    url: 'https://example.invalid/fake-ghidra.zip',
    sha256: HASH_A,
    hashSource: 'fixture',
  };
  await assert.rejects(
    () => install.ensureArtifact(entry, { root, download: async () => { throw new Error('must not download'); }, log: () => {} }),
    /symbolic link|reparse/,
  );
});

test('ensureUpstreamPackage installs one exact version and reuses only its own marker', async (t) => {
  const root = temporary(t);
  let installs = 0;
  const npmInstall = async ({ staging, version }) => {
    installs += 1;
    const packageDir = path.join(staging, 'node_modules', 'rea-agents');
    fs.mkdirSync(path.join(packageDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(packageDir, 'dist', 'ghidra'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'rea-agents', version }));
    fs.writeFileSync(path.join(packageDir, 'scripts', 'rea.mjs'), '// fixture\n');
    fs.writeFileSync(path.join(packageDir, 'dist', 'ghidra', 'GhidraReleasePolicy.js'), 'export const SUPPORTED_GHIDRA_VERSION = "12.1.4";\n');
  };

  const first = await install.ensureUpstreamPackage({
    version: '6.8.0',
    root,
    integrity: 'sha512-fixture',
    npmInstall,
    log: () => {},
  });
  assert.equal(first.reused, false);
  assert.equal(first.version, '6.8.0');
  assert.ok(fs.existsSync(first.script));
  assert.equal(installs, 1);

  const second = await install.ensureUpstreamPackage({ version: '6.8.0', root, npmInstall, log: () => {} });
  assert.equal(second.reused, true);
  assert.equal(installs, 1);

  const foreignRoot = temporary(t);
  const foreignTarget = path.join(foreignRoot, 'upstream', 'rea-agents-6.8.0');
  fs.mkdirSync(foreignTarget, { recursive: true });
  fs.writeFileSync(path.join(foreignTarget, 'sentinel.txt'), 'keep me');
  await assert.rejects(
    () => install.ensureUpstreamPackage({ version: '6.8.0', root: foreignRoot, npmInstall, log: () => {} }),
    /refusing to overwrite/,
  );
  assert.equal(fs.readFileSync(path.join(foreignTarget, 'sentinel.txt'), 'utf8'), 'keep me');
});

test('ensureNpmCache creates a canonical cache inside the root and preserves existing content', (t) => {
  const root = temporary(t);
  const first = install.ensureNpmCache(root);
  assert.equal(realpathLower(first), realpathLower(path.join(root, 'npm-cache')));
  assert.ok(
    realpathLower(first).startsWith(`${realpathLower(root)}${path.sep}`),
    `${first} must stay inside ${root}`,
  );
  assert.ok(support.isPlainDir(first));

  const sentinel = path.join(first, 'keep.bin');
  fs.writeFileSync(sentinel, 'keep');
  const nested = path.join(first, '_cacache', 'content-v2', 'sha512');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'blob'), 'cache entry');
  const second = install.ensureNpmCache(root);
  assert.equal(realpathLower(second), realpathLower(first));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(nested, 'blob'), 'utf8'), 'cache entry');
});

test('defaultNpmInstall refuses an npm-cache junction before spawning npm', { skip: WINDOWS_ONLY }, (t) => {
  const root = temporary(t);
  const outside = temporary(t, 'rea-shim-npm-cache-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external sentinel');
  fs.symlinkSync(outside, path.join(root, 'npm-cache'), 'junction');

  let spawned = 0;
  assert.throws(
    () => install.defaultNpmInstall({
      staging: path.join(root, 'staging'),
      version: '6.8.0',
      root,
      env: {},
      spawn: () => {
        spawned += 1;
        throw new Error('spawn must not run');
      },
    }),
    /symbolic link|reparse|canonical install root/,
  );
  assert.equal(spawned, 0);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

test('ensureUpstreamPackage refuses an npm-cache junction and never invokes npm', { skip: WINDOWS_ONLY }, async (t) => {
  const root = temporary(t);
  const outside = temporary(t, 'rea-shim-npm-cache-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external sentinel');
  fs.symlinkSync(outside, path.join(root, 'npm-cache'), 'junction');

  let installs = 0;
  await assert.rejects(
    () => install.ensureUpstreamPackage({
      version: '6.8.0',
      root,
      npmInstall: async () => {
        installs += 1;
        throw new Error('npm must not run');
      },
      log: () => {},
    }),
    /symbolic link|reparse|canonical install root/,
  );
  assert.equal(installs, 0);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

test('runBootstrap refuses an npm-cache junction before npm runs', { skip: WINDOWS_ONLY }, async (t) => {
  const root = temporary(t, 'rea-shim-boot-');
  const outside = temporary(t, 'rea-shim-npm-cache-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external sentinel');
  fs.symlinkSync(outside, path.join(root, 'npm-cache'), 'junction');

  // If the preflight is removed, the bootstrap would reach npm. A fake npm on
  // PATH records that invocation instead of touching the real cache or network.
  const fakeBin = temporary(t, 'rea-shim-fake-npm-');
  const npmMarker = path.join(fakeBin, 'npm-invoked.txt');
  fs.writeFileSync(path.join(fakeBin, 'npm.cmd'), [
    '@echo off',
    '> "%NPM_MARKER%" echo invoked',
    'exit /b 9',
    '',
  ].join('\r\n'));

  let npmCalls = 0;
  await assert.rejects(
    () => bootstrap.runBootstrap({
      env: cleanEnv({
        REA_SHIM_HOME: root,
        REA_SHIM_AGENTS_VERSION: '6.8.0',
        PATH: `${fakeBin};${process.env.PATH || ''}`,
        NPM_MARKER: npmMarker,
      }),
      runNpm: () => {
        npmCalls += 1;
        throw new Error('npm must not run');
      },
      log: () => {},
    }),
    /symbolic link|reparse|canonical install root/,
  );
  assert.equal(npmCalls, 0);
  assert.equal(fs.existsSync(npmMarker), false);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

function makePoisonedNpmCache(t, relative) {
  const root = temporary(t, 'rea-shim-npm-cache-root-');
  const cache = install.ensureNpmCache(root);
  const outside = temporary(t, 'rea-shim-npm-cache-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external sentinel');
  const link = path.join(cache, relative);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(outside, link, 'junction');
  return { root, cache, outside, sentinel, link };
}

test('ensureNpmCache refuses a nested _cacache junction instead of handing it to npm', { skip: WINDOWS_ONLY }, (t) => {
  const { root, outside, sentinel, link } = makePoisonedNpmCache(t, '_cacache');

  assert.throws(() => install.ensureNpmCache(root), /symbolic link|reparse/);

  // A refused cache is left exactly as found; the external target is untouched.
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

test('ensureNpmCache refuses a junction deeper than _cacache', { skip: WINDOWS_ONLY }, (t) => {
  const { root, outside, sentinel } = makePoisonedNpmCache(t, path.join('_cacache', 'content-v2'));

  assert.throws(() => install.ensureNpmCache(root), /symbolic link|reparse/);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

test('an aliased install root still refuses a nested _cacache junction', { skip: WINDOWS_ONLY }, (t) => {
  const longRoot = temporary(t, 'rea-shim-alias-long-root-');
  const shortRoot = shortPathAlias(longRoot);
  if (!shortRoot) return t.skip('this volume hands out no distinct 8.3 short name');

  // The cache root named through a short component is still the cache inside
  // the owned root, and the canonical path is what npm must receive.
  const cache = install.ensureNpmCache(shortRoot);
  assert.equal(realpathLower(cache), realpathLower(path.join(longRoot, 'npm-cache')));

  // Alias tolerance must not weaken the descendant protection: a junction
  // inside the cache is still refused and the external tree stays untouched.
  const outside = temporary(t, 'rea-shim-npm-cache-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external sentinel');
  fs.symlinkSync(outside, path.join(cache, '_cacache'), 'junction');

  assert.throws(() => install.ensureNpmCache(shortRoot), /symbolic link|reparse/);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

test('defaultNpmInstall refuses a nested _cacache junction before spawning npm', { skip: WINDOWS_ONLY }, (t) => {
  const { root, outside, sentinel } = makePoisonedNpmCache(t, '_cacache');
  const sentinelBefore = fs.readFileSync(sentinel, 'utf8');

  let spawned = 0;
  assert.throws(
    () => install.defaultNpmInstall({
      staging: path.join(root, 'staging'),
      version: '6.8.0',
      root,
      env: {},
      spawn: () => {
        spawned += 1;
        throw new Error('spawn must not run');
      },
    }),
    /symbolic link|reparse/,
  );
  assert.equal(spawned, 0);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), sentinelBefore);
});

test('ensureUpstreamPackage refuses a nested _cacache junction and never invokes npm', { skip: WINDOWS_ONLY }, async (t) => {
  const { root, outside, sentinel } = makePoisonedNpmCache(t, '_cacache');

  let installs = 0;
  await assert.rejects(
    () => install.ensureUpstreamPackage({
      version: '6.8.0',
      root,
      npmInstall: async () => {
        installs += 1;
        throw new Error('npm must not run');
      },
      log: () => {},
    }),
    /symbolic link|reparse/,
  );
  assert.equal(installs, 0);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

test('runBootstrap refuses a nested _cacache junction before npm runs', { skip: WINDOWS_ONLY }, async (t) => {
  const { root, outside, sentinel } = makePoisonedNpmCache(t, '_cacache');

  const fakeBin = temporary(t, 'rea-shim-fake-npm-');
  const npmMarker = path.join(fakeBin, 'npm-invoked.txt');
  fs.writeFileSync(path.join(fakeBin, 'npm.cmd'), [
    '@echo off',
    '> "%NPM_MARKER%" echo invoked',
    'exit /b 9',
    '',
  ].join('\r\n'));

  let npmCalls = 0;
  await assert.rejects(
    () => bootstrap.runBootstrap({
      env: cleanEnv({
        REA_SHIM_HOME: root,
        // No pin: reaching metadata resolution would run `npm view`, which the
        // cache preflight must refuse first.
        REA_SHIM_AGENTS_VERSION: '',
        PATH: `${fakeBin};${process.env.PATH || ''}`,
        NPM_MARKER: npmMarker,
      }),
      runNpm: () => {
        npmCalls += 1;
        throw new Error('npm must not run');
      },
      log: () => {},
    }),
    /symbolic link|reparse/,
  );
  assert.equal(npmCalls, 0);
  assert.equal(fs.existsSync(npmMarker), false);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

// ---------------------------------------------------------------------------
// npm child environment
// ---------------------------------------------------------------------------

test('npmChildEnv removes every inherited cache spelling and keeps one canonical value', { skip: WINDOWS_ONLY }, () => {
  const inside = 'C:\\inside\\npm-cache';
  const env = support.npmChildEnv({
    PATH: 'C:\\bin',
    KEEP: 'me',
    NPM_CONFIG_CACHE: 'C:\\external',
    Npm_Config_Cache: 'C:\\mixed',
    npm_config_cache: 'C:\\lower',
    npm_config_fund: 'true',
  }, inside, { npm_config_fund: 'false' });

  assert.deepEqual(
    Object.keys(env).filter((key) => key.toLowerCase() === 'npm_config_cache'),
    ['npm_config_cache'],
  );
  assert.equal(env.npm_config_cache, inside);
  assert.equal(env.KEEP, 'me');
  assert.equal(env.PATH, 'C:\\bin');
  assert.deepEqual(
    Object.keys(env).filter((key) => key.toLowerCase() === 'npm_config_fund'),
    ['npm_config_fund'],
  );
  assert.equal(env.npm_config_fund, 'false');

  const planOnly = support.npmChildEnv({ NPM_CONFIG_CACHE: 'C:\\external' }, null);
  assert.deepEqual(
    Object.keys(planOnly).filter((key) => key.toLowerCase() === 'npm_config_cache'),
    [],
    'a plan-only run must not receive an inherited cache path',
  );
  assert.throws(() => support.npmChildEnv({}, 'relative\\npm-cache'), /absolute validated cache path/);
});

test('defaultNpmInstall gives npm only the validated inside cache, never an inherited spelling', { skip: WINDOWS_ONLY }, (t) => {
  const root = temporary(t, 'rea-shim-npm-env-root-');
  const outside = temporary(t, 'rea-shim-npm-cache-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external sentinel');
  const probe = makeFakeNpmProbe(t);

  install.defaultNpmInstall({
    staging: path.join(root, 'staging'),
    version: '6.8.0',
    root,
    env: pollutedNpmEnv(probe, outside),
  });

  const calls = probe.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'install');
  assert.ok(calls[0].args.includes('rea-agents@6.8.0'), `unexpected args: ${calls[0].args.join(' ')}`);
  assert.equal(calls[0].cache.length, 1, `npm received ${JSON.stringify(calls[0].cache)}`);
  assert.equal(calls[0].cache[0].key, 'npm_config_cache');
  assert.equal(realpathLower(calls[0].cache[0].value), realpathLower(path.join(root, 'npm-cache')));
  assert.ok(realpathLower(calls[0].cache[0].value).startsWith(`${realpathLower(root)}${path.sep}`));

  // npm wrote through the cache it was handed: the install root has the entry,
  // the external sentinel directory is untouched.
  assert.equal(
    fs.readFileSync(path.join(root, 'npm-cache', '_cacache', 'npm-probe'), 'utf8'),
    'fake npm wrote this',
  );
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

test('defaultRunNpm gives the metadata lookup only the validated inside cache', { skip: WINDOWS_ONLY }, (t) => {
  const root = temporary(t, 'rea-shim-npm-env-root-');
  const cache = install.ensureNpmCache(root);
  const outside = temporary(t, 'rea-shim-npm-cache-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external sentinel');
  const probe = makeFakeNpmProbe(t);

  const output = sources.defaultRunNpm(['view', 'rea-agents', 'version'], {
    env: pollutedNpmEnv(probe, outside),
    npmCache: cache,
  });
  assert.equal(output, '');

  const calls = probe.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['view', 'rea-agents', 'version']);
  assert.equal(calls[0].cache.length, 1, `npm received ${JSON.stringify(calls[0].cache)}`);
  assert.equal(calls[0].cache[0].key, 'npm_config_cache');
  assert.equal(realpathLower(calls[0].cache[0].value), realpathLower(cache));

  assert.equal(fs.readFileSync(path.join(cache, '_cacache', 'npm-probe'), 'utf8'), 'fake npm wrote this');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

test('runBootstrap hands the metadata lookup the validated inside cache, not an inherited spelling', { skip: WINDOWS_ONLY }, async (t) => {
  const parent = temporary(t, 'rea-shim-boot-env-');
  const root = path.join(parent, 'root');
  const outside = temporary(t, 'rea-shim-npm-cache-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external sentinel');
  // Exit non-zero after recording so the run stops at the metadata lookup and
  // never reaches a download; the recorded call is the evidence.
  const probe = makeFakeNpmProbe(t, { exitCode: 9 });

  await assert.rejects(
    () => bootstrap.runBootstrap({
      env: {
        ...cleanEnv({
          REA_SHIM_HOME: root,
          REA_SHIM_AGENTS_VERSION: '',
          PATH: `${probe.bin};${process.env.PATH || ''}`,
          ...probe.env,
        }),
        NPM_CONFIG_CACHE: outside,
        Npm_Config_Cache: outside,
        npm_CONFIG_cache: outside,
      },
      log: () => {},
    }),
    /npm view rea-agents version failed/,
  );

  const calls = probe.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['view', 'rea-agents', 'version']);
  assert.equal(calls[0].cache.length, 1, `npm received ${JSON.stringify(calls[0].cache)}`);
  assert.equal(calls[0].cache[0].key, 'npm_config_cache');
  assert.equal(realpathLower(calls[0].cache[0].value), realpathLower(path.join(root, 'npm-cache')));
  assert.ok(realpathLower(calls[0].cache[0].value).startsWith(`${realpathLower(root)}${path.sep}`));

  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
});

test('a dry-run metadata lookup cannot receive an inherited cache override', { skip: WINDOWS_ONLY }, async (t) => {
  const parent = temporary(t, 'rea-shim-boot-env-');
  const root = path.join(parent, 'must-not-exist');
  const outside = temporary(t, 'rea-shim-npm-cache-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external sentinel');
  const probe = makeFakeNpmProbe(t);

  await assert.rejects(
    () => bootstrap.runBootstrap({
      dryRun: true,
      env: {
        ...cleanEnv({
          REA_SHIM_HOME: root,
          REA_SHIM_AGENTS_VERSION: '',
          PATH: `${probe.bin};${process.env.PATH || ''}`,
          ...probe.env,
        }),
        NPM_CONFIG_CACHE: outside,
      },
      log: () => {},
    }),
    /not an exact released version/,
  );

  const calls = probe.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['view', 'rea-agents', 'version']);
  assert.deepEqual(calls[0].cache, [], 'a dry run must not hand npm any cache path, inherited or not');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external sentinel');
  assert.equal(fs.existsSync(root), false, 'a dry run must not create the bootstrap root');
});

// ---------------------------------------------------------------------------
// CLI behaviour
// ---------------------------------------------------------------------------

test('--doctor is read-only and never creates the bootstrap root', (t) => {
  const parent = temporary(t);
  const root = path.join(parent, 'must-not-exist');
  const ghidra = path.join(parent, 'ghidra');
  writeFakeGhidra(ghidra, { version: '12.1.4', minimum: '21' });
  const result = runCli(['--doctor'], cleanEnv({
    REA_SHIM_HOME: root,
    REA_SHIM_GHIDRA_DIR: ghidra,
  }));
  assert.ok([0, 2].includes(result.status), `unexpected exit ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /rea-shim doctor/);
  assert.match(result.stdout, /java requirement: >= 21/);
  assert.match(result.stdout, new RegExp(ghidra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(root), false);
});

test('--bootstrap --dry-run prints the upstream-following plan and writes nothing', (t) => {
  const parent = temporary(t);
  const root = path.join(parent, 'must-not-exist');
  const result = runCli(['--bootstrap', '--dry-run'], cleanEnv({ REA_SHIM_HOME: root }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /rea-agents@9\.9\.9/);
  assert.match(result.stderr, /policy: read from the installed upstream release/);
  assert.match(result.stderr, /latest official NSA Ghidra release in the upstream-accepted line/);
  assert.match(result.stderr, /application\.java\.min/);
  assert.match(result.stderr, /no fallback/);
  assert.match(result.stdout, /nothing written/);
  assert.equal(fs.existsSync(root), false);
});

test('--bootstrap rejects a removed pinned-Ghidra override', (t) => {
  const root = path.join(temporary(t), 'must-not-exist');
  const result = runCli(['--bootstrap', '--ghidra', '12.2'], cleanEnv({ REA_SHIM_HOME: root }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
  assert.equal(fs.existsSync(root), false);
});

test('--bootstrap and --doctor cannot be combined', (t) => {
  const root = path.join(temporary(t), 'must-not-exist');
  const result = runCli(['--bootstrap', '--doctor'], cleanEnv({ REA_SHIM_HOME: root }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
  assert.equal(fs.existsSync(root), false);
});

test('--bootstrap --help prints usage without writing', (t) => {
  const root = path.join(temporary(t), 'must-not-exist');
  const result = runCli(['--bootstrap', '--help'], cleanEnv({ REA_SHIM_HOME: root }));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--bootstrap/);
  assert.equal(fs.existsSync(root), false);
});
