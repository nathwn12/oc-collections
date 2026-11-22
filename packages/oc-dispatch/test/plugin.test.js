// The dormant contract, proved before any other behaviour.
//
// On an isolated load with the shipped routing.json (mode: off), the plugin
// object must be loadable, setup must write exactly one line, the resolve hook
// must leave the event model untouched, and no command may change a model.
// Every other module is exercised through its own test file; this one is the
// acceptance proof for "loads, logs once, changes nothing".
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ENTRY = path.join(import.meta.dirname, '..', 'src', 'index.js');

let loads = 0;
const load = () => import(pathToFileURL(ENTRY).href + '?n=' + ++loads);

const MODELS = [
  { providerID: 'p', id: 'cheap', name: 'Cheap', family: 'alpha', status: 'active', enabled: true, limit: { context: 200000 }, tools: true, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
  { providerID: 'p', id: 'dear', name: 'Dear', family: 'beta', status: 'active', enabled: true, limit: { context: 200000 }, tools: true, cost: [{ input: 3, output: 9, cache: { read: 1, write: 2 } }] },
];

function host(logs) {
  const hooks = [];
  const commands = [];
  const watched = [];
  const ctx = {
    model: { list: async () => ({ location: 'test', data: MODELS }) },
    session: { hook: async (name, cb) => { hooks.push({ name, cb }); } },
    command: { transform: async (fn) => fn({ add: (def) => commands.push(def) }) },
  };
  return { ctx, hooks, commands, watched, logs };
}

test('the shipped policy is dormant: the plugin loads, logs once and changes no model', async () => {
  const mod = await load();
  assert.equal(typeof mod.default.setup, 'function', 'the plugin object must load');
  assert.equal(typeof mod.setupDispatch, 'function', 'the test seam must exist');

  const logs = [];
  const { ctx, hooks, commands } = host(logs);
  const ctrl = await mod.setupDispatch(ctx, { log: (line) => logs.push(line), watchFn: () => ({ close() {} }) });

  assert.equal(ctrl.policy.mode, 'off', 'the shipped routing.json must be dormant');
  assert.equal(logs.length, 1, 'dormant load writes exactly one line: ' + JSON.stringify(logs));
  assert.match(logs[0], /mode=off/);

  const resolveHook = hooks.find((h) => h.name === 'experimental.model.resolve');
  assert.ok(resolveHook, 'the resolve hook must be registered');
  const event = { sessionID: 'ses_1', agent: 'build', kind: 'primary', model: { providerID: 'p', id: 'dear' } };
  const before = structuredClone(event.model);
  const decision = resolveHook.cb(event);
  assert.equal(decision, null, 'mode off returns no decision');
  assert.deepEqual(event.model, before, 'mode off never touches the model');

  assert.deepEqual(commands.map((c) => c.name).sort(), [
    'dispatch-doctor', 'dispatch-off', 'dispatch-refresh', 'dispatch-setup', 'dispatch-status',
  ]);
  ctrl.close();
});

test('dispatch-setup previews by default and writes through the setup seam with --yes', async () => {
  const mod = await load();
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-dispatch-setup-'));
  const target = path.join(dir, 'opencode.jsonc');
  const source = '{\n  // keep\n  "plugins": []\n}\n';
  writeFileSync(target, source);
  const env = { OPENCODE_CONFIG_DIR: dir, OPENCODE_DISABLE_PROJECT_CONFIG: '1' };
  const logs = [];
  const { ctx, commands } = host(logs);
  const ctrl = await mod.setupDispatch(ctx, {
    env, log: (line) => logs.push(line), watchFn: () => ({ close() {} }),
  });
  const cmd = commands.find((c) => c.name === 'dispatch-setup');
  assert.ok(cmd, 'dispatch-setup must be registered');

  const preview = await cmd.execute();
  assert.equal(preview.applied, false);
  assert.equal(readFileSync(target, 'utf8'), source, 'preview never writes');

  const applied = await cmd.execute('--yes');
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.match(readFileSync(target, 'utf8'), /oc-dispatch/, 'apply writes the plugin entry');
  ctrl.close();
});

test('setup degrades to less plugin when the host lacks model, hook, command and storage', async () => {
  const mod = await load();
  await assert.doesNotReject(() => mod.default.setup(undefined));
  await assert.doesNotReject(() => mod.default.setup({}));
  const logs = [];
  const ctrl = await mod.setupDispatch({}, { log: (line) => logs.push(line), read: () => { throw new Error('no file'); } });
  assert.equal(ctrl.policy.mode, 'off');
  assert.equal(ctrl.models.length, 0);
  assert.equal(ctrl.grades.get('p/dear#primary').samples, 0, 'an absent storage falls back to memory');
  ctrl.close();
});

test('a bad routing.json, absent hook and absent command domain still load', async () => {
  const mod = await load();
  const logs = [];
  const ctx = {
    model: { list: async () => ({ location: 'test', data: MODELS }) },
    session: {},
    command: {},
  };
  const ctrl = await mod.setupDispatch(ctx, {
    log: (line) => logs.push(line),
    read: () => '{bad json',
    watchFn: () => ({ close() {} }),
  });
  assert.equal(ctrl.policy.mode, 'off', 'a bad file falls back to the dormant default');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /problem=routing\.json/);
  const event = { sessionID: 'ses_2', agent: 'build', kind: 'primary', model: { providerID: 'p', id: 'dear' } };
  assert.equal(ctrl.resolver.resolve(event), null);
  assert.deepEqual(event.model, { providerID: 'p', id: 'dear' });
  ctrl.close();
});

test('the routing.json watcher reloads a changed policy', async () => {
  const mod = await load();
  const logs = [];
  let text = JSON.stringify({ mode: 'off' });
  let notify;
  const { ctx } = host(logs);
  const ctrl = await mod.setupDispatch(ctx, {
    log: (line) => logs.push(line),
    read: () => text,
    watchFn: (_path, cb) => {
      notify = cb;
      return { close() {} };
    },
  });
  assert.equal(ctrl.policy.mode, 'off');
  text = JSON.stringify({ mode: 'shadow' });
  notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctrl.policy.mode, 'shadow');
  assert.equal(ctrl.resolver.status().mode, 'shadow');
  ctrl.close();
});

test('the resolve hook prices candidates at the tier context ceiling', async () => {
  const mod = await load();
  const logs = [];
  const { ctx, hooks } = host(logs);
  const bump = {
    providerID: 'p', id: 'bump', name: 'Bump', family: 'alpha', status: 'active', enabled: true,
    limit: { context: 200000 }, tools: true,
    cost: [{ input: 0, output: 0, size: 32768 }, { input: 0.5, output: 0.5, size: 131072 }],
  };
  const steady = {
    providerID: 'p', id: 'steady', name: 'Steady', family: 'beta', status: 'active', enabled: true,
    limit: { context: 100000 }, tools: true,
    cost: [{ input: 0, output: 0, size: 32768 }, { input: 0.1, output: 0.1, size: 131072 }],
  };
  ctx.model.list = async () => ({ location: 'test', data: [bump, steady] });
  const ctrl = await mod.setupDispatch(ctx, {
    log: (line) => logs.push(line),
    append: () => {},
    read: () => JSON.stringify({ mode: 'enforce', confidentiality: { freeForCode: true } }),
    watchFn: () => ({ close() {} }),
  });
  const resolveHook = hooks.find((h) => h.name === 'experimental.model.resolve');
  assert.ok(resolveHook, 'the resolve hook must be registered');
  const event = { sessionID: 'ses_rank', agent: 'build', kind: 'primary', model: { providerID: 'p', id: 'dear' } };
  const decision = resolveHook.cb(event);
  assert.equal(decision.model, 'p/steady', 'ranking uses the tier ceiling, not the first price row');
  assert.equal(event.model.id, 'steady');
  ctrl.close();
});

test('the resolve hook refreshes the catalog once caps.catalogTTLMs passes', async () => {
  const mod = await load();
  const logs = [];
  let now = 1000;
  let data = MODELS;
  const { ctx, hooks } = host(logs);
  ctx.model.list = async () => ({ location: 'test', data });
  const ctrl = await mod.setupDispatch(ctx, {
    log: (line) => logs.push(line),
    append: () => {},
    read: () => JSON.stringify({ mode: 'enforce', caps: { catalogTTLMs: 100 } }),
    now: () => now,
    watchFn: () => ({ close() {} }),
  });
  const resolveHook = hooks.find((h) => h.name === 'experimental.model.resolve');
  assert.ok(resolveHook, 'the resolve hook must be registered');
  const event = { sessionID: 'ses_ttl', agent: 'build', kind: 'primary', model: { providerID: 'p', id: 'dear' } };
  assert.equal(ctrl.models.some((m) => m.modelID === 'fresh'), false, 'the snapshot starts unchanged');
  assert.equal(ctrl.resolver.status().models, MODELS.length, 'the resolver snapshot starts unchanged');

  now = 1200;
  data = [{
    providerID: 'p', id: 'fresh', name: 'Fresh', family: 'gamma', status: 'active', enabled: true,
    limit: { context: 200000 }, tools: true, cost: [{ input: 0, output: 0 }],
  }];
  resolveHook.cb(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ctrl.models.some((m) => m.modelID === 'fresh'), 'the live hook refreshed the catalog after the TTL');
  assert.equal(ctrl.resolver.status().models, 1, 'the resolver adopts the same refreshed snapshot');
  ctrl.close();
});

test('a refresh persists the catalog cache file the CLI reads', async () => {
  const mod = await load();
  const logs = [];
  const writes = [];
  const { ctx } = host(logs);
  const ctrl = await mod.setupDispatch(ctx, {
    log: (line) => logs.push(line),
    append: () => {},
    write: (p, data) => writes.push([p, data]),
    read: () => JSON.stringify({
      mode: 'enforce',
      caps: { catalogTTLMs: 100, catalogCachePath: '/tmp/oc-dispatch-catalog.json' },
    }),
    now: () => 1000,
    watchFn: () => ({ close() {} }),
  });

  assert.deepEqual(writes, [], 'load alone does not write a cache file');
  const status = await ctrl.refresh();
  assert.equal(status.mode, 'enforce');
  assert.equal(writes.length, 1, 'a successful refresh writes once');
  assert.equal(writes[0][0], '/tmp/oc-dispatch-catalog.json');
  const snapshot = JSON.parse(writes[0][1]);
  assert.equal(snapshot.at, 1000);
  assert.deepEqual(snapshot.models.map((m) => m.modelID), MODELS.map((m) => m.id));
  ctrl.close();
});

test('mode off performs no catalog load from the resolve hook', async () => {
  const mod = await load();
  const logs = [];
  let now = 1000;
  let calls = 0;
  const { ctx, hooks } = host(logs);
  ctx.model.list = async () => {
    calls += 1;
    return { location: 'test', data: MODELS };
  };
  const ctrl = await mod.setupDispatch(ctx, {
    log: (line) => logs.push(line),
    append: () => {},
    read: () => JSON.stringify({ mode: 'off', caps: { catalogTTLMs: 10 } }),
    now: () => now,
    watchFn: () => ({ close() {} }),
  });
  const afterLoad = calls;
  const resolveHook = hooks.find((h) => h.name === 'experimental.model.resolve');
  assert.ok(resolveHook, 'the resolve hook must be registered');

  now = 2000; // well past the TTL: an enabled resolver would refresh here
  const event = { sessionID: 'ses_off', agent: 'build', kind: 'primary', model: { providerID: 'p', id: 'dear' } };
  assert.equal(resolveHook.cb(event), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, afterLoad, 'mode off never calls ctx.model.list() from the hook');
  assert.equal(ctrl.resolver.status().mode, 'off');
  ctrl.close();
});
