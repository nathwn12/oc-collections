import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../lib/sessions.js';
import { incompleteEscapeStart } from '../lib/ansi.js';

test('a maxBytes cut inside a multi-byte character loses nothing', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  // 3-byte CJK next to a 4-byte emoji: almost every 7-byte window below lands
  // inside a character unless the ring ends the slice on a boundary. The second
  // copy is written later, so it lands after the first read and is cut by
  // maxBytes rather than arriving with the terminal's startup escapes.
  const payload = '漢字🙂'.repeat(8);
  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: [
      '-e',
      `process.stdout.write(${JSON.stringify(payload)});`
      + `setTimeout(() => process.stdout.write(${JSON.stringify(payload)}), 500);`
      + 'setInterval(() => {}, 1000);',
    ],
    description: 'print cjk and emoji wider than the window',
  });

  let cursor;
  let collected = '';
  const chunks = [];
  const target = payload.length * 2;
  const deadline = Date.now() + 8000;
  let state = await manager.read(sessionId, { cursor, maxBytes: 7, waitMs: 1000 });
  while (Date.now() < deadline && collected.length < target) {
    if (state.data !== '') {
      chunks.push(state.data);
      collected += state.data;
    }
    cursor = state.cursor;
    state = await manager.read(sessionId, { cursor, maxBytes: 7, waitMs: 1000 });
  }

  assert.ok(chunks.length > 3, `the payload must arrive in several chunks, got ${chunks.length}`);
  assert.ok(
    !chunks.some((chunk) => chunk.includes('\uFFFD')),
    `no chunk may carry a replacement character: ${JSON.stringify(chunks)}`,
  );
  assert.equal(collected, payload + payload, 'successive reads must rebuild the exact text');
});

test('incompleteEscapeStart names the head of a split sequence', () => {
  assert.equal(incompleteEscapeStart('plain text'), -1);
  assert.equal(incompleteEscapeStart('a\u001b'), 1, 'a lone ESC is unfinished');
  assert.equal(incompleteEscapeStart('ab\u001b['), 2, 'CSI without its final byte is unfinished');
  assert.equal(incompleteEscapeStart('ab\u001b[1;3'), 2, 'CSI parameters without a final byte are unfinished');
  assert.equal(incompleteEscapeStart('\u001b[31mred'), -1, 'a complete CSI is not a tail');
  assert.equal(incompleteEscapeStart('x\u001b]0;title'), 1, 'OSC without BEL or ST is unfinished');
  assert.equal(incompleteEscapeStart('x\u001b]0;title\u0007y'), -1, 'a BEL-terminated OSC is complete');
  assert.equal(incompleteEscapeStart('x\u001b]0;title\u001b\\y'), -1, 'an ST-terminated OSC is complete');
});

test('an escape sequence cut by the read window never leaks into data', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  // maxBytes: 3 forces windows that end inside each SGR sequence, which is the
  // same split a slow terminal produces; the child stays alive so the withhold
  // path, not the exit flush, is what gets exercised.
  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: [
      '-e',
      "process.stdout.write('A\\u001b[31mB\\u001b[32mC\\u001b[0m');"
      + 'setInterval(() => {}, 1000);',
    ],
    description: 'colour escapes wider than the window',
  });

  let cursor;
  let collected = '';
  const chunks = [];
  const deadline = Date.now() + 6000;
  let state = await manager.read(sessionId, { cursor, maxBytes: 3, waitMs: 500, stripAnsi: true });
  while (Date.now() < deadline && collected !== 'ABC') {
    if (state.data !== '') {
      chunks.push(state.data);
      collected += state.data;
    }
    cursor = state.cursor;
    state = await manager.read(sessionId, { cursor, maxBytes: 3, waitMs: 500, stripAnsi: true });
  }

  assert.equal(collected, 'ABC', `successive reads must return only the visible text: ${JSON.stringify(chunks)}`);
  assert.ok(
    !chunks.some((chunk) => chunk.includes('\u001b')),
    'no chunk may carry an escape byte',
  );
  assert.ok(
    !chunks.some((chunk) => /\[?\d+[A-Za-z]/.test(chunk)),
    `no chunk may carry a sequence tail as literal text: ${JSON.stringify(chunks)}`,
  );
});

test('description is optional, bounded, and defaults to the title', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const short = manager.spawn({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    description: 'two words',
  });
  assert.equal(manager.list().sessions.find((s) => s.sessionId === short.sessionId).description, 'two words');

  const omitted = manager.spawn({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    title: 'unnamed',
  });
  assert.equal(
    manager.list().sessions.find((s) => s.sessionId === omitted.sessionId).description,
    'unnamed',
    'an omitted description falls back to the title',
  );

  assert.throws(
    () => manager.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      description: 'x'.repeat(201),
    }),
    (err) => err.code === 'invalid_args' && /at most 200 characters/.test(err.message),
  );
  assert.throws(
    () => manager.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      description: '   ',
    }),
    (err) => err.code === 'invalid_args' && /must not be empty/.test(err.message),
  );
});

test('pty_list returns what a later reader needs: description, args, cwd and geometry', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const cwd = process.cwd();
  const spawned = manager.spawn({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd,
    cols: 132,
    rows: 43,
    description: 'long lived child for the list shape',
  });

  const [session] = manager.list().sessions;
  assert.equal(session.sessionId, spawned.sessionId);
  assert.equal(session.description, 'long lived child for the list shape');
  assert.deepEqual(session.args, ['-e', 'setInterval(() => {}, 1000)']);
  assert.equal(session.cwd, cwd);
  assert.equal(session.cols, 132);
  assert.equal(session.rows, 43);
  assert.equal(session.command, process.execPath);
});

test('pty_kill reports whether the process is actually gone', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const spawned = manager.spawn({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    description: 'child that must really die on kill',
  });

  const killed = await manager.kill(spawned.sessionId);
  assert.equal(killed.ok, true);
  assert.equal(killed.exited, true, 'a confirmed kill must say the process exited');
  assert.equal(killed.pid, spawned.pid);

  const again = await manager.kill(spawned.sessionId);
  assert.equal(again.ok, true, 'killing an exited session stays idempotent');
  assert.equal(again.exited, true);
});
