// The dormant contract, proved before any other behaviour.
//
// On an isolated load with the shipped routing.json (mode: off), the plugin
// object must be loadable, setup must write exactly one line, the resolve hook
// must leave the event model untouched, and no command may change a model.
// Every other module is exercised through its own test file; this one is the
// acceptance proof for "loads, logs once, changes nothing".
import assert from 'node:assert/strict';
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
    'dispatch-doctor', 'dispatch-off', 'dispatch-refresh', 'dispatch-status',
  ]);
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
