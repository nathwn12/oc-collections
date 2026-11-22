import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stripJsonc } from '../src/config.mjs';
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

test('trailing commas in plugins and experimental are edited, not duplicated', () => {
  const source = '{\n  // keep\n  "plugins": ["x",],\n  "experimental": { "subagent_depth": 1, },\n}\n';
  const p = preview({ text: source, entry: ENTRY, depth: 2 });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual(p.after.plugins, ['x', ENTRY]);
  assert.equal(p.after.experimental.subagent_depth, 2);
  assert.match(p.text, /\/\/ keep/);

  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-'));
  const target = path.join(dir, 'opencode.jsonc');
  writeFileSync(target, source);
  const applied = apply({ target, entry: ENTRY, depth: 2, env: { OPENCODE_CONFIG_DIR: dir } });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const written = readFileSync(target, 'utf8');
  assert.match(written, /\/\/ keep/);
  assert.deepEqual(JSON.parse(stripJsonc(written)).plugins, ['x', ENTRY]);
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
  const result = apply({ target, entry: ENTRY, depth: 2, env: { OPENCODE_CONFIG_DIR: dir } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.equal(existsSync(target + '.bak'), true);
  assert.equal(readFileSync(target + '.bak', 'utf8'), COMMENTED);
  const written = readFileSync(target, 'utf8');
  assert.match(written, /\/\/ keep me/);
  assert.equal(JSON.parse(written.replace(/\/\/.*$/gm, '')).experimental.subagent_depth, 2);

  const again = apply({ target, entry: ENTRY, depth: 2, env: { OPENCODE_CONFIG_DIR: dir } });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(readFileSync(target, 'utf8'), written);
});

test('apply refuses an outside path and a symlink, and reports a failed rollback', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-'));
  const cfg = path.join(dir, 'config');
  mkdirSync(cfg);
  const inside = path.join(cfg, 'opencode.jsonc');
  writeFileSync(inside, '{"a":1}\n');
  const outside = path.join(dir, 'outside.jsonc');
  writeFileSync(outside, '{"a":1}\n');
  const link = path.join(cfg, 'link.jsonc');
  symlinkSync(outside, link);
  const env = { OPENCODE_CONFIG_DIR: cfg };

  const escaped = apply({ target: outside, entry: ENTRY, depth: 2, env });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.reason, 'outside-config-dir');
  const linked = apply({ target: link, entry: ENTRY, depth: 2, env });
  assert.equal(linked.ok, false);
  assert.equal(linked.reason, 'symlink-target');
  assert.equal(readFileSync(outside, 'utf8'), '{"a":1}\n', 'the symlink target was not copied or changed');

  const valid = apply({ target: inside, entry: ENTRY, depth: 2, env });
  assert.equal(valid.ok, true, JSON.stringify(valid));

  const tempSuffix = '.tmp-' + process.pid;
  const broken = path.join(cfg, 'broken.jsonc');
  writeFileSync(broken, '{"a":1}\n');
  const failed = apply({
    target: broken,
    entry: ENTRY,
    depth: 2,
    env,
    write: (p, data) => {
      if (String(p).endsWith(tempSuffix)) writeFileSync(p, '{broken');
      else throw new Error('rollback denied');
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'rollback-failed', 'a failed restore is reported, not swallowed');
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
    env: { OPENCODE_CONFIG_DIR: dir },
    write: (p, data) => writeFileSync(p, String(p).endsWith(tempSuffix) ? '{broken' : data),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write-rolled-back');
  assert.equal(readFileSync(target, 'utf8'), original, 'the target keeps its original bytes');
});
