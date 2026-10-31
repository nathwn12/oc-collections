// Command resolution: a bare name must reach the program a shell would run.
//
// On Windows that is not what CreateProcess does: it ignores PATHEXT, so every
// .cmd shim on PATH (npm, npx, pnpm, yarn, tsc) fails with error code 2. The
// resolver walks PATH x PATHEXT and sends batch files through cmd /c. The
// POSIX cases are pure unit checks so they run on any platform; the shim cases
// need a real cmd.exe and are skipped elsewhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager, resolveSpawn } from '../lib/sessions.js';

const WINDOWS_ONLY = process.platform !== 'win32';

async function readUntil(manager, sessionId, pattern, { timeoutMs = 10000 } = {}) {
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

// A shim shaped like npm.cmd: it forwards its arguments to a real program, so
// an argument that cmd split or mangled shows up as a different argv.
function writeShim() {
  const dir = mkdtempSync(join(tmpdir(), 'janua-shim-'));
  writeFileSync(
    join(dir, 'args.js'),
    "process.stdout.write('SHIM_ARGV=' + JSON.stringify(process.argv.slice(2)))\r\n",
  );
  writeFileSync(
    join(dir, 'janua-shim.cmd'),
    `@echo off\r\n"${process.execPath}" "%~dp0args.js" %*\r\n`,
  );
  return dir;
}

test('POSIX leaves a bare name exactly as given', () => {
  const plan = resolveSpawn('npm', ['--version'], { platform: 'linux', env: { PATH: '/usr/bin' } });
  assert.deepEqual(plan, { file: 'npm', args: ['--version'], viaShell: false, resolved: null });
});

test('an unmatched name stays as given so spawn_failed can name it', () => {
  const plan = resolveSpawn('no-such-binary-janua', ['x'], {
    platform: 'win32',
    env: { PATH: 'Z:\\janua\\empty', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  });
  assert.equal(plan.file, 'no-such-binary-janua');
  assert.equal(plan.resolved, null);
  assert.equal(plan.viaShell, false);
});

test('a path is never resolved through PATH', () => {
  const command = process.execPath;
  const plan = resolveSpawn(command, ['-v'], { platform: 'win32', env: { PATH: '' } });
  assert.deepEqual(plan, { file: command, args: ['-v'], viaShell: false, resolved: null });
});

test('an .exe on PATH resolves to its absolute path and runs directly', { skip: WINDOWS_ONLY }, () => {
  const plan = resolveSpawn('node', ['-v'], { env: process.env });
  assert.match(plan.file, /node\.exe$/i);
  assert.equal(plan.viaShell, false);
  assert.deepEqual(plan.args, ['-v']);
});

test('a .cmd shim found on PATH runs and its marker arrives', { skip: WINDOWS_ONLY }, async (t) => {
  const dir = writeShim();
  const manager = new SessionManager();
  t.after(() => {
    manager.killAll();
    rmSync(dir, { recursive: true, force: true });
  });

  const { sessionId } = manager.spawn({
    command: 'janua-shim',
    args: ['--version'],
    env: { PATH: `${dir};${process.env.PATH}` },
    description: 'run a batch shim resolved from path',
  });

  const seen = await readUntil(manager, sessionId, /SHIM_ARGV=/);
  assert.match(seen.text, /SHIM_ARGV=\["--version"\]/);
  const [session] = manager.list().sessions;
  assert.equal(session.command, 'janua-shim', 'the name the caller used is what list reports');
});

test('an argument with a space survives the shim as one argument', { skip: WINDOWS_ONLY }, async (t) => {
  const dir = writeShim();
  const manager = new SessionManager();
  t.after(() => {
    manager.killAll();
    rmSync(dir, { recursive: true, force: true });
  });

  const { sessionId } = manager.spawn({
    command: 'janua-shim',
    args: ['hello world', 'plain', 'say "hi" now'],
    env: { PATH: `${dir};${process.env.PATH}` },
    description: 'pass spaced arguments through a batch shim',
  });

  const seen = await readUntil(manager, sessionId, /SHIM_ARGV=/);
  assert.match(seen.text, /SHIM_ARGV=\["hello world","plain","say \\"hi\\" now"\]/);
});

test('a caret argument is refused on the batch path, not silently mangled', { skip: WINDOWS_ONLY }, (t) => {
  const dir = writeShim();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () => resolveSpawn('janua-shim', ['a^b'], { env: { PATH: `${dir};${process.env.PATH}` } }),
    (err) => err.code === 'invalid_args' && /\^/.test(err.message),
  );
});
