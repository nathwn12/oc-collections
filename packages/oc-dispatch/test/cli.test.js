// The CLI is pure: every verb works from files and injected IO, with no server.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main, offPolicy } from '../bin/oc-dispatch.mjs';

const INSTALL = 'github:nathwn12/oc-collections#main::path:packages/oc-dispatch';
const BIN = path.join(import.meta.dirname, '..', 'bin', 'oc-dispatch.mjs');
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

test('status prints the catalog cache age from the cache file mtime', async () => {
  const result = await main(['status'], {
    read: () => ROUTING,
    stat: () => ({ mtimeMs: 1000 }),
    now: () => 46000,
    env: {},
  });
  assert.equal(result.code, 0);
  assert.equal(result.data.catalogCacheAge, '45s');
  assert.match(result.text, /^catalog cache age: 45s$/m);
});

test('status reports no catalog cache age when no cache is configured', async () => {
  const routing = JSON.parse(ROUTING);
  delete routing.caps.catalogCachePath;
  const result = await main(['status'], { read: () => JSON.stringify(routing), env: {} });
  assert.equal(result.code, 0);
  assert.match(result.text, /^catalog cache age: none$/m);
});

test('status reads the real cache file and reports none once it is deleted', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-cache-'));
  const cache = path.join(dir, 'catalog.json');
  const routing = JSON.parse(ROUTING);
  routing.caps.catalogCachePath = cache;
  writeFileSync(cache, JSON.stringify({ at: 1000, models: [] }));
  const mtime = statSync(cache).mtimeMs;

  const result = await main(['status'], {
    read: () => JSON.stringify(routing),
    env: {},
    now: () => mtime + 45000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.data.catalogCacheAge, '45s');
  assert.match(result.text, /^catalog cache age: 45s$/m);

  unlinkSync(cache);
  const gone = await main(['status'], { read: () => JSON.stringify(routing), env: {} });
  assert.equal(gone.code, 0);
  assert.equal(gone.data.catalogCacheAge, 'none');
  assert.match(gone.text, /^catalog cache age: none$/m);
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

test('doctor --check stays supported and passes on a valid policy', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-check-'));
  writeFileSync(path.join(dir, 'opencode.jsonc'), '{ "experimental": { "subagent_depth": 2 } }');
  const result = await main(['doctor', '--check'], {
    env: { OPENCODE_CONFIG_DIR: dir },
    read: readFileSync,
    banked: [],
  });
  assert.equal(result.code, 0, result.error);
});

test('doctor --fix is rejected with a non-zero exit and an unsupported-flag error', async () => {
  const result = await main(['doctor', '--fix'], { read: () => ROUTING, env: {} });
  assert.equal(result.code, 2);
  assert.equal(result.data.unsupported, '--fix');
  assert.match(result.error, /^doctor: unsupported flag: --fix$/m);
});

test('doctor --yes is rejected with a non-zero exit and an unsupported-flag error', async () => {
  const result = await main(['doctor', '--yes'], { read: () => ROUTING, env: {} });
  assert.equal(result.code, 2);
  assert.equal(result.data.unsupported, '--yes');
  assert.match(result.error, /^doctor: unsupported flag: --yes$/m);
});

test('the bin runs status as a subprocess and prints a status line', () => {
  const run = spawnSync(process.execPath, [BIN, 'status'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^mode: /m);
  assert.match(run.stdout, /^catalog cache age: /m);
});

test('the bin writes the doctor unsupported-flag error to stderr', () => {
  const run = spawnSync(process.execPath, [BIN, 'doctor', '--fix'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^doctor: unsupported flag: --fix$/m);
});
