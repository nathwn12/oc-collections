import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendLine, formatLine } from '../src/receipt.mjs';

test('a receipt is one line with model, tier, reason, cache age and spend', () => {
  const line = formatLine({
    at: new Date('2026-11-22T10:20:30.000Z'),
    model: 'p/free-a',
    tier: 'fast',
    reason: 'kind:title',
    cacheAgeMs: 1500.6,
    spend: 0.125,
  });
  assert.equal(
    line,
    '2026-11-22T10:20:30.000Z\tp/free-a\tfast\tkind:title\t1501ms\test. $0.1250',
  );
  assert.equal(line.split('\n').length, 1);
  const real = formatLine({
    at: new Date('2026-11-22T10:20:30.000Z'),
    model: 'p/free-a',
    tier: 'fast',
    reason: 'kind:title',
    spend: 0.125,
    estimated: false,
  });
  assert.match(real, /\t\$0\.1250$/, 'a real cost carries no estimate label');
});

test('a field with a newline or tab cannot split the line', () => {
  const line = formatLine({ at: new Date(0), model: 'p/a\tb', tier: 'x\ny', reason: null });
  assert.equal(line.split('\t').length, 6);
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /p\/a b/);
  assert.ok(line.includes('\t-\t'));
});

test('appendLine writes one line and never throws on an unwritable path', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-'));
  const file = path.join(dir, 'nested', 'dispatch.log');
  const line = formatLine({ at: new Date(0), model: 'p/a', tier: 'fast', reason: 'tier:fast' });
  assert.equal(appendLine(file, line), line);
  assert.equal(readFileSync(file, 'utf8'), line + '\n');
  appendLine(file, line);
  assert.equal(readFileSync(file, 'utf8').trimEnd().split('\n').length, 2);
  assert.doesNotThrow(() => appendLine('', line));
});
