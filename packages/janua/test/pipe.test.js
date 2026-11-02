// The pipe fast path: `run` uses node's own spawn with piped stdio by default,
// because a ConPTY costs about a second and a one-shot command rarely needs a
// terminal. tty: true is the opt-back-in and keeps the PTY behaviour intact.
//
// Timing is not asserted here; `pipe: true` in pty_list is the observable that
// the process did not start under a PTY, and the CLI check measures the gain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../lib/sessions.js';

const NODE = process.execPath;
const WINDOWS_ONLY = process.platform !== 'win32';

async function waitForExit(manager, reference, cursor = 0, timeoutMs = 10000) {
  let state = await manager.read(reference, { cursor, waitMs: 500 });
  const deadline = Date.now() + timeoutMs;
  while (!state.exited && Date.now() < deadline) {
    state = await manager.read(reference, { cursor: state.cursor, waitMs: 500 });
  }
  return state;
}

// A pid is gone only when signalling it says so: EPERM means the process is
// still there but owned elsewhere, so it is not treated as gone.
async function waitForGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('run uses pipes by default: both streams, exit code, and pipe in the list', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: NODE,
    args: ['-e', "process.stdout.write('PIPE_OUT');process.stderr.write('PIPE_ERR')"],
    timeoutMs: 15000,
  });

  assert.match(result.data, /PIPE_OUT/);
  assert.match(result.data, /PIPE_ERR/, 'stderr is merged into the same stream');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.matched, true);
  assert.equal(result.truncated, false);
  assert.equal(typeof result.durationMs, 'number');

  const listed = manager.list().sessions.find((session) => session.sessionId === result.sessionId);
  assert.equal(listed.pipe, true, 'a default run has no PTY');
  assert.equal(listed.cols, 0);
  assert.equal(listed.rows, 0);
});

test('tty:true keeps the PTY path', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: NODE,
    args: ['-e', "process.stdout.write('PTY_ON')"],
    tty: true,
    timeoutMs: 20000,
  });

  assert.match(result.data, /PTY_ON/);
  assert.equal(result.exitCode, 0);

  const listed = manager.list().sessions.find((session) => session.sessionId === result.sessionId);
  assert.equal(listed.pipe, false);
  assert.equal(listed.cols, 80);
  assert.equal(listed.rows, 24);
});

test('run writes stdin and ends it so a reader sees EOF', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: NODE,
    args: [
      '-e',
      "let text='';process.stdin.setEncoding('utf8');"
      + "process.stdin.on('data',(d)=>{text+=d}).on('end',()=>process.stdout.write('IN:'+text))",
    ],
    stdin: 'hello',
    timeoutMs: 15000,
  });

  assert.equal(result.data, 'IN:hello', 'the exact bytes arrive, then EOF ends the read');
  assert.equal(result.exitCode, 0);
});

test('run kills a pipe tree when timeoutMs runs out', async (t) => {
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
  assert.equal(stopped.exited, true, 'a timed-out pipe run must kill the tree unless keep is true');
});

// The pipe child is spawned detached on POSIX so it leads its own process
// group. A timeout must therefore reach the whole tree: the shell's background
// child is exactly what a direct child.kill would leave running.
test('a POSIX timeout kills the pipe process group, not just the direct child', { skip: process.platform === 'win32' }, async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: '/bin/sh',
    args: ['-c', 'sleep 300 & echo "DESCENDANT:$!"; wait'],
    timeoutMs: 2000,
  });

  assert.equal(result.timedOut, true);
  const reported = /DESCENDANT:(\d+)/.exec(result.data);
  assert.ok(reported, `the shell must report its background child, got ${JSON.stringify(result.data)}`);
  const descendantPid = Number(reported[1]);

  const listed = manager.list().sessions.find((session) => session.sessionId === result.sessionId);
  assert.equal(await waitForGone(listed.pid), true, 'the direct child must be gone');
  assert.equal(
    await waitForGone(descendantPid),
    true,
    `the background descendant ${descendantPid} must die with the run`,
  );
});

test('run stops early when match appears in pipe output and kills it', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const started = Date.now();
  const result = await manager.run({
    command: NODE,
    args: [
      '-e',
      "process.stdout.write('BANNER');"
      + "setTimeout(() => process.stdout.write('READY>'), 200);"
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
  assert.equal(stopped.exited, true, 'a matched pipe run kills the tree unless keep is true');
});

test('run caps pipe output at maxBytes and still drains to the exit', async (t) => {
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
});

test('write reaches a live pipe session, and an exited one keeps the typed error', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: NODE,
    args: [
      '-e',
      "process.stdout.write('READY');"
      + "process.stdin.on('data', (d) => process.stdout.write('ECHO:' + d.toString()));"
      + 'setInterval(() => {}, 1000);',
    ],
    match: 'READY',
    keep: true,
    timeoutMs: 20000,
    name: 'pipe-live',
  });
  assert.equal(result.matched, true);

  const listed = manager.list().sessions.find((session) => session.sessionId === result.sessionId);
  assert.equal(listed.pipe, true);

  assert.deepEqual(manager.write('pipe-live', 'ping', false), { ok: true });
  const read = await manager.read('pipe-live', {
    cursor: result.cursor,
    waitMs: 5000,
    match: 'ECHO:ping',
  });
  assert.match(read.data, /ECHO:ping/);

  const killed = await manager.kill('pipe-live');
  assert.equal(killed.exited, true);
  // kill confirms the pid is gone; 'close' is what marks the session exited,
  // and only then is a write refused rather than fed to a dead pipe.
  const stopped = await waitForExit(manager, 'pipe-live');
  assert.equal(stopped.exited, true);
  assert.throws(
    () => manager.write('pipe-live', 'x'),
    (err) => err.code === 'pty_write_failed' && /exited/.test(err.message),
  );

  // A run that exited on its own is just as closed as a killed one.
  const finished = await manager.run({ command: NODE, args: ['-e', '0'], timeoutMs: 15000 });
  assert.throws(
    () => manager.write(finished.sessionId, 'x'),
    (err) => err.code === 'pty_write_failed' && /exited/.test(err.message),
  );
});

test('write to a pipe session sends a newline, not a carriage return', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: NODE,
    args: [
      '-e',
      "process.stdout.write('READY');"
      + "process.stdin.on('data', (d) => process.stdout.write('HEX:' + d.toString('hex')));"
      + 'setInterval(() => {}, 1000);',
    ],
    match: 'READY',
    keep: true,
    timeoutMs: 20000,
  });
  assert.equal(result.matched, true);

  assert.deepEqual(manager.write(result.sessionId, 'x'), { ok: true });
  const withNewline = await manager.read(result.sessionId, {
    cursor: result.cursor,
    waitMs: 5000,
    match: 'HEX:780a',
  });
  assert.match(withNewline.data, /HEX:780a/, 'a pipe must receive LF (0a), not CR (0d)');

  // newline:false still sends exactly the data and no line ending.
  assert.deepEqual(manager.write(result.sessionId, 'y', false), { ok: true });
  const bare = await manager.read(result.sessionId, {
    cursor: withNewline.cursor,
    waitMs: 5000,
    match: 'HEX:79',
  });
  assert.match(bare.data, /HEX:79/);

  await manager.kill(result.sessionId);
});

test('resize refuses a pipe session and names tty:true', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: NODE,
    args: ["-e", "process.stdout.write('READY'); setInterval(() => {}, 1000)"],
    match: 'READY',
    keep: true,
    timeoutMs: 20000,
  });

  assert.throws(
    () => manager.resize(result.sessionId, { cols: 100 }),
    (err) => err.code === 'pty_resize_failed' && /tty:true/.test(err.message),
  );

  await manager.kill(result.sessionId);
});

test('shell:true runs one command line through pipes', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const result = await manager.run({
    command: 'echo SHELL_PIPE_OK',
    shell: true,
    timeoutMs: 20000,
  });

  assert.match(result.data, /SHELL_PIPE_OK/);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test('a missing command is spawn_failed on the pipe path', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  await assert.rejects(
    () => manager.run({ command: 'no-such-binary-janua-pipe' }),
    (err) => err.code === 'spawn_failed' && /no-such-binary-janua-pipe/.test(err.message),
  );
});

// The same PATH resolution as a PTY, but spawn hands cmd.exe one pre-escaped
// command line: Windows must pass it verbatim or the embedded quotes arrive
// backslash-escaped and cmd reports the whole line as an unknown command.
test('a batch shim runs through the pipe path with its arguments intact', { skip: WINDOWS_ONLY }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'janua-pipe-shim-'));
  const manager = new SessionManager();
  t.after(() => {
    manager.killAll();
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    join(dir, 'args.js'),
    "process.stdout.write('SHIM_ARGV=' + JSON.stringify(process.argv.slice(2)))\r\n",
  );
  writeFileSync(
    join(dir, 'janua-pipe-shim.cmd'),
    `@echo off\r\n"${process.execPath}" "%~dp0args.js" %*\r\n`,
  );

  const result = await manager.run({
    command: 'janua-pipe-shim',
    args: ['hello world', 'plain'],
    env: { PATH: `${dir};${process.env.PATH}` },
    timeoutMs: 20000,
  });

  assert.match(result.data, /SHIM_ARGV=\["hello world","plain"\]/);
  assert.equal(result.exitCode, 0);
});
