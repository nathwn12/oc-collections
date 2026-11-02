import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'janua.js');
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

function janua(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('janua run prints the command output and exits with the child code', () => {
  const result = janua([
    'run',
    '--',
    process.execPath,
    '-e',
    "process.stdout.write('CLI_OK'); process.exit(4)",
  ]);

  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'CLI_OK', 'stdout must be the data and nothing else');
});

test('janua run --json prints the whole result', () => {
  const result = janua([
    'run',
    '--json',
    '--max-bytes',
    '65536',
    '--',
    process.execPath,
    '-e',
    "process.stdout.write('JSON_OK'); process.exit(0)",
  ]);

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.data, /JSON_OK/);
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.timedOut, false);
  assert.equal(payload.matched, true);
  assert.equal(payload.truncated, false);
  assert.equal(typeof payload.sessionId, 'string');
  assert.equal(typeof payload.durationMs, 'number');
});

test('janua run exits 124 when --timeout runs out', () => {
  const result = janua([
    'run',
    '--timeout',
    '500',
    '--',
    process.execPath,
    '-e',
    'setInterval(() => {}, 1000)',
  ]);

  assert.equal(result.status, 124);
});

test('janua --version prints the package version', () => {
  const result = janua(['--version']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
  assert.equal(janua(['-v']).stdout.trim(), pkg.version);
});

test('janua run --name reports the name, then the one-shot run ends its session', () => {
  const result = janua([
    'run',
    '--json',
    '--name',
    'cli-named',
    '--match',
    'KEPT',
    '--',
    process.execPath,
    '-e',
    "process.stdout.write('KEPT'); setInterval(() => {}, 1000)",
  ]);

  assert.equal(result.status, 1, 'a matched run has no exit code yet');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.matched, true);
  assert.equal(payload.timedOut, false);
  assert.equal(payload.name, 'cli-named');
  assert.match(payload.data, /KEPT/);
});

test('janua run --keep is refused: the CLI cannot keep a session it kills on exit', () => {
  const result = janua(['run', '--keep', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option --keep/);
});

test('janua run without a command is a usage error, not a hang', () => {
  const result = janua(['run']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /no command given/);
});
