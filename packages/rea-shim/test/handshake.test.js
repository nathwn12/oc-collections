'use strict';
//
// Spawned-binary MCP surface proof.
//
// The launcher speaks no JSON-RPC of its own: it resolves the JDK/Ghidra env
// contract and then hands stdio to `npx rea-agents --mcp`. These tests drive
// the REAL binary and assert the only thing this package can break:
//
//   1. stdout carries nothing but the upstream JSON-RPC frames (one per line),
//   2. the frames are neither rewritten nor injected on the way through,
//   3. the child exit code is forwarded.
//
// The upstream is a stub `npx` placed first on PATH, so the handshake is
// offline and deterministic. It is a passthrough contract, not a claim about
// upstream's tool inventory or its MCP revision negotiation.
//

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const discovery = require('../lib/discovery.js');

const PACKAGE_DIR = path.join(__dirname, '..');
const BIN = path.join(PACKAGE_DIR, 'bin', 'rea-shim.js');
const WINDOWS_ONLY = process.platform === 'win32' ? false : 'cmd.exe and .cmd shims are Windows-only';
const TIMEOUT_MS = 60000;
// Newest revision in the installed 2.2.0 binary's supported ladder
// (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07). The launcher
// never parses it; the assertion is that the value passes through untouched.
const PROTOCOL_VERSION = '2025-11-25';

function temporary(t, prefix = 'rea-shim-handshake-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFakeGhidra(dir, { version = '12.2', minimum = '8' } = {}) {
  fs.mkdirSync(path.join(dir, 'Ghidra'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Ghidra', 'application.properties'), [
    `application.version=${version}`,
    `application.java.min=${minimum}`,
    'application.java.max=',
  ].join('\n'));
}

// The stub upstream. It records every frame it receives, answers `initialize`
// by echoing the client's protocol version, and answers `tools/list` with a
// fixed inventory. Nothing else is invented.
const STUB_SERVER = [
  "'use strict';",
  "const fs = require('node:fs');",
  'const dump = process.env.STUB_DUMP;',
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  '  buffer += chunk;',
  '  let index;',
  "  while ((index = buffer.indexOf('\\n')) >= 0) {",
  '    const line = buffer.slice(0, index);',
  '    buffer = buffer.slice(index + 1);',
  "    if (!line.trim()) continue;",
  '    fs.appendFileSync(dump, line + \'\\n\');',
  '    const message = JSON.parse(line);',
  "    if (message.method === 'notifications/initialized') continue;",
  '    let result = {};',
  "    if (message.method === 'initialize') {",
  '      result = {',
  '        protocolVersion: message.params.protocolVersion,',
  '        capabilities: { tools: {} },',
  "        serverInfo: { name: 'stub-upstream', version: '0.0.0' },",
  '      };',
  "    } else if (message.method === 'tools/list') {",
  '      result = { tools: [',
  "        { name: 'stub_probe', description: 'stub tool one', inputSchema: { type: 'object' } },",
  "        { name: 'stub_second', description: 'stub tool two', inputSchema: { type: 'object' } },",
  '      ] };',
  '    }',
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
  '  }',
  '});',
  "process.stdin.on('end', () => process.exit(Number(process.env.STUB_EXIT || 0)));",
  '',
].join('\n');

function makeStubUpstream(t, { exitCode = 0 } = {}) {
  const bin = temporary(t, 'rea-shim-stub-npx-');
  const script = path.join(bin, 'stub-mcp.js');
  const dump = path.join(bin, 'received.jsonl');
  fs.writeFileSync(script, STUB_SERVER);
  fs.writeFileSync(path.join(bin, 'npx.cmd'), [
    '@echo off',
    '"%STUB_NODE%" "%STUB_SCRIPT%"',
    'exit /b %errorlevel%',
    '',
  ].join('\r\n'));
  return {
    bin,
    dump,
    env: {
      STUB_NODE: process.execPath,
      STUB_SCRIPT: script,
      STUB_DUMP: dump,
      STUB_EXIT: String(exitCode),
    },
  };
}

// Ambient GHIDRA/JDK overrides would make the fixture depend on this machine.
function isolatedEnv(extra) {
  const env = { ...process.env };
  for (const name of [discovery.GHIDRA_OVERRIDE_ENV, discovery.JDK_ENV, discovery.HOME_ENV]) delete env[name];
  for (const name of discovery.LEGACY_GHIDRA_ENVS) delete env[name];
  for (const name of discovery.LEGACY_JDK_ENVS) delete env[name];
  return { ...env, ...extra };
}

function context(t, { exitCode = 0 } = {}) {
  const root = temporary(t);
  const ghidra = path.join(root, 'ghidra');
  writeFakeGhidra(ghidra);
  // Reuse the package's own discovery as the oracle: any JDK it can see on
  // this machine satisfies the fixture's deliberately low floor. A machine
  // with no JDK at all skips, it never fakes one.
  const jdk = discovery.resolveJdk({ minimum: 8, maximum: null });
  if (!jdk) return null;
  const stub = makeStubUpstream(t, { exitCode });
  const env = isolatedEnv({
    [discovery.GHIDRA_OVERRIDE_ENV]: ghidra,
    [discovery.JDK_ENV]: jdk.home,
    [discovery.HOME_ENV]: path.join(root, 'no-bootstrap-installs'),
    [discovery.AGENTS_VERSION_ENV]: '6.8.0',
    PATH: `${stub.bin}${path.delimiter}${process.env.PATH || ''}`,
    ...stub.env,
  });
  return { env, stub, jdk };
}

function frameReader(child) {
  const lines = [];
  const byId = new Map();
  const waiters = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      lines.push(line);
      const message = JSON.parse(line);
      byId.set(message.id, message);
      for (let position = waiters.length - 1; position >= 0; position -= 1) {
        if (waiters[position].id !== message.id) continue;
        const waiter = waiters.splice(position, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  return {
    lines,
    byId,
    next(id) {
      if (byId.has(id)) return Promise.resolve(byId.get(id));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no JSON-RPC response for id ${id} within ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
        waiters.push({ id, resolve, timer });
      });
    },
  };
}

function spawnShim(t, env) {
  const child = spawn(process.execPath, [BIN], {
    cwd: PACKAGE_DIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(() => child.kill());
  return { child, frames: frameReader(child), stderr, exited };
}

function send(child, message) {
  child.stdin.write(JSON.stringify(message) + '\n');
}

test('the spawned launcher answers initialize and tools/list over stdio', { skip: WINDOWS_ONLY }, async (t) => {
  const built = context(t);
  if (!built) {
    t.skip('no JDK on this machine for the run-path gate');
    return;
  }
  const { child, frames, stderr, exited } = spawnShim(t, built.env);

  send(child, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'rea-shim-handshake', version: '0.0.0' },
    },
  });
  const initialized = await frames.next(1);
  assert.equal(initialized.jsonrpc, '2.0');
  assert.equal(initialized.result.protocolVersion, PROTOCOL_VERSION, 'the launcher must not rewrite the negotiated version');
  assert.equal(typeof initialized.result.capabilities.tools, 'object');
  assert.equal(initialized.result.serverInfo.name, 'stub-upstream');

  send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await frames.next(2);
  assert.ok(Array.isArray(listed.result.tools) && listed.result.tools.length > 0, 'tools/list must be non-empty');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['stub_probe', 'stub_second']);

  child.stdin.end();
  const exit = await exited;
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0);

  // stdout purity: exactly the two responses, one JSON-RPC frame per line.
  assert.equal(frames.lines.length, 2, `stdout must carry only JSON-RPC frames, saw: ${JSON.stringify(frames.lines)}`);
  for (const line of frames.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');

  // Passthrough: upstream received byte-identical frames, nothing injected.
  const received = fs.readFileSync(built.stub.dump, 'utf8').trim().split('\n');
  assert.equal(received.length, 2);
  assert.deepEqual(received.map((line) => JSON.parse(line).method), ['initialize', 'tools/list']);
  assert.equal(JSON.parse(received[0]).params.protocolVersion, PROTOCOL_VERSION);

  // Everything the launcher says about itself goes to stderr.
  const traced = stderr.join('');
  assert.match(traced, /starting upstream: cmd\.exe \/d \/c npx -y rea-agents@6\.8\.0 --mcp/);
  assert.match(traced, new RegExp(`env: GHIDRA_INSTALL_DIR=${built.env[discovery.GHIDRA_OVERRIDE_ENV].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('the launcher forwards the child exit code to the MCP client', { skip: WINDOWS_ONLY }, async (t) => {
  const built = context(t, { exitCode: 7 });
  if (!built) {
    t.skip('no JDK on this machine for the run-path gate');
    return;
  }
  const { child, frames, exited } = spawnShim(t, built.env);
  send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '0' } } });
  await frames.next(1);
  child.stdin.end();
  const exit = await exited;
  assert.equal(exit.code, 7);
});

test('a refusal writes nothing to stdout', { skip: WINDOWS_ONLY }, (t) => {
  const root = temporary(t);
  const result = spawnSync(process.execPath, [BIN], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: isolatedEnv({ [discovery.HOME_ENV]: path.join(root, 'empty') }),
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '', 'a refusal must not corrupt the JSON-RPC channel');
  // Which dependency is missing depends on the machine (Ghidra or its JDK);
  // the contract is that a refusal is stderr-only, non-zero, and never a
  // half-open channel.
  assert.match(result.stderr, /^rea-shim: refusing: no (Ghidra dir|JDK satisfying)/);
});

test('--print-config emits the mcp.servers block OpenCode 2.2.0 writes', (t) => {
  const root = temporary(t);
  const result = spawnSync(process.execPath, [BIN, '--print-config'], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: isolatedEnv({ [discovery.HOME_ENV]: path.join(root, 'empty') }),
  });
  assert.equal(result.status, 0);
  const block = JSON.parse(result.stdout);
  // Shape oracle: `opencode mcp add <name> -- <cmd>` on 2.2.0 writes exactly
  // { mcp: { servers: { <name>: { type: 'local', command: [...] } } } }.
  assert.deepEqual(Object.keys(block), ['mcp']);
  assert.deepEqual(Object.keys(block.mcp), ['servers']);
  const entry = block.mcp.servers.rea;
  assert.deepEqual(Object.keys(entry).sort(), ['command', 'type']);
  assert.equal(entry.type, 'local');
  assert.deepEqual(entry.command, ['cmd', '/c', 'npx', '-y', 'rea-shim@latest']);
});

test('package scripts cover the whole package', (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts, 'package.json must carry test/check scripts');
  assert.match(pkg.scripts.test, /node --test/);
  assert.match(pkg.scripts.test, /test\//, 'the test script must run the test directory');
  for (const file of [...fs.readdirSync(path.join(PACKAGE_DIR, 'lib')).map((name) => `lib/${name}`),
    ...fs.readdirSync(path.join(PACKAGE_DIR, 'bin')).map((name) => `bin/${name}`)]) {
    if (!file.endsWith('.js')) continue;
    assert.ok(pkg.scripts.check.includes(`node --check ${file}`), `scripts.check must syntax-check ${file}`);
  }
});
