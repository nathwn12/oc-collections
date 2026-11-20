// Unit tests for the transport: what it never leaks and how it recovers from a
// service that rebooted on a new port. No live service is needed — the state file
// is pointed at a fixture and, where a response matters, at a throwaway loopback
// server this file starts and closes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import nodeTest from 'node:test';
import { pathToFileURL } from 'node:url';

const TRANSPORT = path.join(import.meta.dirname, '..', 'src', 'transport.mjs');
const SCRATCH = path.join(os.tmpdir(), 'oc-talk-transport-' + process.pid);
const STATE_FILE = path.join(SCRATCH, 'state.json');

// Bun runs root-suite files in a shared process, where unrelated tests can
// overwrite OC_TALK_STATE_FILE. Run this file's suite in a child with its own
// environment; its tests still exercise the real transport module unchanged.
const ISOLATED = process.env.OC_TALK_TRANSPORT_TEST_ISOLATED === '1';
let childStarted = false;
function test(name, fn) {
  if (ISOLATED) {
    nodeTest(name, fn);
    return;
  }
  if (childStarted) return;
  childStarted = true;
  nodeTest('transport tests run in an isolated process', () => {
    const childArgs = process.versions.bun
      ? ['test', import.meta.filename]
      : ['--test', import.meta.filename];
    const child = spawnSync(process.execPath, childArgs, {
      encoding: 'utf8',
      env: { ...process.env, OC_TALK_TRANSPORT_TEST_ISOLATED: '1' },
    });
    assert.equal(child.error, undefined, 'could not start isolated test process');
    assert.equal(
      child.status,
      0,
      'isolated transport suite failed:\n' + child.stdout + child.stderr,
    );
  });
}

// The module captures its state-file path at import time and owns an endpoint
// cache. Reuse one fixture path, then drop the cache before each test.
function load() {
  // Bun may key ESM modules by path and ignore query-string cache busting.
  // Keep the module's captured path stable and replace its contents per test.
  process.env.OC_TALK_STATE_FILE = STATE_FILE;
  const transport = import(pathToFileURL(TRANSPORT).href);
  return transport.then((module) => {
    module.dropEndpoint();
    return module;
  });
}

function stateFile(contents) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(STATE_FILE, contents);
  return STATE_FILE;
}

const SECRET = 'pw-do-not-leak-4c1f9e';

test('a malformed state file never puts its own bytes in the detail', async () => {
  // Missing closing brace: the reader's error message would quote this text, and
  // that text carries the password.
  stateFile('{"url":"http://127.0.0.1:1","password":"' + SECRET + '"');
  const transport = await load();
  const ep = transport.serviceEndpoint();
  const out = JSON.stringify(ep);
  assert.equal(ep.error.code, 'backend_unavailable');
  assert.equal(ep.error.detail, 'opencode service state is unreadable');
  assert.ok(!out.includes(SECRET), 'the password must never appear in the result: ' + out);
});

test('a server message that echoes the password is scrubbed before it is returned', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(400, { 'content-type': 'application/json' });
    // A rejection that quotes the credential is exactly what a hostile or noisy
    // server can do: every outgoing detail is scrubbed of the resolved password.
    res.end(JSON.stringify({ _tag: 'BadRequestError', message: 'rejected for ' + SECRET }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    stateFile(JSON.stringify({ url: 'http://0.0.0.0:' + port, password: SECRET }));
    const transport = await load();
    const r = await transport.request('GET', '/api/session');
    assert.equal(r.ok, false);
    const out = JSON.stringify(r);
    assert.match(r.detail, /\[redacted\]/, 'the echoed password must be replaced: ' + r.detail);
    assert.ok(!out.includes(SECRET), 'the password must never appear in the result: ' + out);
    assert.ok(!seen[0].includes(SECRET), 'the password must never travel in a path');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a stale endpoint is dropped and retried once for an idempotent send', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (calls === 1) {
      // The service came back on a new port with a new credential: the cached
      // header is refused, which must re-read the state file rather than stick.
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _tag: 'UnauthorizedError' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { id: 'msg_sent', sessionID: 'ses_x' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    stateFile(JSON.stringify({ url: 'http://0.0.0.0:' + port, password: SECRET }));
    const transport = await load();
    const r = await transport.prompt('ses_x', { text: 'hi', id: 'msg_' + 'a'.repeat(32) });
    assert.equal(r.ok, true, 'the retry must succeed: ' + JSON.stringify(r));
    assert.equal(calls, 2, 'exactly one retry, then the answer');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a POST without a client id is never replayed after a 401', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ _tag: 'UnauthorizedError' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    stateFile(JSON.stringify({ url: 'http://0.0.0.0:' + port, password: SECRET }));
    const transport = await load();
    const r = await transport.request('POST', '/api/session/ses_x/prompt', { body: { text: 'hi' } });
    assert.equal(r.ok, false);
    assert.equal(calls, 1, 'a send without an idempotency id is not safe to replay');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// The stealth lane on the wire: the route and body are the contract the live
// service proved, so a drift in either is caught without a peer.
test('synthetic posts to the synthetic route with the exact body shape', async () => {
  let seenPath = '';
  let seenBody = '';
  const server = http.createServer((req, res) => {
    seenPath = req.url;
    let chunks = '';
    req.on('data', (c) => (chunks += c));
    req.on('end', () => {
      seenBody = chunks;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'msg_sent', type: 'synthetic' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    stateFile(JSON.stringify({ url: 'http://0.0.0.0:' + port, password: SECRET }));
    const transport = await load();
    const r = await transport.synthetic('ses_x', {
      text: 'hello',
      delivery: 'steer',
      id: 'msg_' + 'c'.repeat(32),
      metadata: { ocTalk: { from: 'ses_caller' } },
      description: 'oc-talk from dispatcher',
    });
    assert.equal(r.ok, true, 'the synthetic admission must succeed: ' + JSON.stringify(r));
    assert.equal(seenPath, '/api/session/ses_x/synthetic', 'the stealth route on the wire');
    assert.deepEqual(JSON.parse(seenBody), {
      text: 'hello',
      delivery: 'steer',
      metadata: { ocTalk: { from: 'ses_caller' } },
      description: 'oc-talk from dispatcher',
      id: 'msg_' + 'c'.repeat(32),
    });
    assert.equal(r.json.data.type, 'synthetic');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// The lane the transport sends when a caller names none. It is the last place a
// default could hide, so it is proved on the wire rather than in the caller.
test('a send with no lane named carries steer', async () => {
  let body = '';
  const server = http.createServer((req, res) => {
    let chunks = '';
    req.on('data', (chunk) => (chunks += chunk));
    req.on('end', () => {
      body = chunks;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'msg_sent', sessionID: 'ses_x' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    stateFile(JSON.stringify({ url: 'http://0.0.0.0:' + port, password: SECRET }));
    const transport = await load();
    const r = await transport.prompt('ses_x', { text: 'hi', id: 'msg_' + 'b'.repeat(32) });
    assert.equal(r.ok, true, 'the send must reach the server: ' + JSON.stringify(r));
    assert.equal(JSON.parse(body).delivery, 'steer', 'the fallback lane is steer, never queue');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
