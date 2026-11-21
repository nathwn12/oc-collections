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
  const { resolver, lines, event, logs } = setup();
  const e = event();
  const decision = resolver.resolve(e);
  assert.equal(decision.model, 'p/free-a');
  assert.equal(decision.tier, 'heavy', 'a 200k context fits the heavy tier');
  assert.match(decision.reason, /^tier:/);
  assert.deepEqual(e.model, { providerID: 'p', id: 'free-a' }, 'only the model changes, same provider');
  assert.equal(lines.length, 1);
  assert.equal(lines[0][1], decision.receiptText);
  assert.equal(logs.length, 0, 'enforce logs only through the receipt');
  const fields = decision.receiptText.split('\t');
  assert.equal(fields[1], 'p/free-a');
  assert.equal(fields[2], 'heavy');
  assert.match(fields[4], /^0ms$/);
  assert.match(fields[5], /^\$0\.0000$/);
});

test('zero cost ranks by grade, then ttft, then context', () => {
  const grades = createGradeStore(null, { now: () => 1000 });
  grades.record('p/free-b#primary', { ok: true, ms: 50, costUsd: 0 });
  const { resolver, event } = setup({ grades });
  assert.equal(resolver.resolve(event()).model, 'p/free-b', 'a sampled free model with a better grade wins');

  const tied = createGradeStore(null, { now: () => 1000 });
  tied.record('p/free-a#primary', { ok: true, ms: 10, costUsd: 0 });
  tied.record('p/free-b#primary', { ok: true, ms: 90, costUsd: 0 });
  assert.equal(setup({ grades: tied }).resolver.resolve(event()).model, 'p/free-a', 'lower ttft wins a grade tie');
});

test('an empty catalog, a banked model and an empty budget all inherit', () => {
  const empty = setup({ models: [] });
  const e1 = empty.event();
  assert.equal(empty.resolver.resolve(e1), null);
  assert.deepEqual(e1.model, { providerID: 'p', id: 'dear' });

  const grades = createGradeStore(null, { now: () => 1000 });
  grades.bank('p/free-a#primary', 5000);
  const banked = setup({ grades });
  assert.equal(banked.resolver.resolve(banked.event()).model, 'p/free-b', 'a banked model is skipped');

  const broke = setup({ policyPatch: { caps: { maxSpendUsd: 0 } } });
  const e2 = broke.event();
  assert.equal(broke.resolver.resolve(e2), null);
  assert.deepEqual(e2.model, { providerID: 'p', id: 'dear' });
});

test('shadow logs the decision and leaves the model alone', () => {
  const { resolver, logs, lines, event } = setup({ mode: 'shadow' });
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
  const independent = setup({ policyPatch: { roles: { known: { build: 'verify' } } } });
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
