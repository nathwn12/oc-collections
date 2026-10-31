import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../lib/sessions.js';

const MISSING_ID = '11111111-1111-1111-1111-111111111111';

async function readUntil(manager, sessionId, pattern, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  let cursor;
  while (Date.now() < deadline) {
    const chunk = await manager.read(sessionId, { cursor, maxBytes: 65536, waitMs: 200 });
    cursor = chunk.cursor;
    text += chunk.data;
    if (pattern.test(text)) return { text, cursor };
  }
  throw new Error(`timed out waiting for ${pattern} in ${JSON.stringify(text)}`);
}

test('spawn, read, list and kill a session', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const spawned = manager.spawn({
    command: process.execPath,
    args: ['-e', "process.stdout.write('JANUA_OK')"],
    description: 'write a marker and exit',
  });
  assert.equal(typeof spawned.sessionId, 'string');
  assert.ok(spawned.pid > 0);
  assert.equal(spawned.title, 'node.exe');

  const seen = await readUntil(manager, spawned.sessionId, /JANUA_OK/);
  assert.match(seen.text, /JANUA_OK/);

  const { sessions } = manager.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, spawned.sessionId);
  assert.equal(sessions[0].command, process.execPath);
  assert.ok(sessions[0].bytes > 0);
  assert.equal(typeof sessions[0].createdAt, 'string');

  assert.deepEqual(manager.kill(spawned.sessionId), { ok: true });

  const after = await manager.read(spawned.sessionId, { cursor: seen.cursor, waitMs: 2000 });
  assert.equal(after.exited, true);
  assert.equal(after.exitCode, 0);
});

test('write reaches a child that reads stdin', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: ['-e', "process.stdin.on('data', (d) => process.stdout.write('GOT:' + d))"],
    description: 'echo anything written to stdin',
  });

  assert.deepEqual(manager.write(sessionId, 'ping'), { ok: true });
  const seen = await readUntil(manager, sessionId, /GOT:/);
  assert.match(seen.text, /GOT:ping/);

  // A kill of a live program must actually end it, not just report ok.
  assert.deepEqual(manager.kill(sessionId), { ok: true });
  let state = await manager.read(sessionId, { cursor: seen.cursor, waitMs: 1000 });
  const deadline = Date.now() + 10000;
  while (!state.exited && Date.now() < deadline) {
    state = await manager.read(sessionId, { cursor: state.cursor, waitMs: 1000 });
  }
  assert.equal(state.exited, true);
  assert.equal(typeof state.exitCode, 'number');
});

test('a bogus session id is a typed session_not_found', async () => {
  const manager = new SessionManager();

  await assert.rejects(
    () => manager.read(MISSING_ID, {}),
    (err) => err.code === 'session_not_found' && err.name === 'JanuaError',
  );
  assert.throws(() => manager.write(MISSING_ID, 'x'), (err) => err.code === 'session_not_found');
  assert.throws(() => manager.kill(MISSING_ID), (err) => err.code === 'session_not_found');

  assert.throws(
    () => manager.spawn({ command: '   ', description: 'empty command must be rejected' }),
    (err) => err.code === 'invalid_args',
  );
  assert.throws(
    () => manager.spawn({ command: process.execPath, args: ['-v'], cwd: 'Z:\\janua\\no-such-dir', description: 'missing cwd must be rejected' }),
    (err) => err.code === 'invalid_args' && /cwd does not exist/.test(err.message),
  );
  assert.throws(
    () => manager.spawn({ command: 'no-such-binary-janua', args: [], description: 'missing binary must be typed' }),
    (err) => err.code === 'spawn_failed',
  );
});

test('cursor and maxBytes never duplicate output', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: ['-e', "process.stdout.write('0123456789'.repeat(4))"],
    description: 'print a fixed forty byte string',
  });

  let cursor = 0;
  let assembled = '';
  const deadline = Date.now() + 8000;
  let state = await manager.read(sessionId, { cursor, maxBytes: 8, stripAnsi: false, waitMs: 500 });
  while (Date.now() < deadline) {
    assert.ok(state.cursor >= cursor, 'cursor must be monotonic');
    assert.ok(Buffer.byteLength(state.data, 'utf8') <= 8, 'maxBytes must bound the chunk');
    assembled += state.data;
    cursor = state.cursor;
    if (state.exited && state.data === '') break;
    state = await manager.read(sessionId, { cursor, maxBytes: 8, stripAnsi: false, waitMs: 500 });
  }

  // Reading the same cursor twice returns the same bytes and nothing earlier.
  const again = await manager.read(sessionId, { cursor: 0, maxBytes: 8, stripAnsi: false });
  assert.equal(again.data, assembled.slice(0, Buffer.byteLength(again.data, 'utf8')));
  assert.ok(assembled.includes('0123456789'.repeat(4)));
  assert.equal(assembled.split('0123456789').length - 1, 4, 'each copy must appear exactly once');

  const full = await manager.read(sessionId, { cursor: 0, maxBytes: 1048576, stripAnsi: false });
  assert.equal(assembled, full.data, 'chunked reads must reassemble to the full output');
  assert.equal(full.cursor, manager.list().sessions[0].bytes);
});

test('list pages with limit and offset, newest last', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const spawned = manager.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      description: `pagination child number ${index} staying alive`,
    });
    ids.push(spawned.sessionId);
  }

  const first = manager.list({ limit: 2 });
  assert.equal(first.total, 3);
  assert.deepEqual(first.sessions.map((session) => session.sessionId), ids.slice(0, 2));
  assert.equal(first.nextOffset, 2);

  const rest = manager.list({ limit: 2, offset: first.nextOffset });
  assert.deepEqual(rest.sessions.map((session) => session.sessionId), ids.slice(2));
  assert.equal(rest.nextOffset, null, 'the last page has no next offset');

  const unpaged = manager.list();
  assert.equal(unpaged.sessions.length, 3);
  assert.equal(unpaged.nextOffset, null);

  const past = manager.list({ offset: 10 });
  assert.deepEqual(past.sessions, []);
  assert.equal(past.total, 3);
  assert.equal(past.nextOffset, null);

  assert.throws(() => manager.list({ limit: 0 }), (err) => err.code === 'invalid_args');
  assert.throws(() => manager.list({ limit: 201 }), (err) => err.code === 'invalid_args');
  assert.throws(() => manager.list({ offset: -1 }), (err) => err.code === 'invalid_args');
});
