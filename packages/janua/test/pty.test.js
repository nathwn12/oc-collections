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

// The shape a ConPTY produces: the mode-set escapes land as the first chunk and
// the visible line only afterwards. A child that writes the escapes, pauses,
// then writes its line reproduces that without depending on ConPTY timing.
const MODE_ESCAPES = '\u001b[?9001h\u001b[?1004h';

function escapesThenLine(line, delayMs) {
  return [
    '-e',
    `process.stdout.write(${JSON.stringify(MODE_ESCAPES)});`
    + `setTimeout(() => process.stdout.write(${JSON.stringify(`${line}\r\n`)}), ${delayMs});`
    + 'setInterval(() => {}, 1000);',
  ];
}

test('one stripped read waits past an escape-only chunk for the visible line', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const visible = manager.spawn({
    command: process.execPath,
    args: escapesThenLine('SECONDREAD', 400),
    description: 'escapes first then a visible line',
  });
  const single = await manager.read(visible.sessionId, { waitMs: 5000 });
  assert.match(single.data, /SECONDREAD/, 'one read with a wait must return the text behind the escapes');
  assert.ok(single.cursor > Buffer.byteLength(MODE_ESCAPES), 'the cursor must pass the escape bytes');

  // Nothing is replayed: the next read starts where the first one stopped.
  const next = await manager.read(visible.sessionId, { cursor: single.cursor, waitMs: 200 });
  assert.doesNotMatch(next.data, /SECONDREAD/);
  assert.ok(next.cursor >= single.cursor);

  // A raw read still returns the escapes themselves, without waiting for text.
  const raw = manager.spawn({
    command: process.execPath,
    args: escapesThenLine('LATE_TEXT', 1500),
    description: 'escapes first and the text much later',
  });
  const first = await manager.read(raw.sessionId, { stripAnsi: false, waitMs: 5000 });
  assert.ok(first.data.includes(MODE_ESCAPES), 'stripAnsi: false must return the escape bytes');
  assert.doesNotMatch(first.data, /LATE_TEXT/, 'stripAnsi: false must not wait for visible text');

  // Bytes discarded while the stripped read waited are still reported, and the
  // cursor is the absolute end of what came back.
  const tight = new SessionManager({ maxBufferBytes: 512 });
  t.after(() => tight.killAll());
  const capped = tight.spawn({
    command: process.execPath,
    args: escapesThenLine('DROPPED-TAIL'.repeat(100), 300),
    description: 'escapes first then more text than the ring',
  });
  const cut = await tight.read(capped.sessionId, { waitMs: 5000 });
  assert.ok(cut.dropped > 0, 'bytes the ring discarded before the read must be reported');
  assert.match(cut.data, /DROPPED-TAIL/);
  const replayed = await tight.read(capped.sessionId, { cursor: cut.cursor, waitMs: 200 });
  assert.equal(replayed.dropped, 0, 'a cursor at the end loses nothing');
  assert.equal(replayed.data, '');
});

test('one read with match waits for the prompt and reports matched', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: [
      '-e',
      "process.stdout.write('WELCOME\\r\\n');"
      + "setTimeout(() => process.stdout.write('READY>'), 400);"
      + 'setInterval(() => {}, 1000);',
    ],
    description: 'banner then a prompt after a pause',
  });

  const read = await manager.read(sessionId, { match: 'READY>', waitMs: 5000 });
  assert.equal(read.matched, true);
  assert.match(read.data, /WELCOME/);
  assert.match(read.data, /READY>/, 'the prompt itself must be in the data that matched');
  assert.equal(read.exited, false);
  assert.ok(read.cursor > 0);

  // With stripAnsi: false the pattern is matched against the raw text, escapes
  // included, so an escape-only chunk can satisfy it without any visible text.
  const rawSession = manager.spawn({
    command: process.execPath,
    args: escapesThenLine('RAW_LINE', 400),
    description: 'escapes first then a visible line',
  });
  const rawRead = await manager.read(rawSession.sessionId, { match: '\\[\\?1004h', stripAnsi: false, waitMs: 5000 });
  assert.equal(rawRead.matched, true, 'a raw read must match escape bytes');
  assert.ok(rawRead.data.includes('\u001b[?1004h'));
  assert.doesNotMatch(rawRead.data, /RAW_LINE/, 'a raw read must not wait for visible text');
});

test('a match that never appears reports matched false after the deadline', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: ['-e', "process.stdout.write('BANNER_ONLY\\r\\n'); setInterval(() => {}, 1000);"],
    description: 'print a banner and never a prompt',
  });

  const started = Date.now();
  const read = await manager.read(sessionId, { match: 'NEVER_APPEARS', waitMs: 700 });
  const elapsed = Date.now() - started;

  assert.equal(read.matched, false, 'a pattern that never appears must report matched: false');
  assert.match(read.data, /BANNER_ONLY/, 'whatever arrived must still come back');
  assert.ok(elapsed >= 600, `the read must wait out the deadline, waited ${elapsed}ms`);
  assert.ok(elapsed < 5000, `the read must not overshoot the deadline, waited ${elapsed}ms`);
  assert.equal(read.exited, false);
});

test('an invalid match pattern is a typed invalid_args, not a throw', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    description: 'idle child for pattern validation',
  });

  await assert.rejects(
    () => manager.read(sessionId, { match: '[', waitMs: 100 }),
    (err) => err.name === 'JanuaError'
      && err.code === 'invalid_args'
      && /not a valid regular expression/.test(err.message),
  );
  await assert.rejects(
    () => manager.read(sessionId, { match: 'x'.repeat(201), waitMs: 100 }),
    (err) => err.code === 'invalid_args' && /at most 200 characters/.test(err.message),
  );
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
