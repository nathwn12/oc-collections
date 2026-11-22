// The CLI is pure: every verb works from files and injected IO, with no server.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main, offPolicy } from '../bin/oc-dispatch.mjs';

const INSTALL = 'github:nathwn12/oc-collections#main::path:packages/oc-dispatch';
const ROUTING = JSON.stringify({
  version: 1,
  mode: 'enforce',
  confidentiality: { freeForCode: false, freeForCodeProviders: [] },
  caps: { defaultContext: 32768, maxSpendUsd: 5, spendPerTaskUsd: 0.05, catalogTTLMs: 30000, catalogCachePath: '/tmp/cache.json' },
});

test('status reports mode, tiers, banked models and the catalog cache path', async () => {
  const result = await main(['status'], {
    read: () => ROUTING,
    banked: ['p/dear#primary'],
    env: {},
  });
  assert.equal(result.code, 0);
  assert.equal(result.data.mode, 'enforce');
  assert.deepEqual(result.data.tiers, ['fast', 'medium', 'verify', 'heavy']);
  assert.deepEqual(result.data.banked, ['p/dear#primary']);
  assert.equal(result.data.catalogCachePath, '/tmp/cache.json');
  assert.match(result.text, /mode: enforce/);
  assert.match(result.text, /fast, medium, verify, heavy/);
});

test('off is a validated, reversible text edit of routing.json', () => {
  const changed = offPolicy(ROUTING);
  assert.equal(changed.ok, true);
  assert.equal(JSON.parse(changed.text).mode, 'off');
  assert.equal(JSON.parse(ROUTING).mode, 'enforce', 'the input is not mutated');
  assert.equal(offPolicy('{bad').ok, false);
});

test('the off verb writes mode off with a backup', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-'));
  const target = path.join(dir, 'routing.json');
  writeFileSync(target, ROUTING);
  const result = await main(['off'], { routingPath: target, env: {} });
  assert.equal(result.code, 0, result.text);
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).mode, 'off');
  assert.equal(readFileSync(target + '.bak', 'utf8'), ROUTING);
});

test('init previews by default, prints on --dry-run and writes only with --yes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-'));
  const target = path.join(dir, 'opencode.jsonc');
  const source = '{\n  // keep\n  "plugins": []\n}\n';
  writeFileSync(target, source);
  const deps = { configPath: target, env: { OPENCODE_CONFIG_DIR: dir }, banked: [] };

  const plain = await main(['init'], deps);
  assert.equal(plain.code, 0);
  assert.match(plain.text, new RegExp(INSTALL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(plain.text, /not applied/);
  assert.equal(readFileSync(target, 'utf8'), source, 'no write without --yes');

  const dry = await main(['init', '--dry-run'], deps);
  assert.equal(dry.code, 0);
  assert.match(dry.text, /dry run/);
  assert.equal(readFileSync(target, 'utf8'), source);

  const yes = await main(['init', '--yes'], deps);
  assert.equal(yes.code, 0, yes.text);
  assert.match(readFileSync(target, 'utf8'), /keep/);
  assert.match(readFileSync(target, 'utf8'), new RegExp(INSTALL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('doctor reports config precedence and the winning depth', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-'));
  const cfg = path.join(dir, 'opencode.jsonc');
  writeFileSync(cfg, '{ // global\n "experimental": { "subagent_depth": 3 } }');
  const env = { OPENCODE_CONFIG_DIR: dir };
  const result = await main(['doctor'], { env, read: (p) => readFileSync(p, 'utf8'), banked: [] });
  assert.equal(result.code, 0);
  assert.equal(result.data.effectiveDepth, 3);
  assert.ok(result.data.sources.includes('global'));
  assert.match(result.text, /winner: global/);
  assert.match(result.text, /depth: 3/);

  const bad = await main(['doctor', '--check'], {
    env,
    read: () => '{bad',
    banked: [],
  });
  assert.equal(bad.code, 1, 'a bad policy or absent depth fails --check');
});
