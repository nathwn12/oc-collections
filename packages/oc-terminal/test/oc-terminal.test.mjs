#!/usr/bin/env node
/**
 * oc-terminal - the proving check.
 *
 *   node --test test/            (npm run check -w packages/oc-terminal)
 *
 * No network. The patch cases use fake modules so the test runner's own
 * child_process is never rewritten; the real-spawn case runs `node -e` hidden.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hiddenOptions,
  install,
  isJsRuntime,
  patchBun,
  patchChildProcess,
  resolveRuntime,
  spawnSyncHidden,
  visibleAllowed,
} from '../lib.js';
import plugin from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));

test('hiddenOptions: Windows hides, explicit false is overridden, the switch is explicit', () => {
  assert.equal(hiddenOptions({}, { platform: 'win32', env: {} }).windowsHide, true);
  assert.equal(hiddenOptions({ windowsHide: false }, { platform: 'win32', env: {} }).windowsHide, true);
  assert.equal(hiddenOptions({}, { platform: 'linux', env: {} }).windowsHide, undefined);
  assert.equal(hiddenOptions({}, { platform: 'win32', env: { OC_TERMINAL_ALLOW_VISIBLE: '1' } }).windowsHide, undefined);
  assert.equal(visibleAllowed({ OC_TERMINAL_ALLOW_VISIBLE: '1' }), true);
  assert.equal(visibleAllowed({}), false);
});

test('runtime: the compiled host binary is never a JavaScript runtime', () => {
  const host =
    'C:\\Users\\nathan\\scoop\\persist\\bun\\install\\global\\node_modules\\@opencode\\cli\\bin\\opencode.exe';
  assert.equal(isJsRuntime(host), false);
  assert.equal(isJsRuntime('C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(isJsRuntime('C:\\tools\\bun.exe'), true);

  assert.equal(
    resolveRuntime({ execPath: host, env: {}, which: (name) => (name === 'bun' ? 'C:\\tools\\bun.exe' : null) }),
    'C:\\tools\\bun.exe',
  );
  assert.equal(resolveRuntime({ execPath: host, env: {}, which: () => null }), 'bun', 'PATH resolves bun, never the host');
  assert.equal(
    resolveRuntime({ execPath: 'C:\\Program Files\\nodejs\\node.exe', env: {} }),
    'C:\\Program Files\\nodejs\\node.exe',
  );
  assert.equal(
    resolveRuntime({ execPath: host, env: { OC_TERMINAL_RUNTIME: ' C:\\tools\\node.exe ' }, which: () => null }),
    'C:\\tools\\node.exe',
  );
});

test('patchChildProcess: every spawn shape is hidden, and a second patch does not double-wrap', () => {
  const calls = [];
  const fake = {
    spawn: (...args) => calls.push(['spawn', args]),
    spawnSync: (...args) => calls.push(['spawnSync', args]),
    exec: (...args) => calls.push(['exec', args]),
    execSync: (...args) => calls.push(['execSync', args]),
    execFile: (...args) => calls.push(['execFile', args]),
    execFileSync: (...args) => calls.push(['execFileSync', args]),
    fork: (...args) => calls.push(['fork', args]),
  };
  const opts = { platform: 'win32', env: {} };
  assert.equal(patchChildProcess(fake, opts), true);
  assert.equal(patchChildProcess(fake, opts), true, 'already guarded reads as guarded');

  fake.spawn('cmd', ['/c', 'x'], { windowsHide: false });
  fake.spawn('cmd', { cwd: 'Q:\\' });
  fake.spawnSync('cmd', ['/c', 'x']);
  fake.exec('echo x', () => {});
  fake.exec('echo x', { cwd: 'Q:\\' }, () => {});
  fake.execFile('node', ['-e', '0'], () => {});
  fake.execFileSync('node', ['-e', '0']);
  fake.fork('worker.js');
  fake.fork('worker.js', [], { cwd: 'Q:\\' });

  assert.equal(calls.length, 9, 'the second patch must not add a second wrapper');
  for (const [name, args] of calls) {
    const options = args.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg));
    assert.equal(options?.windowsHide, true, `${name} did not get windowsHide`);
  }
});

test('patchChildProcess: an explicit visible diagnostic skips the guard', () => {
  const fake = { spawn: () => {} };
  assert.equal(patchChildProcess(fake, { platform: 'win32', env: { OC_TERMINAL_ALLOW_VISIBLE: '1' } }), false);
  assert.equal(patchChildProcess(fake, { platform: 'linux', env: {} }), false);
});

test('patchBun: Bun.spawn and Bun.spawnSync default hidden, once', () => {
  const calls = [];
  const bun = {
    spawn: (cmd, options) => calls.push(options),
    spawnSync: (cmd, options) => calls.push(options),
  };
  const opts = { platform: 'win32', env: {} };
  assert.equal(patchBun(bun, opts), true);
  assert.equal(patchBun(bun, opts), true);

  bun.spawn(['cmd']);
  bun.spawn(['cmd'], { env: {} });
  bun.spawnSync(['cmd'], { windowsHide: false });

  assert.equal(calls.length, 3);
  for (const options of calls) assert.equal(options.windowsHide, true);
});

test('install: reports patched for fake modules, skips when not Windows or explicitly visible', () => {
  const fake = { spawn: () => {}, spawnSync: () => {} };
  const fakeBun = { spawn: () => {}, spawnSync: () => {} };
  assert.equal(install({ cp: fake, bun: fakeBun, platform: 'win32', env: {} }).patched, true);
  assert.equal(install({ cp: {}, bun: null, platform: 'linux', env: {} }).patched, false);
  assert.equal(
    install({ cp: {}, bun: null, platform: 'win32', env: { OC_TERMINAL_ALLOW_VISIBLE: '1' } }).patched,
    false,
  );
});

test('spawnSyncHidden: runs a real child and captures its output', () => {
  const result = spawnSyncHidden(process.execPath, ['-e', "process.stdout.write('ok')"], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok');
});

test('plugin: id and setup are safe on a hostile or absent context', () => {
  assert.equal(plugin.id, 'oc-terminal');
  assert.equal(typeof plugin.setup, 'function');
  const previous = process.env.OC_TERMINAL_ALLOW_VISIBLE;
  process.env.OC_TERMINAL_ALLOW_VISIBLE = '1';
  try {
    assert.doesNotThrow(() => plugin.setup(undefined));
    assert.doesNotThrow(() => plugin.setup({}));
    assert.doesNotThrow(() => plugin.setup({ tool: { transform: () => { throw new Error('refused'); } } }));
  } finally {
    if (previous === undefined) delete process.env.OC_TERMINAL_ALLOW_VISIBLE;
    else process.env.OC_TERMINAL_ALLOW_VISIBLE = previous;
  }
});

test('manifest: private, every declared file exists, and no third-party imports', () => {
  assert.equal(manifest.private, true);
  for (const rel of [manifest.main, ...Object.values(manifest.exports ?? {}), ...(manifest.files ?? [])]) {
    assert.ok(fs.existsSync(path.join(PKG, rel)), `${rel} is declared but missing`);
  }
  for (const file of ['index.js', 'lib.js', 'cli.js']) {
    const text = fs.readFileSync(path.join(PKG, file), 'utf8');
    for (const match of text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(
        match[1].startsWith('node:') || match[1].startsWith('.'),
        `${file} imports ${match[1]}; only node: built-ins and sibling files are allowed`,
      );
    }
    assert.ok(!/cmd\s*\/c/i.test(text), `${file} shells through cmd /c; spawn the program directly`);
  }
});
