import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../lib/sessions.js';

const NODE = process.execPath;

// ConPTY reports the exit a moment after the process is gone, so a test that
// inspects a killed session waits for the session state rather than the kill
// reply.
async function waitForExit(manager, reference, cursor = 0, timeoutMs = 10000) {
  let state = await manager.read(reference, { cursor, waitMs: 1000 });
  const deadline = Date.now() + timeoutMs;
  while (!state.exited && Date.now() < deadline) {
    state = await manager.read(reference, { cursor: state.cursor, waitMs: 500 });
  }
  return state;
}

test('run returns the output and exit code of a command that finishes', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: NODE,
    args: ['-e', "process.stdout.write('RUN_OK'); process.exit(3)"],
    timeoutMs: 15000,
  });

  assert.match(result.data, /RUN_OK/);
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  assert.equal(result.matched, true, 'without match the run reports matched: true');
  assert.equal(result.truncated, false);
  assert.equal(result.name, null);
  assert.equal(typeof result.sessionId, 'string');
  assert.ok(result.cursor > 0);
  assert.ok(result.bytes >= result.cursor);
  assert.equal(typeof result.durationMs, 'number');
});

test('run writes stdin exactly as given', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  // The carriage return is part of the caller's string: a line-buffered
  // program needs it, and run adds nothing. \r is the Enter a Windows console
  // reads; a POSIX terminal translates it to \n.
  const result = await manager.run({
    command: NODE,
    args: [
      '-e',
      "process.stdin.once('data', (d) => { process.stdout.write('IN:' + d.toString().trim()); process.exit(0); })",
    ],
    stdin: 'hello\r',
    timeoutMs: 15000,
  });

  assert.match(result.data, /IN:hello/);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test('run kills the tree when timeoutMs runs out', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const started = Date.now();
  const result = await manager.run({
    command: NODE,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 500,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, true);
  assert.equal(result.matched, true, 'no match was given');
  assert.ok(elapsed >= 500, `the run must wait out the timeout, waited ${elapsed}ms`);
  assert.ok(elapsed < 15000, `the run must stop near the timeout, waited ${elapsed}ms`);

  const stopped = await waitForExit(manager, result.sessionId, result.cursor);
  assert.equal(stopped.exited, true, 'a timed-out run must kill the process tree unless keep is true');
});

test('run stops early when match appears in the output', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const started = Date.now();
  const result = await manager.run({
    command: NODE,
    args: [
      '-e',
      "process.stdout.write('BANNER');"
      + "setTimeout(() => process.stdout.write('READY>'), 300);"
      + 'setInterval(() => {}, 1000);',
    ],
    match: 'READY>',
    timeoutMs: 20000,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.matched, true);
  assert.equal(result.timedOut, false);
  assert.match(result.data, /BANNER/);
  assert.match(result.data, /READY>/, 'the text that matched must be in the data');
  assert.ok(elapsed < 15000, `a match must end the run before the timeout, took ${elapsed}ms`);

  const stopped = await waitForExit(manager, result.sessionId, result.cursor);
  assert.equal(stopped.exited, true, 'a matched run kills the tree unless keep is true');
});

test('run shell mode takes one platform command line', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: 'echo SHELL_OK',
    shell: true,
    timeoutMs: 15000,
  });
  assert.match(result.data, /SHELL_OK/);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);

  await assert.rejects(
    () => manager.run({ command: 'echo nope', args: ['nope'], shell: true }),
    (err) => err.code === 'invalid_args' && /args must be empty/.test(err.message),
  );
});

test('run caps data at maxBytes, drains the rest and reports truncation', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: NODE,
    args: ['-e', "process.stdout.write('x'.repeat(4096))"],
    maxBytes: 100,
    timeoutMs: 15000,
  });

  assert.equal(Buffer.byteLength(result.data, 'utf8'), 100, 'data must not exceed maxBytes');
  assert.equal(result.truncated, true);
  assert.ok(result.bytes >= 4096, 'bytes must report everything the command produced');
  assert.equal(result.exitCode, 0, 'a capped run still drains to the exit');

  // The same cap on a multi-byte stream still ends on a character boundary.
  const unicode = await manager.run({
    command: NODE,
    args: ['-e', "process.stdout.write('\\u00e9'.repeat(200))"],
    maxBytes: 5,
    timeoutMs: 15000,
  });
  assert.equal(Buffer.byteLength(unicode.data, 'utf8'), 4, 'five bytes fits two 2-byte characters');
  assert.doesNotMatch(unicode.data, /\uFFFD/);
});

test('run with keep and a name leaves a session addressable by name', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: NODE,
    args: ["-e", "process.stdout.write('KEPT'); setInterval(() => {}, 1000)"],
    name: 'kept-session',
    keep: true,
    match: 'KEPT',
    timeoutMs: 20000,
  });

  assert.equal(result.matched, true);
  assert.equal(result.name, 'kept-session');

  const listed = manager.list().sessions.find((session) => session.sessionId === result.sessionId);
  assert.equal(listed.name, 'kept-session');

  // The kept session is still running and readable by name from the cursor the
  // run returned, and writable by name.
  const read = await manager.read('kept-session', { cursor: result.cursor, waitMs: 200 });
  assert.equal(read.exited, false);
  assert.deepEqual(manager.write('kept-session', 'x', false), { ok: true });

  // A live name is never reused by run: that would attach a second program to
  // an id the caller thinks it owns.
  await assert.rejects(
    () => manager.run({
      command: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      name: 'kept-session',
    }),
    (err) => err.code === 'invalid_args' && /name_taken/.test(err.message),
  );

  const killed = await manager.kill('kept-session');
  assert.equal(killed.ok, true);
  assert.equal(killed.exited, true);
});

test('names validate, reuse, and an exited session yields its name', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  assert.throws(
    () => manager.spawn({ command: NODE, name: '-bad' }),
    (err) => err.code === 'invalid_args' && /name must be/.test(err.message),
  );
  assert.throws(
    () => manager.spawn({ command: NODE, name: 'a'.repeat(65) }),
    (err) => err.code === 'invalid_args',
  );

  const first = manager.spawn({
    command: NODE,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    name: 'worker.1',
  });
  assert.equal(first.name, 'worker.1');
  assert.equal(first.reused, false);

  const reused = manager.spawn({
    command: NODE,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    name: 'worker.1',
  });
  assert.equal(reused.sessionId, first.sessionId);
  assert.equal(reused.pid, first.pid);
  assert.equal(reused.reused, true);

  assert.deepEqual(manager.write('worker.1', 'x', false), { ok: true });
  await manager.read('worker.1', { waitMs: 50 });

  assert.throws(
    () => manager.spawn({ command: NODE, args: ['-e', '0'], name: 'worker.1', reuse: false }),
    (err) => err.code === 'invalid_args' && /name_taken/.test(err.message),
  );

  await manager.kill('worker.1');
  await waitForExit(manager, 'worker.1');

  const replaced = manager.spawn({
    command: NODE,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    name: 'worker.1',
  });
  assert.notEqual(replaced.sessionId, first.sessionId);
  assert.equal(replaced.reused, false);
  assert.equal(
    manager.list().sessions.filter((session) => session.name === 'worker.1').length,
    1,
    'only the new session holds the name',
  );
});

test('run and lookup errors are typed', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  await assert.rejects(
    () => manager.run({ command: '   ' }),
    (err) => err.code === 'invalid_args',
  );
  await assert.rejects(
    () => manager.run({ command: NODE, timeoutMs: 0 }),
    (err) => err.code === 'invalid_args' && /timeoutMs/.test(err.message),
  );
  await assert.rejects(
    () => manager.run({ command: NODE, maxBytes: 1048577 }),
    (err) => err.code === 'invalid_args' && /maxBytes/.test(err.message),
  );
  await assert.rejects(
    () => manager.run({ command: NODE, match: '[', timeoutMs: 1000 }),
    (err) => err.code === 'invalid_args' && /not a valid regular expression/.test(err.message),
  );
  await assert.rejects(
    () => manager.run({ command: 'no-such-binary-janua-run' }),
    (err) => err.code === 'spawn_failed',
  );

  await assert.rejects(
    () => manager.read('missing-session-name'),
    (err) => err.code === 'session_not_found' && /id or name/.test(err.message),
  );
});
