import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../src/policy.mjs';
import { filterCandidates, findModel, normalize, pickTier, rank, unitCost } from '../src/catalog.mjs';

const RAW = {
  location: { workspaceID: 'w', directory: '/work' },
  data: [
    { providerID: 'p', id: 'free-a', name: 'Free A', family: 'alpha', status: 'active', enabled: true, released: 1, limit: { context: 200000, output: 8000 }, tools: true, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], variants: ['low'] },
    { providerID: 'p', id: 'dear-b', name: 'Dear B', family: 'beta', status: 'active', enabled: true, limit: { context: 100000 }, tools: true, cost: [{ tier: { type: 'context', size: 1000 }, input: 3, output: 9, cache: { read: 1, write: 2 } }] },
    { providerID: 'p', id: 'gone', status: 'deprecated', enabled: true, limit: { context: 200000 }, tools: true, cost: [{ input: 0, output: 0 }] },
  ],
};

test('normalize flattens {location,data} into the exact cached shape', () => {
  const models = normalize(RAW);
  assert.equal(models.length, 3);
  assert.deepEqual(Object.keys(models[0]).sort(), [
    'context', 'cost', 'enabled', 'family', 'modelID', 'name', 'output', 'providerID', 'released', 'status', 'tools', 'variants',
  ]);
  assert.deepEqual(models[0].cost[0], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(models[1].cost[0], { input: 3, output: 9, cacheRead: 1, cacheWrite: 2, size: 1000 });
  assert.equal(models[0].context, 200000);
  assert.equal(models[0].output, 8000);
  assert.deepEqual(models[0].variants, ['low']);

  const bare = normalize([{ providerID: 'p', id: 'solo', cost: [] }]);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].enabled, true);
  assert.equal(unitCost(bare[0]), null, 'an unpriced model is not free');
  assert.deepEqual(normalize(undefined), [], 'anything else is an empty catalog');
  assert.deepEqual(normalize({ location: 'x' }), []);
});

test('pickTier picks the cheapest tier whose window fits the context', () => {
  assert.equal(pickTier(DEFAULTS, 1000), 'fast');
  assert.equal(pickTier(DEFAULTS, 40000), 'medium');
  assert.equal(pickTier(DEFAULTS, 200000), 'heavy');
  assert.equal(pickTier(DEFAULTS), 'fast', 'the default context fits the fast tier');
  assert.equal(pickTier(DEFAULTS, 2_000_000), 'heavy', 'a larger context falls back to heavy');
});

test('filterCandidates applies every gate and the same-provider rule', () => {
  const models = normalize(RAW);
  const spec = DEFAULTS.tiers.heavy;
  const all = filterCandidates(models, spec, { providerID: 'p', caps: DEFAULTS.caps, spend: 0, banked: () => false });
  assert.deepEqual(all.map((m) => m.modelID), ['free-a'], 'deprecated and under-floor contexts are out');

  const noTools = filterCandidates(models, spec, { caps: DEFAULTS.caps, banked: () => false }).filter(() => false);
  assert.deepEqual(noTools, []);
  assert.deepEqual(
    filterCandidates(models, spec, { providerID: 'z', caps: DEFAULTS.caps, banked: () => false }),
    [],
    'never cross providers',
  );
  assert.deepEqual(
    filterCandidates(models, { ...spec, contextFloor: 0 }, { providerID: 'p', caps: DEFAULTS.caps, banked: (k) => k === 'p/free-a' }).map((m) => m.modelID),
    ['dear-b'],
    'a banked model is out',
  );
  assert.deepEqual(
    filterCandidates(models, { ...spec, requireTools: true, contextFloor: 150000 }, { providerID: 'p', caps: DEFAULTS.caps, banked: () => false }).map((m) => m.modelID),
    ['free-a'],
    'tools and context floor are enforced',
  );
  assert.deepEqual(
    filterCandidates(models, spec, { providerID: 'p', caps: DEFAULTS.caps, spend: 5, banked: () => false }),
    [],
    'a spent budget inherits',
  );
  assert.deepEqual(
    filterCandidates(models, { ...spec, maxInput: 0, maxOutput: 0 }, { providerID: 'p', caps: DEFAULTS.caps, banked: () => false }).map((m) => m.modelID),
    ['free-a'],
    'a price ceiling is enforced',
  );
  assert.equal(findModel(models, 'p', 'dear-b').family, 'beta');
});

test('rank puts free first, then grade, ttft and context', () => {
  const models = normalize(RAW);
  const other = { ...models[0], modelID: 'free-c', family: 'gamma' };
  const grades = {
    get: (key) => ({
      'p/free-a#primary': { samples: 4, ok: 3, taskCount: 3, costSum: 0, p50: 200 },
      'p/free-c#primary': { samples: 4, ok: 4, taskCount: 4, costSum: 0, p50: 300 },
    }[key] ?? null),
  };
  assert.deepEqual(rank([models[0], other, models[1]], { grades, taskClass: 'primary' }).map((m) => m.modelID), ['free-c', 'free-a', 'dear-b']);

  // Same grade and ttft: more context wins the free tie.
  const wide = { ...models[0], modelID: 'free-wide', context: 400000 };
  assert.equal(rank([models[0], wide], { grades: { get: () => ({ samples: 4, ok: 4, p50: 100 }) } })[0].modelID, 'free-wide');

  // Priced models with samples rank by cost per accepted task, not token price.
  const pricey = { ...models[1], modelID: 'pricey', cost: [{ input: 1, output: 1 }] };
  const graded = {
    get: (key) => (key === 'p/dear-b#primary' ? { taskCount: 10, costSum: 10 } : null),
  };
  assert.equal(rank([pricey, models[1]], { grades: graded, taskClass: 'primary' })[0].modelID, 'dear-b');
});
