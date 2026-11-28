// Offline contract tests for the plugin wiring and its pure reducer. Nothing
// here opens a Discord pipe: a recording client replaces the factory and a
// fake clock/timer queue replaces the host clock, so the interval gate is
// proved by advancing time rather than by sleeping.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createState, applyEvent, selectSnapshot, revisionOf, splitModel } from '../src/state.mjs';
import { DEFAULT_LARGE_IMAGE } from '../src/index.js';
import { buildActivity } from '../src/presence.mjs';

const ENTRY = path.join(import.meta.dirname, '..', 'src', 'index.js');
let loads = 0;
const load = () => import(pathToFileURL(ENTRY).href + '?n=' + ++loads);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock(start) {
  let now = start;
  let nextID = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = nextID++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (;;) {
        let due = null;
        for (const [id, entry] of timers) {
          if (entry.at <= now && (!due || entry.at < due[1].at)) due = [id, entry];
        }
        if (!due) return;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
    pending: () => timers.size,
  };
}

function recorder() {
  const calls = [];
  return {
    calls,
    client: {
      calls,
      start() { calls.push({ method: 'start' }); },
      stop() { calls.push({ method: 'stop' }); return Promise.resolve(); },
      setActivity(activity) { calls.push({ method: 'setActivity', activity }); },
      clearActivity() { calls.push({ method: 'clearActivity' }); },
      state() { return { status: 'ready' }; },
    },
    sends: () => calls.filter((call) => call.method === 'setActivity').map((call) => call.activity),
    names: () => calls.map((call) => call.method),
  };
}

function waitAbort(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', resolve, { once: true });
  });
}

function scripted(events) {
  return ({ signal }) => (async function* () {
    for (const event of events) {
      if (signal.aborted) return;
      yield event;
    }
    await waitAbort(signal);
  })();
}

const ev = (type, data) => ({ type, data });
const created = (id, extra = {}) => ev('session.created', { sessionID: id, ...extra });
const selected = (id, model) => ev('session.model.selected', { sessionID: id, model });
const tool = (id) => ev('session.tool.called', { sessionID: id, name: 'read', input: {} });
const status = (id, kind) => ev('session.status', { sessionID: id, status: { type: kind } });

async function boot(subscribe, options = {}, start = 1795869962203, hostAppName = 'OpenCode', extraCtx = {}) {
  const mod = await load();
  const clock = fakeClock(start);
  const rec = recorder();
  mod.__setClock({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  mod.__setClientFactory(() => rec.client);
  const ctx = {
    options: { appId: '123456', trace: true, minIntervalMs: 0, ...options },
    app: { name: hostAppName, version: '1.0', channel: 'stable' },
    event: { subscribe: typeof subscribe === 'function' ? subscribe : scripted(subscribe) },
    ...extraCtx,
  };
  const cleanup = await mod.default.setup(ctx);
  await tick();
  return { mod, clock, rec, ctx, cleanup };
}

test('splitModel separates a string variant and keeps a bare model intact', () => {
  assert.deepEqual(splitModel('provider/model#high'), {
    model: 'provider/model', effort: 'high', id: 'provider/model', modelID: 'provider/model', providerID: undefined,
  });
  assert.deepEqual(splitModel('model'), {
    model: 'model', effort: undefined, id: 'model', modelID: 'model', providerID: undefined,
  });
  assert.deepEqual(splitModel(undefined), {
    model: undefined, effort: undefined, id: undefined, modelID: undefined, providerID: undefined,
  });
});

test('splitModel reads an object variant and keeps the raw catalogue fields', () => {
  assert.deepEqual(splitModel({ providerID: 'opencode-go', modelID: 'flash', variant: 'low' }), {
    model: 'opencode-go/flash', effort: 'low', id: undefined, modelID: 'flash', providerID: 'opencode-go',
  });
  assert.deepEqual(splitModel({ id: 'provider/model#max' }), {
    model: 'provider/model', effort: 'max', id: 'provider/model', modelID: 'provider/model', providerID: undefined,
  });
  assert.deepEqual(splitModel({ modelID: 'flash', effort: 'medium' }), {
    model: 'flash', effort: 'medium', id: undefined, modelID: 'flash', providerID: undefined,
  });
});

test('no app id leaves the plugin inert: no client, one log line, no-op cleanup', async () => {
  const saved = process.env.OC_DISCORD_APP_ID;
  delete process.env.OC_DISCORD_APP_ID;
  const mod = await load();
  mod.__setClock();
  let factoryCalls = 0;
  mod.__setClientFactory(() => { factoryCalls++; return recorder().client; });
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let cleanup;
  try {
    cleanup = await mod.default.setup({
      options: { trace: true },
      app: { name: 'OpenCode' },
      event: { subscribe: scripted([]) },
    });
  } finally {
    console.log = original;
    if (saved === undefined) delete process.env.OC_DISCORD_APP_ID;
    else process.env.OC_DISCORD_APP_ID = saved;
  }
  assert.equal(factoryCalls, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /OC_DISCORD_APP_ID/);
  assert.doesNotThrow(() => cleanup());
  assert.equal(logs.length, 1);
});

test('openedAt passes through untouched and the snapshot has exactly ten fields', async () => {
  const { rec, cleanup } = await boot([created('s1')]);
  const sends = rec.sends();
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].timestamps, { start: Math.floor(1795869962203 / 1000) });
  assert.equal(sends[0].name, 'OpenCode');
  assert.equal(sends[0].type, 0);
  assert.equal('details' in sends[0], false);
  assert.equal('state' in sends[0], false);
  const state = applyEvent(createState(), created('s1'), 7);
  const snapshot = selectSnapshot(state, { appName: 'OpenCode', openedAt: 123456789 });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'appName', 'effort', 'model', 'modelID', 'modelName', 'modelProviderID', 'modelRef',
    'openedAt', 'revision', 'sessions',
  ]);
  assert.equal(snapshot.openedAt, 123456789);
  assert.equal(snapshot.model, undefined);
  assert.equal(snapshot.effort, undefined);
  await cleanup();
});

test('a created record with a model shows details, and an explicit selection adds reasoning', async () => {
  const events = [
    created('s1', { model: { providerID: 'opencode-go', modelID: 'flash' } }),
    selected('s1', 'other/model#low'),
  ];
  const { rec, cleanup } = await boot(events);
  const sends = rec.sends();
  assert.equal(sends.length, 3);
  assert.equal(sends[0].details, undefined);
  assert.equal(sends[1].details, 'Coding with Flash');
  assert.equal(sends[1].state, undefined);
  assert.equal(sends[1].timestamps.start, Math.floor(1795869962203 / 1000));
  assert.equal(sends[2].details, 'Coding with Other Model');
  assert.equal(sends[2].state, 'Reasoning Low');
  await cleanup();
});

test('an object-shaped model produces details, state and large_text', async () => {
  const events = [created('s1'), selected('s1', { providerID: 'opencode-go', modelID: 'flash', variant: 'low' })];
  const { rec, cleanup } = await boot(events);
  const sends = rec.sends();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].details, 'Coding with Flash');
  assert.equal(sends[1].state, 'Reasoning Low');
  assert.equal(sends[1].name, 'OpenCode');
  assert.equal(sends[1].assets.large_text, 'opencode-go \u00b7 1.0');
  await cleanup();
});

test('large_text carries the host app version when one is supplied', async () => {
  const model = { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'high' };
  const { rec, cleanup } = await boot([created('s1', { model })], {}, undefined, 'OpenCode', {
    app: { name: 'OpenCode', version: '2.4.2' },
  });
  assert.equal(rec.sends().at(-1).assets.large_text, 'opencode-go \u00b7 2.4.2');
  await cleanup();
});

test('a child session never becomes current, so its model never reaches the card', async () => {
  const events = [
    created('s1', { title: 'parent' }),
    selected('s1', 'parent-model'),
    created('s2', { title: 'child', parentID: 's1' }),
    selected('s2', 'child-model'),
    status('s2', 'busy'),
  ];
  const { rec, cleanup } = await boot(events);
  assert.equal(rec.sends().length, 2);
  for (const activity of rec.sends()) {
    assert.doesNotMatch(JSON.stringify(activity), /child-model/);
  }
  assert.equal(rec.sends()[1].details, 'Coding with Parent Model');
  let state = applyEvent(createState(), created('s1'), 1);
  state = applyEvent(state, selected('s1', 'parent-model'), 2);
  state = applyEvent(state, created('s2', { parentID: 's1' }), 3);
  state = applyEvent(state, selected('s2', 'child-model'), 4);
  state = applyEvent(state, status('s2', 'busy'), 5);
  assert.equal(state.currentID, 's1');
  assert.equal(selectSnapshot(state).model, 'parent-model');
  await cleanup();
});

test('revision moves on a model change but not on a tool call', async () => {
  let state = applyEvent(createState(), created('s1'), 1);
  const before = revisionOf(state);
  for (let i = 0; i < 5; i++) state = applyEvent(state, tool('s1'), 2 + i);
  assert.equal(revisionOf(state), before, 'tool calls change nothing the card can show');
  state = applyEvent(state, selected('s1', 'first'), 8);
  assert.equal(revisionOf(state), before + 1);
  state = applyEvent(state, status('s1', 'busy'), 9);
  assert.equal(revisionOf(state), before + 1, 'busy is informational, not card state');
  state = applyEvent(state, selected('s1', 'second'), 10);
  assert.equal(revisionOf(state), before + 2);

  const { rec, cleanup } = await boot([
    created('s1'), selected('s1', 'first'), tool('s1'), tool('s1'), status('s1', 'busy'),
  ]);
  assert.equal(rec.sends().length, 2, 'tool and busy events publish no extra card');
  await cleanup();
});

test('a throw in the subscription restarts it instead of escaping setup', async () => {
  let calls = 0;
  const subscribe = ({ signal }) => (async function* () {
    const call = calls++;
    if (call === 0) throw new Error('subscription broke');
    yield selected('s1', 'after-restart');
    await waitAbort(signal);
  })();
  const { clock, rec, cleanup } = await boot(subscribe);
  assert.equal(rec.sends().length, 1, 'only the boot card before the restart delay');
  clock.advance(1000);
  await tick();
  assert.equal(calls, 2);
  assert.equal(rec.sends().length, 2);
  assert.equal(rec.sends()[1].details, 'Coding with After Restart');
  await cleanup();
});

test('cleanup aborts the loop, clears the card and stops the client', async () => {
  let seen;
  const subscribe = ({ signal }) => {
    seen = signal;
    return scripted([created('s1')])({ signal });
  };
  const { rec, cleanup, clock, mod } = await boot(subscribe);
  assert.equal(seen.aborted, false);
  await cleanup();
  assert.equal(seen.aborted, true);
  assert.equal(rec.names().at(-2), 'clearActivity');
  assert.equal(rec.names().at(-1), 'stop');
  clock.advance(1000);
  await tick();
  assert.equal(rec.sends().length, 1, 'no card after abort');
  assert.equal(mod.default.id, 'oc-discord-rpc');
});

test('a fresh install sends the pinned OpenCode mark as large_image', async () => {
  const { rec, cleanup } = await boot([created('s1')]);
  assert.equal(rec.sends()[0].assets.large_image, DEFAULT_LARGE_IMAGE);
  await cleanup();
});

test('an explicit empty largeImage opts out and sends no large_image at all', async () => {
  const { rec, cleanup } = await boot([created('s1')], { largeImage: '' });
  assert.equal('large_image' in rec.sends()[0].assets, false);
  await cleanup();
});

test('the host internal app name never changes the header name', async () => {
  const { rec, cleanup } = await boot([created('s1')], {}, undefined, 'opencode');
  assert.equal(rec.sends()[0].name, 'OpenCode');
  assert.equal('details' in rec.sends()[0], false);
  await cleanup();
});

test('the interval gate holds a second send until the injected clock passes it', async () => {
  const events = [created('s1'), selected('s1', 'first'), selected('s1', 'second')];
  const { clock, rec, cleanup } = await boot(events, { minIntervalMs: 5000 });
  assert.equal(rec.sends().length, 1);
  assert.equal(clock.pending(), 1, 'one timer, not one per event');
  clock.advance(4999);
  await tick();
  assert.equal(rec.sends().length, 1);
  clock.advance(1);
  await tick();
  const sends = rec.sends();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].details, 'Coding with Second', 'the latest pending model wins');
  await cleanup();
});

test('session.created alone now produces a details card', async () => {
  const { rec, cleanup } = await boot([created('s1', { model: 'plain/model' })]);
  const sends = rec.sends();
  assert.equal(sends.length, 2);
  assert.equal(sends[0].details, undefined);
  assert.equal(sends[1].details, 'Coding with Plain Model');
  assert.equal(sends[1].name, 'OpenCode');
  assert.equal(sends[1].type, 0);
  await cleanup();
});

test('boot sweep seeds a model from array, data and items session.list shapes', async () => {
  const model = { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash', variant: 'high' };
  const record = { id: 'ses_swept', model, time: { updated: 10 } };
  for (const listed of [[record], { data: [record] }, { items: [record] }]) {
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let booted;
    try {
      booted = await boot([], {}, undefined, 'OpenCode', { session: { list: async () => listed } });
    } finally {
      console.log = original;
    }
    assert.equal(booted.rec.sends()[0].details, 'Coding with DeepSeek V4.1 Flash');
    assert.equal(booted.rec.sends()[0].state, 'Reasoning High');
    assert.ok(logs.some((line) => line.includes('sweep seeded model from ses_swept')));
    await booted.cleanup();
  }
});

test('boot sweep ignores a child record and picks the newest non-child', async () => {
  const rows = [
    { id: 'ses_parent', model: 'parent-model', time: { updated: 1 } },
    { id: 'ses_child', parentID: 'ses_parent', model: 'child-model', time: { updated: 99 } },
  ];
  const { rec, cleanup } = await boot([], {}, undefined, 'OpenCode', {
    session: { list: async () => ({ data: rows }) },
  });
  assert.equal(rec.sends()[0].details, 'Coding with Parent Model');
  assert.doesNotMatch(JSON.stringify(rec.sends()[0]), /child-model/);
  await cleanup();
});

test('a throwing session.list does not break setup or stop the subscription', async () => {
  const { rec, cleanup } = await boot([selected('s1', 'after-sweep')], {}, undefined, 'OpenCode', {
    session: { list: async () => { throw new Error('list broke'); } },
  });
  assert.ok(rec.sends().some((activity) => activity.details === 'Coding with After Sweep'));
  await assert.doesNotReject(() => cleanup());
});

test('buildActivity picks the header name, never an app-name duplicate, and keeps type 0', () => {
  const { activity } = buildActivity({ appName: 'OpenCode', model: 'm', effort: 'e', openedAt: 1 });
  assert.equal(activity.name, 'OpenCode');
  assert.equal(activity.details, 'Coding with M');
  assert.equal(activity.state, 'Reasoning E');
  assert.equal(activity.type, 0);
  assert.equal(buildActivity({ model: 'm' }, { appName: 'Custom' }).activity.name, 'Custom');
  assert.equal(buildActivity({ model: 'm' }, { appName: '' }).activity, null);
});

test('a hung session.list cannot stall setup or the subscription', async (t) => {
  const mod = await load();
  mod.__setSweepTimeout(5);
  t.after(() => mod.__setSweepTimeout(undefined));
  const clock = fakeClock(1000);
  const rec = recorder();
  mod.__setClock({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  mod.__setClientFactory(() => rec.client);
  const ctx = {
    options: { appId: '123456', trace: true, minIntervalMs: 0 },
    app: { name: 'OpenCode' },
    session: { list: () => new Promise(() => {}) },
    event: { subscribe: scripted([selected('s1', 'fast')]) },
  };
  const started = Date.now();
  const pending = mod.default.setup(ctx);
  await tick();
  clock.advance(5);
  const cleanup = await pending;
  await tick();
  assert.ok(Date.now() - started < 300, 'setup must not wait on the host RPC');
  assert.ok(rec.sends().some((activity) => activity.details === 'Coding with Fast'), 'the subscription still delivers');
  await cleanup();
});

test('a hung model catalogue cannot stall the card and falls back to a readable name', async (t) => {
  const mod = await load();
  mod.__setCatalogTimeout(5);
  t.after(() => mod.__setCatalogTimeout(undefined));
  const clock = fakeClock(1000);
  const rec = recorder();
  mod.__setClock({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  mod.__setClientFactory(() => rec.client);
  const ctx = {
    options: { appId: '123456', minIntervalMs: 0 },
    app: { name: 'OpenCode' },
    model: { list: () => new Promise(() => {}) },
    event: { subscribe: scripted([created('s1', { model: 'deepseek-v4.1-flash' })]) },
  };
  const cleanup = await mod.default.setup(ctx);
  await tick();
  clock.advance(5);
  await tick();
  assert.ok(rec.sends().some((activity) => activity.details === 'Coding with DeepSeek V4.1 Flash'));
  await cleanup();
});

test('the catalogue display name wins on details and reasoning keeps its own line', async () => {
  const model = { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'high' };
  const { rec, cleanup } = await boot([created('s1', { model })], {}, undefined, 'OpenCode', {
    model: {
      list: async () => [{
        id: 'deepseek-v4.1-flash', modelID: 'deepseek-v4.1-flash', providerID: 'opencode-go',
        name: 'DeepSeek V4.1 Flash 1017', variants: [{ id: 'default' }, { id: 'high', name: 'High' }],
      }],
    },
  });
  const sends = rec.sends();
  assert.ok(sends.length >= 2);
  assert.equal(sends.at(-1).details, 'Coding with DeepSeek V4.1 Flash 1017');
  assert.equal(sends.at(-1).state, 'Reasoning High');
  assert.equal(sends.at(-1).name, 'OpenCode');
  assert.doesNotMatch(sends.at(-1).details, /\u00b7|High/);
  assert.doesNotMatch(JSON.stringify(sends.at(-1)), /deepseek-v4\.1-flash/);
  await cleanup();
});

test('one provider snapshot serves every model with a single RPC', async () => {
  const rows = [
    { id: 'm1', modelID: 'm1', providerID: 'opencode-go', name: 'Model One' },
    { id: 'm2', modelID: 'm2', providerID: 'opencode-go', name: 'Model Two' },
  ];
  let calls = 0;
  const p = pushable();
  const { rec, cleanup } = await boot([], {}, undefined, 'OpenCode', {
    model: { list: async () => { calls++; return rows; } },
    event: { subscribe: p.subscribe },
  });
  p.push(created('s1', { model: { id: 'm1', providerID: 'opencode-go' } }));
  await tick(); await tick(); await tick();
  assert.equal(rec.sends().at(-1).details, 'Coding with Model One');
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go', variant: 'high' }));
  await tick(); await tick(); await tick();
  assert.equal(rec.sends().at(-1).details, 'Coding with Model Two');
  assert.equal(calls, 1, 'one catalogue snapshot, not one RPC per model');
  await cleanup();
});

test('catalogue matching prefers modelID over id, inside the session providerID', async () => {
  const model = { id: 'shared-id', modelID: 'deepseek-v4.1-flash', providerID: 'opencode-go' };
  const rows = [
    { id: 'shared-id', modelID: 'other', providerID: 'opencode-go', name: 'Wrong One' },
    { id: 'wrong-id', modelID: 'deepseek-v4.1-flash', providerID: 'opencode-anthropic', name: 'Wrong Provider' },
    { id: 'other-id', modelID: 'deepseek-v4.1-flash', providerID: 'opencode-go', name: 'DeepSeek V4.1 Flash 1017' },
  ];
  const { rec, cleanup } = await boot([created('s1', { model })], {}, undefined, 'OpenCode', {
    model: { list: async () => rows },
  });
  assert.equal(rec.sends().at(-1).details, 'Coding with DeepSeek V4.1 Flash 1017');
  await cleanup();
});

test('a catalogue name that arrives late is picked up by a later send', async () => {
  let resolveList;
  const listed = new Promise((resolve) => { resolveList = resolve; });
  const model = { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'high' };
  const { rec, cleanup } = await boot([created('s1', { model })], {}, undefined, 'OpenCode', {
    model: { list: () => listed },
  });
  await tick();
  assert.equal(rec.sends().at(-1).details, 'Coding with DeepSeek V4.1 Flash');
  resolveList([{
    id: 'deepseek-v4.1-flash', modelID: 'deepseek-v4.1-flash', providerID: 'opencode-go',
    name: 'DeepSeek V4.1 Flash 1017',
  }]);
  await tick();
  await tick();
  await tick();
  assert.equal(rec.sends().at(-1).details, 'Coding with DeepSeek V4.1 Flash 1017');
  await cleanup();
});

test('sweep ignores another project and seeds the newest in-directory record', async () => {
  const rows = [
    { id: 'ses_other', model: 'other-model', location: { directory: 'Q:\\OTHER\\' }, time: { updated: 99 } },
    { id: 'ses_here', model: 'here-model', location: { directory: 'q:/work/project/' }, time: { updated: 1 } },
  ];
  let query;
  const { rec, cleanup } = await boot([], {}, undefined, 'OpenCode', {
    location: { directory: 'Q:\\work\\project\\' },
    session: { list: async (request) => { query = request; return { data: rows }; } },
  });
  assert.deepEqual(query, { directory: 'Q:\\work\\project\\', order: 'desc', limit: 50 });
  assert.equal(rec.sends()[0].details, 'Coding with Here Model');
  assert.doesNotMatch(JSON.stringify(rec.sends()[0]), /other-model/);
  await cleanup();
});

test('sweep still seeds with no ctx.location and calls list with an empty query', async () => {
  const rows = [{
    id: 'ses_no_location',
    model: 'no-location-model',
    location: { directory: '/somewhere/else' },
    time: { updated: 1 },
  }];
  let query;
  const { rec, cleanup } = await boot([], {}, undefined, 'OpenCode', {
    session: { list: async (request) => { query = request; return { data: rows }; } },
  });
  assert.deepEqual(query, {});
  assert.equal(rec.sends()[0].details, 'Coding with No Location Model');
  await cleanup();
});

test('the {data} session list shape seeds the model', async () => {
  const { rec, cleanup } = await boot([], {}, undefined, 'OpenCode', {
    session: {
      list: async () => ({ data: [{ id: 'ses_data', model: 'data-model', time: { updated: 1 } }] }),
    },
  });
  assert.equal(rec.sends()[0].details, 'Coding with Data Model');
  await cleanup();
});

// A subscribe generator that accepts events pushed by the test, so a second
// pump can be forced after a failed or stale catalogue fetch.
function pushable() {
  const queue = [];
  let wake;
  const subscribe = ({ signal }) => (async function* () {
    while (!signal.aborted) {
      if (queue.length) { yield queue.shift(); continue; }
      await new Promise((resolve) => {
        wake = resolve;
        signal.addEventListener('abort', resolve, { once: true });
      });
    }
  })();
  return {
    subscribe,
    push(event) {
      queue.push(event);
      if (wake) { const w = wake; wake = undefined; w(); }
    },
  };
}

async function bootSeams(seams, subscribe, options = {}, extraCtx = {}) {
  const mod = await load();
  if ('catalogTimeout' in seams) mod.__setCatalogTimeout(seams.catalogTimeout);
  if ('catalogTTL' in seams) mod.__setCatalogTTL(seams.catalogTTL);
  if ('catalogCooldown' in seams) mod.__setCatalogCooldown(seams.catalogCooldown);
  if ('sweepTimeout' in seams) mod.__setSweepTimeout(seams.sweepTimeout);
  if ('holdGrace' in seams) mod.__setHoldGrace(seams.holdGrace);
  const clock = fakeClock(1000);
  const rec = recorder();
  mod.__setClock({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  mod.__setClientFactory(() => rec.client);
  const ctx = {
    options: { appId: '123456', trace: true, minIntervalMs: 0, ...options },
    app: { name: 'OpenCode', version: '1.0' },
    event: { subscribe },
    ...extraCtx,
  };
  const cleanup = await mod.default.setup(ctx);
  await tick();
  return { mod, clock, rec, cleanup, ctx };
}

test('a failed catalogue fetch does not poison the name: a later fetch resolves it', async (t) => {
  const p = pushable();
  let calls = 0;
  const row = {
    id: 'deepseek-v4.1-flash', modelID: 'deepseek-v4.1-flash', providerID: 'opencode-go',
    name: 'DeepSeek V4.1 Flash 1017',
  };
  const { mod, rec, cleanup } = await bootSeams({ catalogCooldown: 0 }, p.subscribe, {}, {
    model: { list: async () => { calls++; if (calls === 1) throw new Error('network down'); return [row]; } },
  });
  t.after(() => mod.__setCatalogCooldown(undefined));
  p.push(created('s1', { model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick(); await tick();
  assert.equal(rec.sends().at(-1).details, 'Coding with DeepSeek V4.1 Flash');
  p.push(selected('s1', { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'max' }));
  await tick(); await tick(); await tick();
  assert.equal(calls, 2, 'the failure was not cached as the answer');
  assert.equal(rec.sends().at(-1).details, 'Coding with DeepSeek V4.1 Flash 1017');
  await cleanup();
});

test('TTL expiry triggers exactly one refresh', async (t) => {
  const p = pushable();
  let calls = 0;
  const row = { id: 'm', modelID: 'm', providerID: 'opencode-go', name: 'Model M' };
  const { mod, clock, rec, cleanup } = await bootSeams({ catalogTTL: 10 }, p.subscribe, {}, {
    model: { list: async () => { calls++; return [row]; } },
  });
  t.after(() => mod.__setCatalogTTL(undefined));
  const choice = (variant) => selected('s1', { id: 'm', providerID: 'opencode-go', variant });
  p.push(choice('high'));
  await tick(); await tick();
  assert.equal(calls, 1);
  clock.advance(11);
  p.push(choice('max'));
  await tick(); await tick();
  assert.equal(calls, 2, 'the expired snapshot refreshed once');
  p.push(choice('minimal'));
  await tick(); await tick();
  assert.equal(calls, 2, 'no second refresh inside the new TTL');
  await cleanup();
});

test('the miss cooldown prevents a refresh storm', async (t) => {
  const p = pushable();
  let calls = 0;
  const rows = [{ id: 'known', modelID: 'known', providerID: 'opencode-go', name: 'Known Model' }];
  const { mod, clock, cleanup } = await bootSeams({ catalogCooldown: 1000 }, p.subscribe, {}, {
    model: { list: async () => { calls++; return rows; } },
  });
  t.after(() => mod.__setCatalogCooldown(undefined));
  p.push(created('s1', { model: { id: 'known', providerID: 'opencode-go' } }));
  await tick(); await tick();
  assert.equal(calls, 1);
  clock.advance(1001);
  for (let i = 0; i < 5; i++) p.push(selected('s1', { id: 'unknown-' + i, providerID: 'opencode-go' }));
  await tick(); await tick(); await tick();
  assert.equal(calls, 2, 'five misses caused one refresh, not five');
  await cleanup();
});

test('the sweep retries an empty boot and stops once a model is seeded', async (t) => {
  let calls = 0;
  const model = { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'high' };
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  t.after(() => { console.log = original; });
  const booted = await boot([], {}, undefined, 'OpenCode', {
    session: { list: async () => { calls++; return calls === 1 ? [] : [{ id: 'ses_late', model, time: { updated: 5 } }]; } },
  });
  const { clock, rec, cleanup } = booted;
  assert.equal(rec.sends()[0].details, undefined, 'the boot card had no model');
  clock.advance(2000);
  await tick(); await tick(); await tick();
  assert.equal(calls, 2);
  assert.equal(rec.sends().at(-1).details, 'Coding with DeepSeek V4.1 Flash');
  assert.ok(logs.some((line) => line.includes('sweep retry 1 seeded ses_late')));
  clock.advance(400000);
  await tick();
  assert.equal(calls, 2, 'no retries after success');
  await cleanup();
});

test('sweep retries stop at the cap with no timer left armed', async (t) => {
  let calls = 0;
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  t.after(() => { console.log = original; });
  const booted = await boot([], {}, undefined, 'OpenCode', {
    session: { list: async () => { calls++; return []; } },
  });
  const { clock, cleanup } = booted;
  assert.equal(clock.pending(), 1, 'exactly one retry timer');
  for (const ms of [2000, 5000, 15000, 60000, 300000, 300000, 300000, 300000, 300000, 300000, 300000, 300000]) {
    clock.advance(ms);
    await tick(); await tick();
  }
  assert.equal(calls, 13, 'one setup sweep plus twelve retries');
  assert.equal(clock.pending(), 0, 'nothing armed after the cap');
  assert.ok(logs.some((line) => line.includes('sweep retries exhausted')));
  await cleanup();
});

test('a live model event cancels pending sweep retries', async () => {
  let calls = 0;
  const { clock, rec, cleanup } = await boot([selected('s1', 'live-model')], {}, undefined, 'OpenCode', {
    session: { list: async () => { calls++; return []; } },
  });
  assert.equal(rec.sends().at(-1).details, 'Coding with Live Model');
  clock.advance(400000);
  await tick();
  assert.equal(calls, 1, 'no retry after a live model event');
  await cleanup();
});

test('cleanup leaves no sweep retry timer armed', async () => {
  const { clock, cleanup } = await boot([], {}, undefined, 'OpenCode', {
    session: { list: async () => [] },
  });
  assert.equal(clock.pending(), 1);
  await cleanup();
  assert.equal(clock.pending(), 0);
});

test('a scoped sweep with no model retries unfiltered before giving up', async () => {
  const queries = [];
  const rows = [{ id: 'ses_unscoped', model: 'unscoped-model', location: { directory: 'D:/elsewhere' }, time: { updated: 5 } }];
  const { rec, cleanup } = await boot([], {}, undefined, 'OpenCode', {
    location: { directory: 'C:/Users/nathan' },
    session: { list: async (query) => { queries.push(query); return queries.length === 1 ? [] : rows; } },
  });
  assert.deepEqual(queries[0], { directory: 'C:/Users/nathan', order: 'desc', limit: 50 });
  assert.deepEqual(queries[1], {});
  assert.equal(rec.sends()[0].details, 'Coding with Unscoped Model');
  await cleanup();
});

// --- Sticky model: a transient cannot strip both card lines -----------------

test('a card with a model survives a burst of model-less session.created events', async (t) => {
  const p = pushable();
  t.after(() => { console.log = originalLog; });
  const originalLog = console.log;
  console.log = () => {};
  const { rec, cleanup } = await boot([], {}, undefined, 'OpenCode', { event: { subscribe: p.subscribe } });
  p.push(created('s1', { model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick(); await tick();
  const shown = rec.sends().at(-1);
  assert.equal(shown.details, 'Coding with DeepSeek V4.1 Flash');
  assert.equal(shown.state, 'Reasoning High');
  for (let i = 0; i < 6; i++) p.push(created('fresh-' + i));
  await tick(); await tick(); await tick();
  const after = rec.sends().at(-1);
  assert.equal(after.details, 'Coding with DeepSeek V4.1 Flash');
  assert.equal(after.state, 'Reasoning High');
  await cleanup();
});

test('a session revealed as a child falls back to the previous non-child, not a blank card', async (t) => {
  const p = pushable();
  const originalLog = console.log;
  console.log = () => {};
  t.after(() => { console.log = originalLog; });
  const { rec, cleanup } = await boot([], {}, undefined, 'OpenCode', { event: { subscribe: p.subscribe } });
  p.push(created('s0', { model: { id: 'main-model', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick();
  p.push(created('s1', { title: 'other', model: { id: 'second-model', providerID: 'opencode-go', variant: 'low' } }));
  await tick(); await tick();
  assert.equal(rec.sends().at(-1).details, 'Coding with Second Model');
  p.push(created('s1', {
    parentID: 's0', model: { id: 'child-model', providerID: 'opencode-go', variant: 'max' },
  }));
  await tick(); await tick(); await tick();
  const after = rec.sends().at(-1);
  assert.equal(after.details, 'Coding with Main Model');
  assert.equal(after.state, 'Reasoning High');
  assert.doesNotMatch(JSON.stringify(after), /child-model/);
  await cleanup();
});

test('a session reporting a different model wins over the remembered one', async (t) => {
  const p = pushable();
  const originalLog = console.log;
  console.log = () => {};
  t.after(() => { console.log = originalLog; });
  const { rec, cleanup } = await boot([], {}, undefined, 'OpenCode', { event: { subscribe: p.subscribe } });
  p.push(created('s0', { model: { id: 'first-model', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick();
  p.push(created('s1', { model: { id: 'second-model', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick();
  assert.equal(rec.sends().at(-1).details, 'Coding with Second Model');
  await cleanup();
});

test('a model change without a variant clears the previous effort', () => {
  let st = applyEvent(createState(), created('s1', {
    model: { id: 'm1', providerID: 'opencode-go', variant: 'high' },
  }), 1);
  assert.equal(selectSnapshot(st).effort, 'high');
  st = applyEvent(st, selected('s1', { id: 'm2', providerID: 'opencode-go' }), 2);
  assert.equal(selectSnapshot(st).model, 'm2');
  assert.equal(selectSnapshot(st).effort, undefined);
});

test('a genuinely empty state still produces the bare card', () => {
  const snapshot = selectSnapshot(createState(), { appName: 'OpenCode', openedAt: 1 });
  assert.equal(snapshot.model, undefined);
  assert.equal(snapshot.effort, undefined);
  const { activity } = buildActivity(snapshot, { appName: 'OpenCode' });
  assert.equal('details' in activity, false);
  assert.equal('state' in activity, false);
});

// --- Downgrade suppression: no reduced card on screen ----------------------

test('a reduced card is held and the previous payload stays current', async (t) => {
  const p = pushable();
  const { clock, rec, cleanup } = await bootSeams({ holdGrace: 5000 }, p.subscribe);
  p.push(created('s1', { model: { id: 'm1', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick();
  assert.equal(rec.sends().length, 2, 'boot card plus the full model card');
  assert.equal(rec.sends().at(-1).state, 'Reasoning High');
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go' }));
  await tick(); await tick(); await tick();
  assert.equal(rec.sends().length, 2, 'the reduced card was not published');
  assert.equal(rec.sends().at(-1).state, 'Reasoning High');
  assert.equal(clock.pending(), 1, 'one grace timer');
  await cleanup();
});

test('the hold publishes the reduced card once the grace elapses', async (t) => {
  const p = pushable();
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  t.after(() => { console.log = original; mod.__setHoldGrace(undefined); });
  const { mod, clock, rec, cleanup } = await bootSeams({ holdGrace: 5000 }, p.subscribe);
  p.push(created('s1', { model: { id: 'm1', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick();
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go' }));
  await tick(); await tick();
  assert.equal(rec.sends().length, 2);
  clock.advance(5000);
  await tick(); await tick();
  assert.equal(rec.sends().length, 3);
  assert.equal(rec.sends().at(-1).details, 'Coding with M2');
  assert.equal('state' in rec.sends().at(-1), false);
  assert.ok(logs.some((line) => line.includes('publish downgrade after grace')));
  await cleanup();
});

test('a field returning inside the grace cancels the hold with only one new send', async (t) => {
  const p = pushable();
  const { mod, clock, rec, cleanup } = await bootSeams({ holdGrace: 5000 }, p.subscribe);
  t.after(() => mod.__setHoldGrace(undefined));
  p.push(created('s1', { model: { id: 'm1', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick();
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go' }));
  await tick(); await tick();
  assert.equal(clock.pending(), 1);
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go', variant: 'high' }));
  await tick(); await tick(); await tick();
  assert.equal(rec.sends().length, 3, 'hold released, one full card sent');
  assert.equal(rec.sends().at(-1).state, 'Reasoning High');
  assert.equal(clock.pending(), 0, 'no hold timer left');
  await cleanup();
});

test('an upgrade during a hold publishes immediately', async (t) => {
  const p = pushable();
  const { mod, rec, cleanup } = await bootSeams({ holdGrace: 5000 }, p.subscribe);
  t.after(() => mod.__setHoldGrace(undefined));
  p.push(created('s1', { model: { id: 'm1', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick();
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go' }));
  await tick(); await tick();
  assert.equal(rec.sends().length, 2);
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go', variant: 'xhigh' }));
  await tick(); await tick(); await tick();
  assert.equal(rec.sends().length, 3);
  assert.equal(rec.sends().at(-1).state, 'Reasoning XHigh');
  await cleanup();
});

test('clear during a hold goes out immediately with no grace', async (t) => {
  const p = pushable();
  const { mod, clock, rec, cleanup } = await bootSeams({ holdGrace: 5000 }, p.subscribe);
  t.after(() => mod.__setHoldGrace(undefined));
  p.push(created('s1', { model: { id: 'm1', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick();
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go' }));
  await tick(); await tick();
  assert.equal(clock.pending(), 1);
  await cleanup();
  assert.equal(rec.names().at(-2), 'clearActivity');
  assert.equal(rec.names().at(-1), 'stop');
  assert.equal(clock.pending(), 0, 'no grace timer survived cleanup');
});

test('cleanup during a hold leaves nothing armed and publishes nothing further', async (t) => {
  const p = pushable();
  const { mod, clock, rec, cleanup } = await bootSeams({ holdGrace: 5000 }, p.subscribe);
  t.after(() => mod.__setHoldGrace(undefined));
  p.push(created('s1', { model: { id: 'm1', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick();
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go' }));
  await tick(); await tick();
  const sent = rec.sends().length;
  await cleanup();
  clock.advance(6000);
  await tick(); await tick();
  assert.equal(rec.sends().length, sent);
  assert.equal(clock.pending(), 0);
});

test('the interval gate still applies to an upgrade that follows a cancelled hold', async (t) => {
  const p = pushable();
  const { mod, clock, rec, cleanup } = await bootSeams(
    { holdGrace: 5000 }, p.subscribe, { minIntervalMs: 5000 },
  );
  t.after(() => mod.__setHoldGrace(undefined));
  p.push(created('s1', { model: { id: 'm1', providerID: 'opencode-go', variant: 'high' } }));
  await tick(); await tick();
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go' }));
  await tick(); await tick();
  assert.equal(rec.sends().length, 1);
  p.push(selected('s1', { id: 'm2', providerID: 'opencode-go', variant: 'high' }));
  await tick(); await tick(); await tick();
  assert.equal(rec.sends().length, 1, 'the gate holds the upgrade');
  assert.equal(clock.pending(), 1, 'only the gate timer remains');
  clock.advance(5000);
  await tick(); await tick();
  assert.equal(rec.sends().length, 2);
  assert.equal(clock.pending(), 0);
  await cleanup();
});
