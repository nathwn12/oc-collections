// pty_resize: the terminal a session was spawned with is not the terminal it
// has to stay. These tests drive the manager directly, so a failure names the
// seam (the node-pty call and the size reported afterwards) rather than a tool
// wrapper, and the MCP surface is covered in mcp.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../lib/sessions.js';

// Reads until the pattern matches the text collected so far, so a child's
// repeated report is found in the chunk it arrives in.
async function readUntil(manager, sessionId, pattern, cursor, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    const chunk = await manager.read(sessionId, { cursor, maxBytes: 65536, waitMs: 200 });
    cursor = chunk.cursor;
    text += chunk.data;
    if (pattern.test(text)) return { text, cursor };
  }
  throw new Error(`timed out waiting for ${pattern} in ${JSON.stringify(text)}`);
}

// A child that prints its terminal geometry now and again on every line it
// reads, which is what makes "did the resize reach the program?" observable
// from outside: the second report is printed after the resize.
//
// Each report is numbered, and the test waits for the number rather than for
// "GEOM=": ConPTY repaints the old screen when it is resized, so the first
// report's line comes back verbatim and a search for the bare geometry would
// read the repaint as a fresh answer.
//
// `_refreshSize()` is not decoration either. Node's tty stream caches the size
// it read at startup and only re-reads the OS when it handles a resize event,
// which on Windows never arrives, so a bare `process.stdout.columns` still
// answers with the spawn-time geometry after a real resize. The refresh is the
// same call Node makes on SIGWINCH, so the probe reports the terminal, not the
// cache.
const REPORT_GEOMETRY = [
  '-e',
  'let n = 0;'
  + 'const report = () => {'
  + 'n += 1;'
  + 'process.stdout._refreshSize();'
  + "process.stdout.write('GEOM#' + n + '=' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');"
  + '};'
  + 'report();'
  + "process.stdin.on('data', report);"
  + 'setInterval(() => {}, 1000);',
];

test('pty_resize applies a new size and pty_list reports it', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    description: 'idle child whose geometry is only ever resized',
  });

  // Let the console come up first, so this exercises the applied path rather
  // than the held-until-ready one.
  await manager.read(sessionId, { waitMs: 2000 });

  const before = manager.list().sessions[0];
  assert.equal(before.cols, 80);
  assert.equal(before.rows, 24);

  const resized = manager.resize(sessionId, { cols: 120, rows: 40 });
  assert.deepEqual(resized, { ok: true, cols: 120, rows: 40 });

  // The list is the second half of the contract: a resize that the tool applies
  // but the list does not report leaves the caller believing the old geometry.
  const after = manager.list().sessions[0];
  assert.equal(after.cols, 120, 'pty_list must report the resized columns');
  assert.equal(after.rows, 40, 'pty_list must report the resized rows');

  // One dimension alone is enough: the other keeps the size in force, and the
  // reply still states both so the caller does not have to remember.
  const half = manager.resize(sessionId, { cols: 90 });
  assert.deepEqual(half, { ok: true, cols: 90, rows: 40 });
  assert.deepEqual(
    { cols: manager.list().sessions[0].cols, rows: manager.list().sessions[0].rows },
    { cols: 90, rows: 40 },
  );

  const tall = manager.resize(sessionId, { rows: 12 });
  assert.deepEqual(tall, { ok: true, cols: 90, rows: 12 });
});

test('a child sees the terminal width after a resize', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: REPORT_GEOMETRY,
    description: 'child that prints its terminal geometry on demand',
  });

  const first = await readUntil(manager, sessionId, /GEOM#1=\d+x\d+/, undefined);
  assert.match(first.text, /GEOM#1=80x24/, 'the child must start at the spawned geometry');

  manager.resize(sessionId, { cols: 100, rows: 30 });

  // A line of input is the trigger: the second report is printed after the
  // resize, so the number it carries is the one that reached the program.
  manager.write(sessionId, 'again');
  const second = await readUntil(manager, sessionId, /GEOM#2=\d+x\d+/, first.cursor);
  const seen = second.text.match(/GEOM#2=(\d+)x(\d+)/);
  console.log(`child geometry after resize -> ${seen[0]}`);
  assert.equal(Number(seen[1]), 100, 'the child must read the resized column count, not the spawn-time one');
  assert.equal(Number(seen[2]), 30, 'the child must read the resized row count too');
});

test('a size outside 1..1000 is a typed invalid_args', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    description: 'idle child for resize validation',
  });

  const rejected = [
    { cols: 0 },
    { cols: -1 },
    { cols: 1001 },
    { rows: 0 },
    { rows: 1001 },
    { cols: 1.5 },
    { rows: 2.25 },
    { cols: '100' },
    { rows: true },
  ];
  for (const input of rejected) {
    assert.throws(
      () => manager.resize(sessionId, input),
      (err) => err.name === 'JanuaError' && err.code === 'invalid_args',
      `resize ${JSON.stringify(input)} must be rejected as invalid_args`,
    );
  }

  // Neither dimension is not a no-op: there is nothing to apply.
  assert.throws(
    () => manager.resize(sessionId, {}),
    (err) => err.code === 'invalid_args' && /give cols, rows, or both/.test(err.message),
  );

  // A rejected call must not have moved the terminal.
  assert.deepEqual(
    { cols: manager.list().sessions[0].cols, rows: manager.list().sessions[0].rows },
    { cols: 80, rows: 24 },
  );
});

test('resizing an exited session is a typed error, not a crash', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const { sessionId } = manager.spawn({
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    description: 'child that exits immediately',
  });

  const deadline = Date.now() + 8000;
  let state = await manager.read(sessionId, { waitMs: 1000 });
  while (!state.exited && Date.now() < deadline) {
    state = await manager.read(sessionId, { cursor: state.cursor, waitMs: 1000 });
  }
  assert.equal(state.exited, true, 'the child must be gone before the resize is attempted');

  assert.throws(
    () => manager.resize(sessionId, { cols: 100, rows: 30 }),
    (err) => err.name === 'JanuaError'
      && err.code === 'pty_resize_failed'
      // The guard's own wording, not node-pty's wrapped "Cannot resize a pty
      // that has already exited": the refusal has to happen before the call, so
      // it stays right where the deferred callback would otherwise throw.
      && /there is no terminal left to resize/.test(err.message),
  );

  // The failed call left the recorded geometry alone and the process alive: a
  // throw from inside node-pty's own deferred callback would kill the server.
  assert.deepEqual(
    { cols: manager.list().sessions[0].cols, rows: manager.list().sessions[0].rows },
    { cols: 80, rows: 24 },
  );
  assert.equal(manager.list().sessions[0].exitCode, 3);
});
