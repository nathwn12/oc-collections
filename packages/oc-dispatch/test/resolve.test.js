import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, merge } from '../src/policy.mjs';
import { normalize } from '../src/catalog.mjs';
import { createGradeStore } from '../src/grade.mjs';
import { createResolver } from '../src/resolve.mjs';

const MODELS = [
  { providerID: 'p', id: 'free-a', name: 'A', family: 'alpha', status: 'active', enabled: true, limit: { context: 200000 }, tools: true, cost: [{ input: 0, output: 0 }] },
  { providerID: 'p', id: 'free-b', name: 'B', family: 'beta', status: 'active', enabled: true, limit: { context: 200000 }, tools: true, cost: [{ input: 0, output: 0 }] },
  { providerID: 'p', id: 'dear', name: 'D', family: 'beta', status: 'active', enabled: true, limit: { context: 200000 }, tools: true, cost: [{ input: 3, output: 9 }] },
  { providerID: 'q', id: 'foreign', name: 'F', family: 'alpha', status: 'active', enabled: true, limit: { context: 200000 }, tools: true, cost: [{ input: 0, output: 0 }] },
];

function setup({ mode = 'enforce', models = MODELS, policyPatch = {}, grades } = {}) {
  const logs = [];
  const lines = [];
  const resolver = createResolver({
    policy: merge(DEFAULTS, { mode, ...policyPatch }),
    models: normalize(models),
    grades: grades ?? createGradeStore(null, { now: () => 1000 }),
    log: (line) => logs.push(line),
    append: (p, line) => lines.push([p, line]),
    logPath: '/tmp/oc-dispatch.log',
    now: () => 1000,
  });
  const event = () => ({ sessionID: 'ses_1', agent: 'build', kind: 'primary', context: 200000, model: { providerID: 'p', id: 'dear' } });
  return { resolver, logs, lines, event };
}

test('enforce substitutes a cheaper adequate model and writes one receipt', () => {
  const { resolver, lines, event, logs } = setup({ policyPatch: { confidentiality: { freeForCode: true } } });
  const e = event();
  const decision = resolver.resolve(e);
  assert.equal(decision.model, 'p/free-a');
  assert.equal(decision.tier, 'verify', 'a large context raises the choosing floor to verify, not opt-in heavy');
  assert.match(decision.reason, /^tier:/);
  assert.deepEqual(e.model, { providerID: 'p', id: 'free-a' }, 'only the model changes, same provider');
  assert.equal(lines.length, 1);
  assert.equal(lines[0][1], decision.receiptText);
  assert.equal(logs.length, 0, 'enforce logs only through the receipt');
  const fields = decision.receiptText.split('\t');
  assert.equal(fields[1], 'p/free-a');
  assert.equal(fields[2], 'verify');
  assert.match(fields[4], /^0ms$/);
  assert.match(fields[5], /^est\. \$0\.0000$/);
});

test('zero cost ranks by grade, then ttft, then context', () => {
  const grades = createGradeStore(null, { now: () => 1000 });
  grades.record('p/free-b#primary', { ok: true, ms: 50, costUsd: 0 });
  const { resolver, event } = setup({ grades, policyPatch: { confidentiality: { freeForCode: true } } });
  const primary = () => {
    const e = event();
    e.context = 40000; // medium: no verifier-family rule in the way of this ranking test
    return e;
  };
  assert.equal(resolver.resolve(primary()).model, 'p/free-b', 'a sampled free model with a better grade wins');

  const tied = createGradeStore(null, { now: () => 1000 });
  tied.record('p/free-a#primary', { ok: true, ms: 10, costUsd: 0 });
  tied.record('p/free-b#primary', { ok: true, ms: 90, costUsd: 0 });
  assert.equal(
    setup({ grades: tied, policyPatch: { confidentiality: { freeForCode: true } } }).resolver.resolve(primary()).model,
    'p/free-a',
    'lower ttft wins a grade tie',
  );
});

test('an empty catalog, a banked model and an empty budget all inherit', () => {
  const empty = setup({ models: [] });
  const e1 = empty.event();
  assert.equal(empty.resolver.resolve(e1), null);
  assert.deepEqual(e1.model, { providerID: 'p', id: 'dear' });

  const grades = createGradeStore(null, { now: () => 1000 });
  grades.bank('p/free-a#primary', 5000);
  const banked = setup({ grades, policyPatch: { confidentiality: { freeForCode: true } } });
  const eBanked = banked.event();
  eBanked.context = 40000;
  assert.equal(banked.resolver.resolve(eBanked).model, 'p/free-b', 'a banked model is skipped');

  const broke = setup({ policyPatch: { caps: { maxSpendUsd: 0 } } });
  const e2 = broke.event();
  assert.equal(broke.resolver.resolve(e2), null);
  assert.deepEqual(e2.model, { providerID: 'p', id: 'dear' });
});

test('shadow logs the decision and leaves the model alone', () => {
  const { resolver, logs, lines, event } = setup({ mode: 'shadow', policyPatch: { confidentiality: { freeForCode: true } } });
  const e = event();
  const decision = resolver.resolve(e);
  assert.equal(decision.model, 'p/free-a', 'the decision is still computed');
  assert.deepEqual(e.model, { providerID: 'p', id: 'dear' }, 'the model is untouched');
  assert.equal(lines.length, 0, 'no receipt without a substitution');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[oc-dispatch\] shadow /);
  assert.ok(logs[0].includes('p/free-a'));
});

test('verify needs a different family and warns instead of faking independence', () => {
  const independent = setup({
    policyPatch: { roles: { known: { build: 'verify' } }, confidentiality: { freeForCode: true } },
  });
  assert.equal(independent.resolver.resolve(independent.event()).model, 'p/free-a', 'alpha differs from the beta executor');

  const sameFamily = setup({
    models: MODELS.filter((m) => m.family !== 'alpha'),
    policyPatch: { roles: { known: { build: 'verify' } } },
  });
  const e = sameFamily.event();
  assert.equal(sameFamily.resolver.resolve(e), null);
  assert.deepEqual(e.model, { providerID: 'p', id: 'dear' });
  assert.ok(sameFamily.logs.some((line) => line.includes('verify-no-independent-family')));
});

test('cosmetic kinds take the fast tier and an already-cheapest model inherits', () => {
  const titled = setup();
  const e = titled.event();
  e.kind = 'title';
  const decision = titled.resolver.resolve(e);
  assert.equal(decision.tier, 'fast');
  assert.equal(decision.model, 'p/free-a');

  const cheapest = setup();
  const e2 = cheapest.event();
  e2.model = { providerID: 'p', id: 'free-a' };
  assert.equal(cheapest.resolver.resolve(e2), null, 'no receipt for substituting a model with itself');
  assert.equal(cheapest.lines.length, 0);
});

test('a role tier is a floor for choosing, and an override keeps its tier under the cap', () => {
  const freeFastOnly = { ...MODELS[0], id: 'fast-only', family: 'alpha', tools: false, cost: [{ input: 0, output: 0 }] };
  const mid = { ...MODELS[0], id: 'mid', family: 'beta', tools: true, cost: [{ input: 0.1, output: 0.2 }] };
  const openFree = { confidentiality: { freeForCode: true } };

  const floored = setup({ models: [freeFastOnly, mid], policyPatch: { ...openFree, roles: { known: { build: 'medium' } } } });
  const e1 = floored.event();
  e1.context = 1000; // context alone would choose fast
  const d1 = floored.resolver.resolve(e1);
  assert.equal(d1.tier, 'medium', 'the role tier raises the chosen tier above the context tier');
  assert.equal(d1.model, 'p/mid', 'a model that only fits the fast tier is not chosen');

  const overCap = { ...mid, id: 'over-cap', family: 'gamma', cost: [{ input: 5, output: 10 }] };
  const heavyCapped = setup({
    models: [overCap],
    policyPatch: { ...openFree, overrides: { build: { tier: 'heavy' } } },
  });
  const e2 = heavyCapped.event();
  assert.equal(heavyCapped.resolver.resolve(e2), null, 'a heavy override still obeys the tier cap');
  assert.deepEqual(e2.model, { providerID: 'p', id: 'dear' });

  const withinCap = { ...mid, id: 'heavy-ok', family: 'delta', cost: [{ input: 2, output: 8 }] };
  const heavyOk = setup({
    models: [withinCap],
    policyPatch: { ...openFree, overrides: { build: { tier: 'heavy' } } },
  });
  const d2 = heavyOk.resolver.resolve(heavyOk.event());
  assert.equal(d2.tier, 'heavy');
  assert.equal(d2.model, 'p/heavy-ok');
});

test('spend is an estimate unless the event carries a real cost, and the ceiling still binds', () => {
  const free = MODELS[0];
  const priced = { ...free, id: 'priced', family: 'gamma', cost: [{ input: 0.1, output: 0.2 }] };
  const openFree = { confidentiality: { freeForCode: true } };

  const estimated = setup({ models: [free, priced], policyPatch: openFree });
  const d1 = estimated.resolver.resolve(estimated.event());
  assert.equal(d1.spendEstimate, 0);
  assert.equal(d1.spendActual, null);
  assert.match(d1.receiptText, /\test\. \$0\.0000$/);

  const real = setup({ models: [free, priced], policyPatch: openFree });
  const e2 = real.event();
  e2.cost = 0.25;
  const d2 = real.resolver.resolve(e2);
  assert.equal(d2.spendActual, 0.25);
  assert.equal(d2.spendEstimate, 0);
  assert.match(d2.receiptText, /\t\$0\.2500$/, 'a real cost is printed without the estimate label');

  const capped = setup({ models: [priced], policyPatch: { ...openFree, caps: { maxSpendUsd: 0.3 } } });
  assert.notEqual(capped.resolver.resolve(capped.event()), null);
  assert.equal(capped.resolver.resolve(capped.event()), null, 'the estimate still counts against the ceiling');

  const realCapped = setup({ models: [priced], policyPatch: { ...openFree, caps: { maxSpendUsd: 0.3 } } });
  const e3 = realCapped.event();
  e3.message = { cost: 0.3 };
  assert.notEqual(realCapped.resolver.resolve(e3), null);
  assert.equal(realCapped.resolver.resolve(realCapped.event()), null, 'a real cost counts against the ceiling too');
});

test('confidentiality blocks zero cost on code-carrying tiers unless opted in', () => {
  const free = MODELS.find((m) => m.id === 'free-a');
  const priced = { ...free, id: 'priced', family: 'gamma', cost: [{ input: 0.1, output: 0.2 }] };
  const catalog = [free, priced];

  const blocked = setup({ models: catalog });
  const e1 = blocked.event();
  e1.context = 40000; // medium, so this is code-carrying
  assert.equal(blocked.resolver.resolve(e1).model, 'p/priced', 'a zero-cost model must not serve code by default');

  const allowed = setup({ models: catalog, policyPatch: { confidentiality: { freeForCode: true } } });
  const e2 = allowed.event();
  e2.context = 40000;
  assert.equal(allowed.resolver.resolve(e2).model, 'p/free-a', 'an explicit opt-in allows free models');

  const opted = setup({ models: catalog, policyPatch: { confidentiality: { freeForCodeProviders: ['p'] } } });
  const e3 = opted.event();
  e3.context = 40000;
  assert.equal(opted.resolver.resolve(e3).model, 'p/free-a', 'a stored provider opt-in allows free models');

  const fastRead = setup({ models: catalog });
  const e4 = fastRead.event();
  e4.kind = 'title';
  e4.context = 40000;
  assert.equal(fastRead.resolver.resolve(e4).model, 'p/free-a', 'fast reads are never gated');
});

test('off and an explicit off command both stop substitutions', () => {
  const dormant = setup({ mode: 'off' });
  const e = dormant.event();
  assert.equal(dormant.resolver.resolve(e), null);
  assert.deepEqual(e.model, { providerID: 'p', id: 'dear' });

  const switched = setup();
  switched.resolver.setMode('off');
  const e2 = switched.event();
  assert.equal(switched.resolver.resolve(e2), null);
  assert.deepEqual(e2.model, { providerID: 'p', id: 'dear' });
});
