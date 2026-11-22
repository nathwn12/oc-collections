import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../src/policy.mjs';
import {
  catalogIsStale,
  createCatalog,
  filterCandidates,
  findModel,
  normalize,
  pickTier,
  rank,
  tokenPrice,
  unitCost,
} from '../src/catalog.mjs';

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

// Two sized cost rows: the cheap band covers a small tier, the dear band a
// large one. A steady-priced rival makes the band choice decide the winner.
const BANDED = normalize([
  {
    providerID: 'p', id: 'banded', status: 'active', enabled: true,
    limit: { context: 200000 }, tools: true,
    cost: [{ input: 1, output: 1, size: 32768 }, { input: 5, output: 5, size: 131072 }],
  },
  {
    providerID: 'p', id: 'steady', status: 'active', enabled: true,
    limit: { context: 200000 }, tools: true,
    cost: [{ input: 3, output: 3, size: 32768 }],
  },
]);

test('unitCost brackets the tier context and the price can flip the ranking', () => {
  const [banded, steady] = BANDED;
  assert.deepEqual(unitCost(banded), { input: 1, output: 1 }, 'no context keeps the first row');
  assert.deepEqual(unitCost(banded, 32768), { input: 1, output: 1 });
  assert.deepEqual(unitCost(banded, 131072), { input: 5, output: 5 });
  assert.equal(tokenPrice(banded, 131072), 10);

  const small = rank(BANDED, { contextCeiling: 32768 }).map((m) => m.modelID);
  const large = rank(BANDED, { contextCeiling: 131072 }).map((m) => m.modelID);
  assert.deepEqual(small, ['banded', 'steady'], 'the cheap band wins a small tier');
  assert.deepEqual(large, ['steady', 'banded'], 'the dear band loses a large tier');
  assert.deepEqual(rank(BANDED, { spec: { contextCeiling: 131072 } }).map((m) => m.modelID), large, 'a tier spec works too');
});

test('rank is stable when both tier ceilings land in the same price band', () => {
  assert.deepEqual(rank(BANDED, { contextCeiling: 8192 }).map((m) => m.modelID), ['banded', 'steady']);
  assert.deepEqual(rank(BANDED, { contextCeiling: 30000 }).map((m) => m.modelID), ['banded', 'steady']);
  assert.deepEqual(rank(BANDED).map((m) => m.modelID), ['banded', 'steady'], 'callers with no tier keep the old order');
});

const rawModel = (id, input) => ({ providerID: 'p', id, enabled: true, cost: [{ input, output: 0 }] });

test('catalog sync rebuilds after caps.catalogTTLMs so new, removed and re-priced models show', async () => {
  let clock = 1000;
  let raw = [rawModel('keep', 0), rawModel('gone', 0)];
  const policy = { caps: { catalogTTLMs: 100 } };
  const cat = await createCatalog({ load: () => raw, policy, now: () => clock });
  assert.deepEqual(cat.models.map((m) => m.modelID), ['keep', 'gone']);

  raw = [rawModel('keep', 1), rawModel('new', 0)];
  clock += 100; // exactly at the TTL is still fresh: the check is strictly greater
  assert.equal(catalogIsStale(cat.cacheAt, policy, () => clock), false);
  assert.deepEqual((await cat.sync()).models.map((m) => m.modelID), ['keep', 'gone'], 'inside the TTL nothing changes');

  clock += 1;
  assert.equal(catalogIsStale(cat.cacheAt, policy, () => clock), true);
  const out = await cat.sync();
  assert.equal(out.stale, true);
  assert.deepEqual(out.models.map((m) => m.modelID), ['keep', 'new'], 'a new model appears and a removed one goes');
  assert.deepEqual(unitCost(out.models[0]), { input: 1, output: 0 }, 'a re-priced model shows the new price');
  assert.equal(cat.cacheAt, clock, 'a rebuild restarts the TTL from the injected clock');
});

test('catalog sync keeps the cached models inside the TTL', async () => {
  let clock = 500;
  let raw = [rawModel('only', 0)];
  const policy = { caps: { catalogTTLMs: 1000 } };
  const cat = await createCatalog({ load: () => raw, policy, now: () => clock });
  raw = [rawModel('other', 1)];
  for (const advance of [0, 1, 999]) {
    clock = 500 + advance;
    assert.equal(catalogIsStale(cat.cacheAt, policy, () => clock), false);
    const out = await cat.sync();
    assert.equal(out.stale, false);
    assert.deepEqual(out.models.map((m) => m.modelID), ['only'], 'a changed source is ignored until the TTL passes');
  }
});
