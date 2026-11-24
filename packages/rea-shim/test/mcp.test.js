'use strict';
//
// Offline contracts for the explicit --mcp stdio entry.
//
// The install root, hash gate and config rule are the ones the no-argument
// path uses. These fixtures stage a local archive and replace the bundled
// executable with a stub, so nothing downloads and no real GUI runs.
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
const RUNNER = path.join(__dirname, 'fixtures', 'mcp-runner.js');

function temporary(t, prefix = 'rea-shim-mcp-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFixtureZip(t) {
  const work = temporary(t, 'rea-shim-mcp-zip-');
  const root = 'craft-anything-0.6.1-windows-x64-portable';
  const source = path.join(work, 'src');
  for (const name of ['craft-anything.exe', 'craft-anything-cli.exe', 'portable.txt']) {
    const file = path.join(source, root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name === 'portable.txt' ? 'portable\n' : 'MZ');
  }
  const zip = path.join(work, 'fixture.zip');
  const built = spawnSync('tar', ['-a', '-c', '-f', zip, '-C', source, root], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  return zip;
}

function pinnedSource(zip) {
  const bytes = fs.readFileSync(zip);
  return {
    ...sources.CRAFT_SOURCE,
    url: 'https://example.invalid/fake.zip',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

function stageCache(root, source, zip) {
  const dir = path.join(root, 'cache', source.sha256);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(zip, path.join(dir, source.fileName));
}

test('mcp spawns the bundled CLI with inherited stdio and no shell or detach', async (t) => {
  const root = temporary(t);
  const zip = makeFixtureZip(t);
  const source = pinnedSource(zip);
  const child = { on: () => {} };
  let seen = null;
  const result = await craft.runMcp({
    root, source, env: { PATH: 'C:\\original' }, platform: 'win32', arch: 'x64', log: () => {},
    download: async (url, destination) => { fs.copyFileSync(zip, destination); },
    spawn: (file, args, options) => { seen = { file, args, options }; return child; },
  });
  assert.equal(result.child, child);
  assert.match(seen.file, /craft-anything-cli\.exe$/);
  assert.deepEqual(seen.args, ['mcp']);
  assert.equal(seen.options.stdio, 'inherit');
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.windowsHide, true);
  assert.equal(seen.options.detached, false);
  assert.equal(seen.options.env.CRAFT_ANYTHING_CONFIG_DIR, craft.configDirFor(root));
  assert.equal(seen.options.env.PATH, 'C:\\original');
});

test('an unsupported host refuses on stderr and never spawns or downloads', async (t) => {
  const root = temporary(t);
  let spawns = 0;
  await assert.rejects(
    () => craft.runMcp({
      root, env: {}, platform: 'linux', arch: 'x64', log: () => {},
      download: async () => { throw new Error('must not download'); },
      spawn: () => { spawns += 1; throw new Error('must not spawn'); },
    }),
    /Windows x64 only/,
  );
  assert.equal(spawns, 0);
});

test('mcp reuses a staged install with zero downloads', async (t) => {
  const root = temporary(t);
  const zip = makeFixtureZip(t);
  const source = pinnedSource(zip);
  stageCache(root, source, zip);
  let downloads = 0;
  let spawns = 0;
  const child = { on: () => {} };
  for (let run = 0; run < 2; run += 1) {
    const result = await craft.runMcp({
      root, source, platform: 'win32', arch: 'x64', log: () => {}, env: { PATH: '' },
      download: async (url, destination) => { downloads += 1; fs.copyFileSync(zip, destination); },
      spawn: () => { spawns += 1; return child; },
    });
    assert.equal(result.child, child);
  }
  assert.equal(downloads, 0, 'the verified staged archive must be reused');
  assert.equal(spawns, 2);
});

test('mcp passes JSON-RPC bytes through both directions with a clean stdout and forwards the exit code', (t) => {
  const root = temporary(t);
  const zip = makeFixtureZip(t);
  const source = pinnedSource(zip);
  stageCache(root, source, zip);

  const request =
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"value":"a"}}\n' +
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"value":"b"}}\n';
  const expected =
    '{"jsonrpc":"2.0","id":1,"result":{"echo":"a"}}\n' +
    '{"jsonrpc":"2.0","id":2,"result":{"echo":"b"}}\n';

  const result = spawnSync(process.execPath, [RUNNER], {
    input: request,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, FIXTURE_ROOT: root, FIXTURE_ZIP: zip, FAKE_CLI_EXIT: '7' },
  });
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.status, 7, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, expected, 'stdout must carry only the CLI response frames');
  assert.match(result.stderr, /fake-cli: stderr passthrough/, 'the child stderr must pass through');
  assert.match(
    result.stderr,
    /rea-shim: starting craft-anything-cli\.exe mcp/,
    'a real shim diagnostic must reach fd2',
  );
  assert.doesNotMatch(result.stdout, /rea-shim|downloaded|verified|config/, 'no shim chatter on stdout');
});
