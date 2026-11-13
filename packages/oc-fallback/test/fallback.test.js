// Offline contract tests for oc-fallback.
//
// Two halves, and they are the whole package: the configuration it reads, and
// the one tool plus one automatic behaviour it exposes. Everything the host can
// break without a server is proved here against a fake ctx that records every
// `switchModel` call, so the switch itself is asserted rather than assumed.
//
// Nothing reaches the network or a real catalog: the model list is a fixture,
// and the benchmark check is a fake that answers bencharked / zero / unknown on
// command. The one live round trip is the owner's proof run, not this suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { DEFAULTS, configPath, killSwitch, loadConfig, normalize, readLadders, splitModel } from '../src/config.mjs';
import { createCatalog, modelSlug, sitemapIndex } from '../src/benchmarks.mjs';
import { formatLine, makeLog } from '../src/log.mjs';
import { createFallback, createRouter } from '../src/ladder.mjs';

const PROVIDER = 'opencode-go';

// The shape this machine's oc-superpowers/harness.json actually carries: the
// ladders live there, and this package only ever reads them.
const HARNESS = {
  models: { lead: null },
  fallbacks: {
    lead: [
      'opencode-go/deepseek-v4.1-flash',
      'opencode-go/glm-5.3-flash',
      'opencode-go/mimo-v2.6-flash',
      'opencode-go/muse-spark-1.3-contributor',
    ],
    scout: ['opencode-go/muse-spark-1.3-contributor', 'opencode-go/muse-spark-1.2-contributor'],
  },
};

const LADDERS = HARNESS.fallbacks;

const read = (text) => () => text;
const missing = () => {
  const error = new Error('ENOENT: no such file or directory');
  error.code = 'ENOENT';
  throw error;
};

const RULES = DEFAULTS.rules;

// A config shaped exactly like the file contract, with no benchmark check and
// no price caps unless a test asks for them: the rules under test are explicit.
function config(over = {}) {
  return normalize({
    ...DEFAULTS,
    ladders: LADDERS,
    rules: { ...RULES, requirePublishedBenchmark: false, ...over.rules },
    ...over,
  });
}

// Every rule the package enforces, driven by a fixture: `state` is what the
// benchmark check answers, so one test can flip a rung between advertised and
// benchmark-less without a network.
const CATALOG = [
  { providerID: PROVIDER, id: 'deepseek-v4.1-flash', cost: [{ input: 0.15, output: 0.6 }] },
  { providerID: PROVIDER, id: 'glm-5.3-flash', cost: [{ input: 0.15, output: 0.5 }] },
  { providerID: PROVIDER, id: 'mimo-v2.6-flash', cost: [{ input: 0.14, output: 0.28 }] },
  { providerID: PROVIDER, id: 'muse-spark-1.3-contributor', cost: [{ input: 0.1, output: 0.2 }] },
  { providerID: PROVIDER, id: 'muse-spark-1.2-contributor', cost: [{ input: 0.1, output: 0.2 }] },
  { providerID: PROVIDER, id: 'longcat-2.5-free', cost: [{ input: 0, output: 0 }] },
  { providerID: PROVIDER, id: 'minimax-m3.1-flash', cost: [{ input: 3, output: 9 }] },
  { providerID: 'anthropic', id: 'claude-sonnet-5-5', cost: [{ input: 3, output: 15 }] },
];

// A ctx shaped like this build's plugin context, recording every call.
// `envelope` picks the catalog shape: this build answers `{ location, data }`,
// the docs promise a bare array, and a broken plugin passes one of them.
function fakeCtx({ models = CATALOG, envelope = 'data', onSwitch } = {}) {
  const calls = { switchModel: [], list: 0, hooks: [], tools: [], namespace: null };
  const ctx = {
    session: {
      switchModel: async (input) => {
        calls.switchModel.push(input);
        if (onSwitch) await onSwitch(input);
      },
      hook: async (name, callback) => {
        calls.hooks.push({ name, callback });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback) => {
        const editor = {
          namespace: (ns) => {
            calls.namespace = ns;
          },
          add: (tool) => {
            calls.tools.push(tool);
          },
        };
        callback(editor);
        return { dispose: async () => {} };
      },
    },
    model: {
      list: async () => {
        calls.list += 1;
        if (envelope === 'array') return models;
        if (envelope === 'data') return { location: {}, data: models };
        return { unexpected: true };
      },
    },
  };
  return { calls, ctx };
}

const benchmark = (state = 'benchmarked') => async (modelID) => ({
  state: typeof state === 'function' ? state(modelID) : state,
  count: state === 'zero' ? 0 : 12,
  url: `https://opencode.ai/data/x/${modelSlug(splitModel(modelID).id)}.json`,
});

const silent = () => {};

async function routerAt({ model = 'opencode-go/deepseek-v4.1-flash', agent = 'lead', ladders = LADDERS, rules, fake = fakeCtx(), cfg } = {}) {
  const router = createRouter({
    config: cfg ?? config(rules ? { rules } : {}),
    ladders,
    ctx: fake.ctx,
    log: silent,
    benchmark: benchmark(),
  });
  const ref = splitModel(model);
  await router.resolve({ sessionID: 'ses_1', agent, model: { providerID: ref.providerID, id: ref.id }, kind: 'primary' });
  return { router, ...fake };
}

// --- the configuration file ----------------------------------------------

test('a missing config file falls back to the built-in defaults and says so once', () => {
  const { config: loaded, source, problem } = loadConfig({ env: {}, read: missing });
  assert.equal(source, 'default');
  assert.equal(problem, 'config-unreadable');
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.provider, PROVIDER);
  assert.deepEqual(loaded.ladders, {});
});

test('an invalid config file falls back to the defaults instead of throwing', () => {
  const { config: loaded, source, problem } = loadConfig({ env: {}, read: read('{ not json') });
  assert.equal(source, 'default');
  assert.equal(problem, 'config-unreadable');
  assert.deepEqual(loaded.rules, DEFAULTS.rules);
});

test('a valid config file is read and reported as the file source', () => {
  const text = JSON.stringify({ enabled: true, provider: 'anthropic', ladders: { lead: ['anthropic/x'] } });
  const { config: loaded, source, problem } = loadConfig({ env: {}, read: read(text) });
  assert.equal(source, 'file');
  assert.equal(problem, null);
  assert.equal(loaded.provider, 'anthropic');
  assert.deepEqual(loaded.ladders, { lead: ['anthropic/x'] });
});

test('the config path prefers OC_FALLBACK_CONFIG', () => {
  assert.equal(configPath({ OC_FALLBACK_CONFIG: 'D:/x.json' }, '/home/u'), 'D:/x.json');
  assert.equal(configPath({}, '/home/u').endsWith(path.join('.config', 'opencode', 'oc-fallback.json')), true);
});

test('the default log path is oc-fallback.log under the opencode log directory', () => {
  assert.equal(DEFAULTS.logPath.endsWith(path.join('log', 'oc-fallback.log')), true);
});

test('the kill switch is off only on an explicit OC_FALLBACK=off', () => {
  assert.equal(killSwitch({}), false);
  assert.equal(killSwitch({ OC_FALLBACK: 'off' }), true);
  assert.equal(killSwitch({ OC_FALLBACK: 'OFF' }), true);
  assert.equal(killSwitch({ OC_FALLBACK: 'on' }), false);
});

test('a config with enabled:false disables the plugin', () => {
  assert.equal(normalize({ ...DEFAULTS, enabled: false }).enabled, false);
});

test('normalize coerces junk instead of throwing', () => {
  assert.equal(normalize(null).provider, PROVIDER);
  assert.equal(normalize({ rules: 'nope' }).rules.autoFailover, DEFAULTS.rules.autoFailover);
  assert.equal(normalize({ rules: { maxInputUsd: 'cheap' } }).rules.maxInputUsd, DEFAULTS.rules.maxInputUsd);
  assert.equal(normalize({ rules: { excludeFree: false } }).rules.excludeFree, false);
});

// --- the ladders, inline and by pointer -----------------------------------

test('inline ladders are read from the config file itself', () => {
  const { ladders, problem } = readLadders(LADDERS, { read: missing });
  assert.deepEqual(ladders, LADDERS);
  assert.equal(problem, null);
});

test('pointer ladders are read from the external file under the named key', () => {
  const spec = { file: 'Q:\\harness.json', key: 'fallbacks' };
  const { ladders, problem, source } = readLadders(spec, { read: read(JSON.stringify(HARNESS)) });
  assert.deepEqual(ladders, LADDERS);
  assert.equal(problem, null);
  assert.equal(source, 'Q:\\harness.json');
});

test('a pointer with no key reads fallbacks, and never writes the file back', () => {
  const writes = [];
  const spec = { file: 'Q:\\harness.json' };
  const { ladders } = readLadders(spec, {
    read: read(JSON.stringify(HARNESS)),
    write: (file, text) => writes.push([file, text]),
  });
  assert.deepEqual(ladders, LADDERS);
  assert.deepEqual(writes, []);
});

test('a missing pointer file fails open to no ladders', () => {
  const { ladders, problem } = readLadders({ file: 'Q:\\gone.json' }, { read: missing });
  assert.deepEqual(ladders, {});
  assert.equal(problem, 'ladders-unreadable');
});

test('a pointer key that is absent fails open to no ladders', () => {
  const { ladders, problem } = readLadders({ file: 'Q:\\h.json', key: 'nope' }, { read: read(JSON.stringify(HARNESS)) });
  assert.deepEqual(ladders, {});
  assert.equal(problem, 'ladders-missing');
});

test('a ladder keeps only usable string rungs and drops an empty seat', () => {
  const inline = { lead: ['opencode-go/a', 7, '', null, 'opencode-go/b'], scout: [1, ''] };
  assert.deepEqual(readLadders(inline).ladders, { lead: ['opencode-go/a', 'opencode-go/b'] });
});

test('splitModel splits on the first slash only and rejects a half id', () => {
  assert.deepEqual(splitModel('opencode-go/vendor/x'), { providerID: 'opencode-go', id: 'vendor/x' });
  assert.equal(splitModel('opencode-go'), null);
  assert.equal(splitModel('opencode-go/'), null);
  assert.equal(splitModel(null), null);
});

// --- the tool contract ----------------------------------------------------

test('list reports the ladder, rung and current model and changes nothing', async () => {
  const { router, calls } = await routerAt();
  const out = await router.switchModel({ list: true }, { sessionID: 'ses_1' });
  assert.deepEqual(Object.keys(out).sort(), ['agent', 'current', 'ladder', 'model', 'ok', 'rung']);
  assert.equal(out.ok, true);
  assert.equal(out.agent, 'lead');
  assert.equal(out.rung, 0);
  assert.equal(out.current, 'opencode-go/deepseek-v4.1-flash');
  assert.deepEqual(out.ladder, LADDERS.lead);
  assert.equal(calls.switchModel.length, 0);
});

test('no input steps down one rung, and the switch call is the one the host received', async () => {
  const { router, calls } = await routerAt();
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.ok, true);
  assert.equal(out.rung, 1);
  assert.equal(out.model, 'opencode-go/glm-5.3-flash');
  assert.deepEqual(calls.switchModel, [
    { sessionID: 'ses_1', model: { providerID: PROVIDER, id: 'glm-5.3-flash' } },
  ]);
});

test('a second step continues down the ladder', async () => {
  const { router, calls } = await routerAt();
  await router.switchModel({}, { sessionID: 'ses_1' });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.rung, 2);
  assert.deepEqual(calls.switchModel[1], {
    sessionID: 'ses_1',
    model: { providerID: PROVIDER, id: 'mimo-v2.6-flash' },
  });
});

test('rung jumps to an absolute rung', async () => {
  const { router, calls } = await routerAt();
  const out = await router.switchModel({ rung: 2 }, { sessionID: 'ses_1' });
  assert.equal(out.rung, 2);
  assert.equal(calls.switchModel[0].model.id, 'mimo-v2.6-flash');
});

test('an explicit model on the ladder is switched to', async () => {
  const { router, calls } = await routerAt();
  const out = await router.switchModel({ model: 'opencode-go/muse-spark-1.3-contributor' }, { sessionID: 'ses_1' });
  assert.equal(out.rung, 3);
  assert.equal(calls.switchModel[0].model.id, 'muse-spark-1.3-contributor');
});

test('a model off the ladder is not-on-ladder and switches nothing', async () => {
  const { router, calls } = await routerAt();
  const out = await router.switchModel({ model: 'anthropic/claude-sonnet-5-5' }, { sessionID: 'ses_1' });
  assert.equal(out.error, 'not-on-ladder');
  assert.equal(calls.switchModel.length, 0);
});

test('a rung out of range is not-on-ladder', async () => {
  const { router } = await routerAt();
  for (const rung of [9, -1, 1.5]) {
    assert.equal((await router.switchModel({ rung }, { sessionID: 'ses_1' })).error, 'not-on-ladder');
  }
});

test('already on the last rung is at-floor', async () => {
  const { router, calls } = await routerAt({ agent: 'scout', model: 'opencode-go/muse-spark-1.2-contributor' });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.error, 'at-floor');
  assert.equal(calls.switchModel.length, 0);
});

test('a rung absent from the live catalog is not-available', async () => {
  const fake = fakeCtx({ models: [CATALOG[0]] });
  const { router } = await routerAt({ fake });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.error, 'not-available');
  assert.equal(fake.calls.switchModel.length, 0);
});

test('a session on another provider is cross-provider and untouched', async () => {
  const fake = fakeCtx();
  const router = createRouter({ config: config(), ladders: LADDERS, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.error, 'cross-provider');
  assert.equal(fake.calls.switchModel.length, 0);
});

test('a ladder rung on a foreign provider is refused as cross-provider', async () => {
  const ladders = { lead: ['opencode-go/deepseek-v4.1-flash', 'anthropic/claude-sonnet-5-5'] };
  const fake = fakeCtx();
  const router = createRouter({ config: config(), ladders, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.error, 'cross-provider');
  assert.equal(fake.calls.switchModel.length, 0);
});

test('a session with no recorded model is caller-unknown', async () => {
  const fake = fakeCtx();
  const router = createRouter({ config: config(), ladders: LADDERS, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  assert.equal((await router.switchModel({}, { sessionID: 'ses_404' })).error, 'caller-unknown');
  assert.equal(fake.calls.switchModel.length, 0);
});

test('a seat with no ladder is no-ladder', async () => {
  const fake = fakeCtx();
  const router = createRouter({ config: config(), ladders: LADDERS, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'build',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  assert.equal((await router.switchModel({}, { sessionID: 'ses_1' })).error, 'no-ladder');
});

test('a call with no session and no agent is unknown-agent', async () => {
  const fake = fakeCtx();
  const router = createRouter({ config: config(), ladders: LADDERS, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  assert.equal((await router.switchModel({}, {})).error, 'unknown-agent');
});

// --- the rules ------------------------------------------------------------

test('a -free rung never reaches a ladder: the step is refused and posts nothing', async () => {
  const ladders = { lead: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/longcat-2.5-free'] };
  const fake = fakeCtx();
  const router = createRouter({ config: config(), ladders, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'free-model');
  assert.equal(fake.calls.switchModel.length, 0);
});

test('excludeFree:false lets the same -free rung through, because it is configuration', async () => {
  const ladders = { lead: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/longcat-2.5-free'] };
  const fake = fakeCtx();
  const router = createRouter({
    config: config({ rules: { excludeFree: false } }),
    ladders,
    ctx: fake.ctx,
    log: silent,
    benchmark: benchmark(),
  });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.ok, true);
  assert.equal(fake.calls.switchModel.length, 1);
});

test('a rung whose page publishes zero benchmarks is rejected', async () => {
  const ladders = { lead: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/minimax-m3.1-flash'] };
  const fake = fakeCtx();
  const router = createRouter({
    config: config({ rules: { requirePublishedBenchmark: true } }),
    ladders,
    ctx: fake.ctx,
    log: silent,
    benchmark: benchmark('zero'),
  });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no-benchmark');
  assert.equal(out.target, 'opencode-go/minimax-m3.1-flash');
  assert.equal(fake.calls.switchModel.length, 0);
});

test('a rung whose page publishes benchmarks is accepted', async () => {
  const fake = fakeCtx();
  const router = createRouter({
    config: config({ rules: { requirePublishedBenchmark: true } }),
    ladders: LADDERS,
    ctx: fake.ctx,
    log: silent,
    benchmark: benchmark('benchmarked'),
  });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.ok, true);
  assert.equal(fake.calls.switchModel.length, 1);
});

test('an unreachable benchmark site never rejects a rung', async () => {
  const logged = [];
  const fake = fakeCtx();
  const router = createRouter({
    config: config({ rules: { requirePublishedBenchmark: true } }),
    ladders: LADDERS,
    ctx: fake.ctx,
    log: (line) => logged.push(line),
    benchmark: benchmark('unknown'),
  });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.ok, true);
  assert.equal(fake.calls.switchModel.length, 1);
  assert.equal(logged.some((line) => line.includes('benchmark-skip')), true, 'the skip is recorded, not silent');
});

test('a rung over the input price cap is over-price', async () => {
  const ladders = { lead: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/minimax-m3.1-flash'] };
  const fake = fakeCtx();
  const router = createRouter({
    config: config({ rules: { maxInputUsd: 0.15, maxOutputUsd: 0.6 } }),
    ladders,
    ctx: fake.ctx,
    log: silent,
    benchmark: benchmark(),
  });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.error, 'over-price');
  assert.equal(out.rule, 'maxInputUsd');
  assert.equal(fake.calls.switchModel.length, 0);
});

test('a rung over the output price cap is over-price', async () => {
  const ladders = { lead: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/expensive-out'] };
  const models = [...CATALOG, { providerID: PROVIDER, id: 'expensive-out', cost: [{ input: 0.1, output: 7 }] }];
  const fake = fakeCtx({ models });
  const router = createRouter({
    config: config({ rules: { maxInputUsd: 0.15, maxOutputUsd: 0.6 } }),
    ladders,
    ctx: fake.ctx,
    log: silent,
    benchmark: benchmark(),
  });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.error, 'over-price');
  assert.equal(out.rule, 'maxOutputUsd');
});

test('an unpriced model skips the cap test and is logged, never guessed', async () => {
  const logged = [];
  const ladders = { lead: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/no-price'] };
  const models = [...CATALOG, { providerID: PROVIDER, id: 'no-price' }];
  const fake = fakeCtx({ models });
  const router = createRouter({
    config: config({ rules: { maxInputUsd: 0.01, maxOutputUsd: 0.01 } }),
    ladders,
    ctx: fake.ctx,
    log: (line) => logged.push(line),
    benchmark: benchmark(),
  });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.ok, true);
  assert.equal(logged.some((line) => line.includes('price-skip')), true);
});

test('a rung dearer than the pinned model is over-pinned', async () => {
  const ladders = { lead: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/minimax-m3.1-flash'] };
  const fake = fakeCtx();
  // No caps here: the rule under test is the pinned comparison, not the ceiling.
  const router = createRouter({
    config: config({ rules: { maxInputUsd: null, maxOutputUsd: null, rungMayNotCostMoreThanPinned: true } }),
    ladders,
    ctx: fake.ctx,
    log: silent,
    benchmark: benchmark(),
  });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.error, 'over-pinned');
  assert.equal(out.rule, 'rungMayNotCostMoreThanPinned');
});

test('the pinned-cost rule is configuration, not an invariant', async () => {
  const ladders = { lead: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/minimax-m3.1-flash'] };
  const fake = fakeCtx();
  const router = createRouter({
    config: config({ rules: { maxInputUsd: null, maxOutputUsd: null, rungMayNotCostMoreThanPinned: false } }),
    ladders,
    ctx: fake.ctx,
    log: silent,
    benchmark: benchmark(),
  });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.ok, true);
  assert.equal(fake.calls.switchModel.length, 1);
});

// --- the catalog cache, both shapes this build is known to answer with ----

test('the { location, data } envelope this build returns is unwrapped', async () => {
  const { router, calls } = await routerAt({ fake: fakeCtx({ envelope: 'data' }) });
  const out = await router.switchModel({}, { sessionID: 'ses_1' });
  assert.equal(out.ok, true);
  assert.equal(calls.switchModel.length, 1);
});

test('the documented bare array is unwrapped too', async () => {
  const { router } = await routerAt({ fake: fakeCtx({ envelope: 'array' }) });
  assert.equal((await router.switchModel({}, { sessionID: 'ses_1' })).ok, true);
});

test('an unrecognised catalog shape is no models, never a throw', async () => {
  const { router } = await routerAt({ fake: fakeCtx({ envelope: 'other' }) });
  assert.equal((await router.switchModel({}, { sessionID: 'ses_1' })).error, 'not-available');
});

test('the catalog is listed once and reused inside the cache window', async () => {
  const { router, calls } = await routerAt();
  await router.switchModel({ rung: 1 }, { sessionID: 'ses_1' });
  await router.switchModel({ rung: 2 }, { sessionID: 'ses_1' });
  assert.equal(calls.list, 1);
});

test('a catalog miss forces one refresh before not-available', async () => {
  let round = 0;
  const ctx = {
    session: { switchModel: async () => {} },
    model: {
      list: async () => {
        round += 1;
        return round === 1 ? [CATALOG[0]] : [CATALOG[0], CATALOG[1]];
      },
    },
  };
  let clock = 0;
  const router = createRouter({ config: config(), ladders: LADDERS, ctx, log: silent, now: () => clock, benchmark: benchmark() });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  clock = 60_000;
  assert.equal((await router.switchModel({}, { sessionID: 'ses_1' })).ok, true);
  assert.equal(round, 2);
});

// --- the automatic path ---------------------------------------------------

test('a recorded failure steps the next resolve down one rung on the same provider', async () => {
  const fake = fakeCtx();
  const router = createRouter({ config: config({ rules: { autoFailover: true } }), ladders: LADDERS, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  await router.resolve({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  router.recordFailure({ sessionID: 'ses_1', agent: 'lead', error: { type: 'provider.error', message: 'boom' }, decision: { retry: true } });
  const event = { sessionID: 'ses_1', agent: 'lead', model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' }, kind: 'primary' };
  await router.resolve(event);
  assert.deepEqual(event.model, { providerID: PROVIDER, id: 'glm-5.3-flash' });
});

test('autoFailover:false leaves the automatic path idle while the tool still steps', async () => {
  const fake = fakeCtx();
  const router = createRouter({
    config: config({ rules: { autoFailover: false } }),
    ladders: LADDERS,
    ctx: fake.ctx,
    log: silent,
    benchmark: benchmark(),
  });
  const base = { sessionID: 'ses_1', agent: 'lead', kind: 'primary' };
  await router.resolve({ ...base, model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' } });
  router.recordFailure({ ...base, error: { type: 'e' }, decision: {} });
  const event = { ...base, model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' } };
  await router.resolve(event);
  assert.deepEqual(event.model, { providerID: PROVIDER, id: 'deepseek-v4.1-flash' });
  assert.equal((await router.switchModel({}, { sessionID: 'ses_1' })).ok, true);
});

test('the automatic path obeys the same rules as the tool', async () => {
  const ladders = { lead: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/longcat-2.5-free'] };
  const fake = fakeCtx();
  const router = createRouter({ config: config(), ladders, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  const base = { sessionID: 'ses_1', agent: 'lead', kind: 'primary' };
  await router.resolve({ ...base, model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' } });
  router.recordFailure({ ...base, error: { type: 'e' }, decision: {} });
  const event = { ...base, model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' } };
  await router.resolve(event);
  assert.deepEqual(event.model, { providerID: PROVIDER, id: 'deepseek-v4.1-flash' }, 'a -free rung is never served');
});

test('title requests are never rerouted', async () => {
  const fake = fakeCtx();
  const router = createRouter({ config: config(), ladders: LADDERS, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  const base = { sessionID: 'ses_1', agent: 'lead' };
  await router.resolve({ ...base, model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' }, kind: 'primary' });
  router.recordFailure({ ...base, error: { type: 'e' }, decision: {} });
  const event = { ...base, model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' }, kind: 'title' };
  await router.resolve(event);
  assert.deepEqual(event.model, { providerID: PROVIDER, id: 'deepseek-v4.1-flash' });
});

test('a failure at the floor keeps the last rung and vetoes the retry', async () => {
  const fake = fakeCtx();
  const router = createRouter({ config: config(), ladders: LADDERS, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  const base = { sessionID: 'ses_1', agent: 'scout', kind: 'primary' };
  await router.resolve({ ...base, model: { providerID: PROVIDER, id: 'muse-spark-1.2-contributor' } });

  const vetoed = { ...base, error: { type: 'e' }, decision: { retry: true, delay: 500 } };
  router.recordFailure(vetoed);
  assert.deepEqual(vetoed.decision, { retry: false });

  const event = { ...base, model: { providerID: PROVIDER, id: 'muse-spark-1.2-contributor' } };
  await router.resolve(event);
  assert.deepEqual(event.model, { providerID: PROVIDER, id: 'muse-spark-1.2-contributor' });
});

test('a retry with a rung left is not vetoed', async () => {
  const fake = fakeCtx();
  const router = createRouter({ config: config(), ladders: LADDERS, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  const base = { sessionID: 'ses_1', agent: 'lead', kind: 'primary' };
  await router.resolve({ ...base, model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' } });
  const open = { ...base, error: { type: 'e' }, decision: { retry: true, delay: 500 } };
  router.recordFailure(open);
  assert.deepEqual(open.decision, { retry: true, delay: 500 });
});

// --- logging: the record, and what it refuses to carry --------------------

test('a log line is six tab separated fields, timestamp first', () => {
  const line = formatLine({
    at: new Date('2026-11-13T02:00:00.000Z'),
    sessionID: 'ses_1',
    agent: 'lead',
    from: 'opencode-go/deepseek-v4.1-flash',
    to: 'opencode-go/glm-5.3-flash',
    reason: 'tool',
  });
  const fields = line.split('\t');
  assert.equal(fields.length, 6);
  assert.equal(fields[0], '2026-11-13T02:00:00.000Z');
  assert.equal(fields[5], 'tool');
});

test('an error contributes its type and status, never its message', () => {
  const line = formatLine({
    at: new Date('2026-11-13T02:00:00.000Z'),
    reason: 'failover',
    error: { type: 'provider.error', message: 'Bearer sk-secret', status: 500 },
  });
  assert.equal(line.includes('sk-secret'), false);
  assert.equal(line.includes('provider.error'), true);
  assert.equal(line.includes('500'), true);
});

test('a log that cannot be written never costs a request', () => {
  const log = makeLog(path.join('Z:', 'no-such-drive', 'oc-fallback.log'), { console: { log: () => {} } });
  assert.doesNotThrow(() => log('line'));
});

// --- setup, registration, and the fail-open floor -------------------------

test('createFallback registers one switch_model tool in the model namespace', () => {
  const fake = fakeCtx();
  const router = createFallback({ config: config(), ladders: LADDERS, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  assert.equal(typeof router.switchModel, 'function');
  assert.deepEqual(fake.calls.hooks.map((hook) => hook.name), ['experimental.model.resolve', 'retry']);
  assert.equal(fake.calls.tools.length, 1);
  const [tool] = fake.calls.tools;
  assert.equal(tool.name, 'switch_model');
  assert.equal(tool.options.namespace, 'model');
  assert.equal(tool.options.codemode, true);
  assert.deepEqual(Object.keys(tool.input.properties).sort(), ['list', 'model', 'rung']);
  assert.equal(tool.input.additionalProperties, false);
  assert.equal(fake.calls.namespace.name, 'model');
});

test('the registered tool answers with one parseable JSON string and really switches', async () => {
  const fake = fakeCtx();
  createFallback({ config: config(), ladders: LADDERS, ctx: fake.ctx, log: silent, benchmark: benchmark() });
  await fake.calls.hooks[0].callback({
    sessionID: 'ses_1',
    agent: 'lead',
    model: { providerID: PROVIDER, id: 'deepseek-v4.1-flash' },
    kind: 'primary',
  });
  const [tool] = fake.calls.tools;
  const listed = await tool.execute({ list: true }, { sessionID: 'ses_1' });
  assert.equal(JSON.parse(listed.content).ok, true);
  const stepped = await tool.execute({}, { sessionID: 'ses_1' });
  assert.equal(JSON.parse(stepped.content).model, 'opencode-go/glm-5.3-flash');
  assert.deepEqual(fake.calls.switchModel, [
    { sessionID: 'ses_1', model: { providerID: PROVIDER, id: 'glm-5.3-flash' } },
  ]);
});

test('createFallback registers nothing without ladders, on a kill switch, or on a bare ctx', () => {
  const ctx = fakeCtx().ctx;
  assert.equal(createFallback({ config: config(), ladders: {}, ctx, log: silent }), null);
  assert.equal(createFallback({ config: config(), ladders: LADDERS, ctx, log: silent, env: { OC_FALLBACK: 'off' } }), null);
  assert.equal(createFallback({ config: normalize({ ...DEFAULTS, enabled: false }), ladders: LADDERS, ctx, log: silent }), null);
  assert.equal(createFallback({ config: config(), ladders: LADDERS, ctx: {}, log: silent }), null);
  assert.equal(createFallback({ config: config(), ladders: LADDERS, ctx: { tool: {}, session: {} }, log: silent }), null);
});

// A config file this suite writes for itself, so setup is exercised end to end
// without reading the machine's own config and without writing to its log.
function temporaryConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fallback-test-'));
  const file = path.join(dir, 'oc-fallback.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ logPath: path.join(dir, 'oc-fallback.log'), ...contents }),
    'utf8',
  );
  return { dir, file };
}

async function withConfig(contents, run) {
  const { dir, file } = temporaryConfig(contents);
  const previous = process.env.OC_FALLBACK_CONFIG;
  process.env.OC_FALLBACK_CONFIG = file;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OC_FALLBACK_CONFIG;
    else process.env.OC_FALLBACK_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the plugin definition is oc-fallback and its setup never throws', async () => {
  const ENTRY = path.join(import.meta.dirname, '..', 'src', 'index.js');
  const mod = await import(pathToFileURL(ENTRY).href);
  assert.equal(mod.default.id, 'oc-fallback');
  assert.equal(typeof mod.default.setup, 'function');
  await withConfig({ ladders: {} }, async () => {
    await assert.doesNotReject(async () => mod.default.setup(undefined));
    await assert.doesNotReject(async () => mod.default.setup({}));
    await assert.doesNotReject(async () => mod.default.setup({ tool: {} }));
  });
});

test('setup registers the tool and the hook from a pointer ladder, and nothing when it cannot', async () => {
  const ENTRY = path.join(import.meta.dirname, '..', 'src', 'index.js');
  const mod = await import(pathToFileURL(ENTRY).href);

  // A pointer at a file that does not exist: no ladders, no registration, no throw.
  await withConfig({ ladders: { file: path.join(os.tmpdir(), 'oc-fallback-absent.json') } }, async () => {
    const fake = fakeCtx();
    await assert.doesNotReject(async () => mod.default.setup(fake.ctx));
    assert.equal(fake.calls.tools.length, 0);
  });

  // A pointer at a file that does: the tool registers, and the real config path
  // is the one the owner will use.
  const harness = path.join(os.tmpdir(), `oc-fallback-harness-${process.pid}.json`);
  fs.writeFileSync(harness, JSON.stringify(HARNESS), 'utf8');
  try {
    await withConfig({ ladders: { file: harness, key: 'fallbacks' } }, async () => {
      const fake = fakeCtx();
      await assert.doesNotReject(async () => mod.default.setup(fake.ctx));
      assert.deepEqual(fake.calls.tools.map((tool) => tool.name), ['switch_model']);
    });
  } finally {
    fs.rmSync(harness, { force: true });
  }
});

// --- the benchmark check, over a fake site -------------------------------

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://opencode.ai/data/</loc></url>
  <url><loc>https://opencode.ai/data/deepseek</loc></url>
  <url><loc>https://opencode.ai/data/deepseek/deepseek-v4-1-flash</loc></url>
  <url><loc>https://opencode.ai/data/zhipuai/glm-5-3-flash</loc></url>
  <url><loc>https://opencode.ai/data/xiaomi/mimo-v2-6-flash</loc></url>
  <url><loc>https://opencode.ai/data/compare/deepseek/deepseek-v4-1-flash/xiaomi/mimo-v2-6-flash</loc></url>
</urlset>`;

test('a model id maps to the slug the site uses', () => {
  assert.equal(modelSlug('deepseek-v4.1-flash'), 'deepseek-v4-1-flash');
  assert.equal(modelSlug('mimo-v2.6-flash'), 'mimo-v2-6-flash');
});

test('the sitemap index keeps model pages and drops the compare pages', () => {
  const index = sitemapIndex(SITEMAP);
  assert.equal(index.get('deepseek-v4-1-flash'), 'https://opencode.ai/data/deepseek/deepseek-v4-1-flash');
  assert.equal(index.has('deepseek'), false, 'a lab landing page is not a model page');
  assert.equal([...index.values()].some((url) => url.includes('/compare/')), false);
});

// One fake site: sitemap plus per-page json, answering exactly what a test says.
function fakeSite({ pages = {}, sitemap = SITEMAP, fail = false } = {}) {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    if (fail) throw new Error('getaddrinfo ENOTFOUND opencode.ai');
    if (url.endsWith('sitemap.xml')) return { ok: true, status: 200, text: async () => sitemap };
    const slug = url.split('/').pop().replace(/\.json$/, '');
    if (!(slug in pages)) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: { benchmarks: pages[slug] } }) };
  };
  return { fetch, seen };
}

test('a page with benchmarks answers benchmarked', async () => {
  const site = fakeSite({ pages: { 'glm-5-3-flash': [{ name: 'GPQA Diamond', score: 87 }] } });
  const catalog = createCatalog({ fetch: site.fetch, now: () => 0 });
  const result = await catalog.status('opencode-go/glm-5.3-flash');
  assert.equal(result.state, 'benchmarked');
  assert.equal(result.count, 1);
});

test('a page with an empty benchmarks array answers zero', async () => {
  const site = fakeSite({ pages: { 'mimo-v2-6-flash': [] } });
  const catalog = createCatalog({ fetch: site.fetch, now: () => 0 });
  assert.equal((await catalog.status('opencode-go/mimo-v2.6-flash')).state, 'zero');
});

test('an unreachable site answers unknown, which the rules treat as fail open', async () => {
  const site = fakeSite({ fail: true });
  const catalog = createCatalog({ fetch: site.fetch, now: () => 0 });
  const result = await catalog.status('opencode-go/glm-5.3-flash');
  assert.equal(result.state, 'unknown');
});

test('a model with no page on the site answers unknown', async () => {
  const site = fakeSite({ pages: {} });
  const catalog = createCatalog({ fetch: site.fetch, now: () => 0 });
  assert.equal((await catalog.status('opencode-go/no-such-model')).state, 'unknown');
});

test('a page whose benchmarks field is not an array is unknown, not zero', async () => {
  const site = fakeSite({ sitemap: SITEMAP });
  const fetch = async (url) => {
    if (url.endsWith('sitemap.xml')) return { ok: true, status: 200, text: async () => SITEMAP };
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: {} }) };
  };
  const catalog = createCatalog({ fetch, now: () => 0 });
  assert.equal((await catalog.status('opencode-go/glm-5.3-flash')).state, 'unknown');
});

test('the sitemap and each page result are cached inside the window', async () => {
  const site = fakeSite({ pages: { 'glm-5-3-flash': [{ name: 'x' }] } });
  let clock = 0;
  const catalog = createCatalog({ fetch: site.fetch, now: () => clock, ttlMs: 600_000 });
  await catalog.status('opencode-go/glm-5.3-flash');
  await catalog.status('opencode-go/glm-5.3-flash');
  assert.equal(site.seen.filter((url) => url.endsWith('sitemap.xml')).length, 1);
  assert.equal(site.seen.filter((url) => url.endsWith('.json')).length, 1);
  clock = 600_001;
  await catalog.status('opencode-go/glm-5.3-flash');
  assert.equal(site.seen.filter((url) => url.endsWith('sitemap.xml')).length, 2);
});
