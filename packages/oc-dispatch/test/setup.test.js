import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, preview } from '../src/setup.mjs';

const ENTRY = 'github:nathwn12/oc-collections#main::path:packages/oc-dispatch';
const COMMENTED = '{\n  // keep me\n  "plugins": [],\n  "experimental": { "subagent_depth": 1 } // tail\n}\n';

test('preview preserves JSONC comments and edits only the two target values', () => {
  const p = preview({ text: COMMENTED, entry: ENTRY, depth: 2 });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.changed, true);
  assert.match(p.text, /\/\/ keep me/);
  assert.match(p.text, /\/\/ tail/);
  assert.deepEqual(p.after.plugins, [ENTRY]);
  assert.equal(p.after.experimental.subagent_depth, 2);
  assert.equal(p.before.experimental.subagent_depth, 1, 'the parsed before is left intact');

  const added = preview({ text: '{ "a": 1 }', entry: ENTRY, depth: 3 });
  assert.equal(added.ok, true);
  assert.deepEqual(added.after.plugins, [ENTRY]);
  assert.equal(added.after.experimental.subagent_depth, 3);
  assert.equal(added.after.a, 1);
});

test('preview refuses bad input instead of writing a broken file', () => {
  assert.deepEqual(preview({ text: '{ nope' }).reason, 'config-invalid');
  assert.equal(preview({ text: '[]' }).reason, 'config-not-object');
  assert.equal(preview({ text: '{}', entry: '' }).reason, 'bad-entry');
  assert.equal(preview({ text: '{}', depth: -1 }).reason, 'bad-depth');
  assert.equal(preview({}).reason, 'config-unreadable');
});

test('apply backs up, writes atomically and is a no-op the second time', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-'));
  const target = path.join(dir, 'opencode.jsonc');
  writeFileSync(target, COMMENTED);
  const result = apply({ target, entry: ENTRY, depth: 2 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.equal(existsSync(target + '.bak'), true);
  assert.equal(readFileSync(target + '.bak', 'utf8'), COMMENTED);
  const written = readFileSync(target, 'utf8');
  assert.match(written, /\/\/ keep me/);
  assert.equal(JSON.parse(written.replace(/\/\/.*$/gm, '')).experimental.subagent_depth, 2);

  const again = apply({ target, entry: ENTRY, depth: 2 });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(readFileSync(target, 'utf8'), written);
});

test('apply rolls back to the original bytes when the written file fails validation', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-'));
  const target = path.join(dir, 'opencode.jsonc');
  const original = '{\n "a": 1\n}\n';
  writeFileSync(target, original);
  const tempSuffix = '.tmp-' + process.pid;
  const result = apply({
    target,
    entry: ENTRY,
    depth: 2,
    write: (p, data) => writeFileSync(p, String(p).endsWith(tempSuffix) ? '{broken' : data),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write-rolled-back');
  assert.equal(readFileSync(target, 'utf8'), original, 'the target keeps its original bytes');
});
