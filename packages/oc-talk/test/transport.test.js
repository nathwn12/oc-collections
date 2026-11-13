// Unit tests for the transport: what it never leaks and how it recovers from a
// service that rebooted on a new port. No live service is needed — the state file
// is pointed at a fixture and, where a response matters, at a throwaway loopback
// server this file starts and closes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const TRANSPORT = path.join(import.meta.dirname, '..', 'src', 'transport.mjs');
const SCRATCH = path.join(os.tmpdir(), 'oc-talk-transport-' + process.pid);

let loads = 0;
// Fresh module per test: the endpoint cache, the resolved secret and the state
// file path are all module state.
function load(statePath) {
  process.env.OC_TALK_STATE_FILE = statePath;
  return import(pathToFileURL(TRANSPORT).href + '?n=' + ++loads);
}

function stateFile(name, contents) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const file = path.join(SCRATCH, name);
  fs.writeFileSync(file, contents);
  return file;
}

const SECRET = 'pw-do-not-leak-4c1f9e';

test('a malformed state file never puts its own bytes in the detail', async () => {
  // Missing closing brace: the reader's error message would quote this text, and
  // that text carries the password.
  const file = stateFile('malformed.json', '{"url":"http://127.0.0.1:1","password":"' + SECRET + '"');
  const transport = await load(file);
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
    const file = stateFile('echo.json', JSON.stringify({ url: 'http://0.0.0.0:' + port, password: SECRET }));
    const transport = await load(file);
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
    const file = stateFile('retry.json', JSON.stringify({ url: 'http://0.0.0.0:' + port, password: SECRET }));
    const transport = await load(file);
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
    const file = stateFile('noreplay.json', JSON.stringify({ url: 'http://0.0.0.0:' + port, password: SECRET }));
    const transport = await load(file);
    const r = await transport.request('POST', '/api/session/ses_x/prompt', { body: { text: 'hi' } });
    assert.equal(r.ok, false);
    assert.equal(calls, 1, 'a send without an idempotency id is not safe to replay');
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
    const file = stateFile('lane.json', JSON.stringify({ url: 'http://0.0.0.0:' + port, password: SECRET }));
    const transport = await load(file);
    const r = await transport.prompt('ses_x', { text: 'hi', id: 'msg_' + 'b'.repeat(32) });
    assert.equal(r.ok, true, 'the send must reach the server: ' + JSON.stringify(r));
    assert.equal(JSON.parse(body).delivery, 'steer', 'the fallback lane is steer, never queue');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
