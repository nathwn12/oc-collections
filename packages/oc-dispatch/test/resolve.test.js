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
  // Exactly the four fields on SessionModelResolve (@opencode/plugin 2.3.2).
  const event = (overrides = {}) => ({
    sessionID: 'ses_1',
    agent: 'build',
    kind: 'primary',
    model: { providerID: 'p', id: 'dear' },
    ...overrides,
  });
  return { resolver, logs, lines, event };
}

test('enforce substitutes a cheaper adequate model and writes one receipt', () => {
  const { resolver, lines, event, logs } = setup({
    policyPatch: {
      confidentiality: { freeForCode: true },
      roles: { known: { build: 'verify' } },
    },
  });
  const e = event();
  const decision = resolver.resolve(e);
  assert.equal(decision.model, 'p/free-a');
  assert.equal(decision.tier, 'verify', 'the role tier decides the floor now that context is not on the event');
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
  assert.equal(resolver.resolve(event()).model, 'p/free-b', 'a sampled free model with a better grade wins');

  const tied = createGradeStore(null, { now: () => 1000 });
  tied.record('p/free-a#primary', { ok: true, ms: 10, costUsd: 0 });
  tied.record('p/free-b#primary', { ok: true, ms: 90, costUsd: 0 });
  assert.equal(
    setup({ grades: tied, policyPatch: { confidentiality: { freeForCode: true } } }).resolver.resolve(event()).model,
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
  assert.equal(banked.resolver.resolve(banked.event()).model, 'p/free-b', 'a banked model is skipped');

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

  const cheapest = setup({ policyPatch: { confidentiality: { freeForCode: true } } });
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
  const d1 = floored.resolver.resolve(floored.event());
  assert.equal(d1.tier, 'medium', 'the role tier raises the chosen tier above the context tier');
  assert.equal(d1.model, 'p/mid', 'a model that only fits the fast tier is not chosen');

  const overCap = { ...mid, id: 'over-cap', family: 'gamma', cost: [{ input: 5, output: 10 }] };
  const heavyCapped = setup({
    models: [overCap],
    policyPatch: { ...openFree, overrides: { build: { tier: 'heavy' } } },
  });
  assert.equal(heavyCapped.resolver.resolve(heavyCapped.event()), null, 'a heavy override still obeys the tier cap');
  assert.deepEqual(heavyCapped.event().model, { providerID: 'p', id: 'dear' });

  const withinCap = { ...mid, id: 'heavy-ok', family: 'delta', cost: [{ input: 2, output: 8 }] };
  const heavyOk = setup({
    models: [withinCap],
    policyPatch: { ...openFree, overrides: { build: { tier: 'heavy' } }, caps: { spendPerTaskUsd: 1 } },
  });
  const d2 = heavyOk.resolver.resolve(heavyOk.event());
  assert.equal(d2.tier, 'heavy');
  assert.equal(d2.model, 'p/heavy-ok');
});

test('confidentiality blocks zero cost on code-carrying tiers unless opted in', () => {
  const free = MODELS.find((m) => m.id === 'free-a');
  const priced = { ...free, id: 'priced', family: 'gamma', cost: [{ input: 0.1, output: 0.2 }] };
  const catalog = [free, priced];

  const blocked = setup({ models: catalog });
  assert.equal(blocked.resolver.resolve(blocked.event()).model, 'p/priced', 'a zero-cost model must not serve code by default');

  const allowed = setup({ models: catalog, policyPatch: { confidentiality: { freeForCode: true } } });
  assert.equal(allowed.resolver.resolve(allowed.event()).model, 'p/free-a', 'an explicit opt-in allows free models');

  const opted = setup({ models: catalog, policyPatch: { confidentiality: { freeForCodeProviders: ['p'] } } });
  assert.equal(opted.resolver.resolve(opted.event()).model, 'p/free-a', 'a stored provider opt-in allows free models');

  const fastRead = setup({ models: catalog });
  const e4 = fastRead.event();
  e4.kind = 'title';
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

test('an invented context or agent config cannot steer the tier', () => {
  const base = setup({ policyPatch: { confidentiality: { freeForCode: true } } });
  const plain = base.resolver.resolve(base.event());
  const injected = base.resolver.resolve(base.event({ context: 200000, agentConfig: { tier: 'heavy' } }));
  assert.equal(plain.tier, 'medium', 'role and policy decide the floor, not event extras');
  assert.equal(injected.model, plain.model);
  assert.equal(injected.tier, plain.tier, 'invented fields change nothing');
});

test('an invented cost on the event cannot turn an estimate into a real spend', () => {
  const priced = { ...MODELS[0], id: 'priced', family: 'gamma', cost: [{ input: 0.1, output: 0.2 }] };
  const open = setup({ models: [priced], policyPatch: { confidentiality: { freeForCode: true } } });
  const clean = open.resolver.resolve(open.event({ sessionID: 'ses_clean' }));
  const injected = open.resolver.resolve(open.event({
    sessionID: 'ses_injected',
    cost: 999,
    costUsd: 999,
    message: { cost: 999 },
    usage: { cost: 999 },
  }));
  assert.match(clean.receiptText, /\test\. \$/);
  assert.equal(injected.spend, clean.spend, 'the invented cost is not counted');
  assert.match(injected.receiptText, /\test\. \$/);
});

test('a priced substitution adds a token-scaled estimate, not a raw per-million price', () => {
  const executor = MODELS.find((m) => m.id === 'dear');
  const priced = { ...executor, id: 'priced', family: 'alpha', cost: [{ input: 1, output: 1 }] };
  const { resolver, event } = setup({
    models: [executor, priced],
    policyPatch: { overrides: { build: { tier: 'heavy' } }, caps: { spendPerTaskUsd: 1 } },
  });
  const decision = resolver.resolve(event());
  assert.equal(decision.model, 'p/priced');
  const expected = 2 * DEFAULTS.caps.defaultContext / 1e6;
  assert.ok(Math.abs(decision.spend - expected) < 1e-9, `expected ${expected}, got ${decision.spend}`);
  assert.match(decision.receiptText, /\test\. \$0\.0655$/);
});

test('a 3/9 model does not permanently exhaust the spend ceiling', () => {
  const dear = MODELS.find((m) => m.id === 'dear');
  const costly = { ...dear, id: 'costly', family: 'alpha' };
  const { resolver, event } = setup({
    models: [costly],
    policyPatch: { overrides: { build: { tier: 'heavy' } }, caps: { maxSpendUsd: 5, spendPerTaskUsd: 1 } },
  });
  const decisions = Array.from({ length: 5 }, () => resolver.resolve(event()));
  assert.ok(decisions.every(Boolean), 'each dispatch still routes');
  const expected = 5 * 12 * DEFAULTS.caps.defaultContext / 1e6;
  assert.ok(Math.abs(decisions.at(-1).spend - expected) < 1e-9, `expected ${expected}, got ${decisions.at(-1).spend}`);
  assert.ok(decisions.at(-1).spend < 5, 'the ceiling is not exhausted by one priced dispatch');
});

test('a token-scaled estimate still counts against the spend ceiling', () => {
  const priced = { ...MODELS[0], id: 'priced', family: 'gamma', cost: [{ input: 1, output: 1 }] };
  const { resolver, event } = setup({
    models: [priced],
    policyPatch: { overrides: { build: { tier: 'heavy' } }, caps: { maxSpendUsd: 0.05, spendPerTaskUsd: 1 } },
  });
  assert.notEqual(resolver.resolve(event()), null);
  assert.equal(resolver.resolve(event()), null, 'the estimate still counts against the ceiling');
});

test('a single dispatch above the per-task cap inherits and logs the reason', () => {
  const dear = MODELS.find((m) => m.id === 'dear');
  const costly = { ...dear, id: 'costly', family: 'alpha' };
  const { resolver, event, logs, lines } = setup({
    models: [costly],
    policyPatch: { overrides: { build: { tier: 'heavy' } }, caps: { spendPerTaskUsd: 0.05 } },
  });
  const e = event();
  assert.equal(resolver.resolve(e), null, 'the dispatch is refused');
  assert.deepEqual(e.model, { providerID: 'p', id: 'dear' }, 'the current model is inherited');
  assert.ok(logs.some((line) => line.includes('per-task-cap-exceeded')), 'a reason is logged');
  assert.equal(lines.length, 0, 'no receipt without a substitution');
});

test('spend is per session and a second session starts clean', () => {
  const dear = MODELS.find((m) => m.id === 'dear');
  const costly = { ...dear, id: 'costly', family: 'alpha' };
  const { resolver, event } = setup({
    models: [costly],
    policyPatch: { overrides: { build: { tier: 'heavy' } }, caps: { maxSpendUsd: 100, spendPerTaskUsd: 1 } },
  });
  const first = resolver.resolve(event({ sessionID: 'ses_a' }));
  const second = resolver.resolve(event({ sessionID: 'ses_b' }));
  const perDispatch = 12 * DEFAULTS.caps.defaultContext / 1e6;
  assert.ok(Math.abs(first.spend - perDispatch) < 1e-9);
  assert.ok(Math.abs(second.spend - perDispatch) < 1e-9, 'the new session does not inherit the first session spend');
});

test('a different-family tier with an unknown executor warns and inherits', () => {
  const absent = setup({
    models: MODELS.filter((m) => m.id !== 'dear'),
    policyPatch: { roles: { known: { build: 'verify' } }, confidentiality: { freeForCode: true } },
  });
  const e = absent.event();
  assert.equal(absent.resolver.resolve(e), null);
  assert.deepEqual(e.model, { providerID: 'p', id: 'dear' });
  assert.ok(absent.logs.some((line) => line.includes('different-family-unknown')), 'no false independence claim');

  const blankFamily = setup({
    models: MODELS.map((m) => (m.id === 'dear' ? { ...m, family: '' } : m)),
    policyPatch: { roles: { known: { build: 'verify' } }, confidentiality: { freeForCode: true } },
  });
  assert.equal(blankFamily.resolver.resolve(blankFamily.event()), null);
  assert.ok(blankFamily.logs.some((line) => line.includes('different-family-unknown')));
});

test('an override model in the catalog on the same provider wins over ranking', () => {
  const { resolver, event } = setup({
    policyPatch: {
      confidentiality: { freeForCode: true },
      overrides: { build: { tier: 'medium', model: 'free-b' } },
    },
  });
  assert.equal(resolver.resolve(event()).model, 'p/free-b', 'the named model outranks the cheaper free-a');
});

test('an override model outside the catalog warns and falls back to ranking', () => {
  const missing = setup({
    policyPatch: {
      confidentiality: { freeForCode: true },
      overrides: { build: { model: 'ghost' } },
    },
  });
  assert.equal(missing.resolver.resolve(missing.event()).model, 'p/free-a', 'ranking still picks the best candidate');
  assert.ok(missing.logs.some((line) => line.includes('override-model-unavailable')));

  const otherProvider = setup({
    policyPatch: {
      confidentiality: { freeForCode: true },
      overrides: { build: { model: 'foreign' } },
    },
  });
  assert.equal(otherProvider.resolver.resolve(otherProvider.event()).model, 'p/free-a', 'a model on another provider is ignored');
  assert.ok(otherProvider.logs.some((line) => line.includes('override-model-unavailable')));
});

test('the confidentiality gate prices the band at the tier context ceiling', () => {
  const mediumRole = { roles: { known: { build: 'medium' } } };
  const dear = MODELS[2];

  const paidAtCeiling = {
    ...MODELS[0], id: 'paid-at-ceiling', family: 'alpha',
    cost: [{ input: 0, output: 0, size: 32768 }, { input: 0.5, output: 0.5, size: 131072 }],
  };
  const kept = setup({ models: [dear, paidAtCeiling], policyPatch: mediumRole });
  assert.equal(kept.resolver.resolve(kept.event())?.model, 'p/paid-at-ceiling', 'free in the first band but paid across the medium window is not gated');

  const freeAtCeiling = {
    ...MODELS[0], id: 'free-at-ceiling', family: 'alpha',
    cost: [{ input: 0.5, output: 0.5, size: 32768 }, { input: 0, output: 0, size: 131072 }],
  };
  const dropped = setup({ models: [dear, freeAtCeiling], policyPatch: mediumRole });
  assert.equal(dropped.resolver.resolve(dropped.event()), null, 'free across the medium window is gated');
  assert.ok(dropped.logs.some((line) => line.includes('confidentiality-free-blocked')));
});

test('the spend estimate prices the band at the expected token count', () => {
  // Small band is cheap, the band covering defaultContext is dear. Both pass
  // the medium price caps; only the band chosen by the estimate decides the cap.
  const banded = {
    ...MODELS[0], id: 'banded', family: 'alpha',
    cost: [{ input: 0.01, output: 0, size: 4096 }, { input: 0.5, output: 0.5, size: 32768 }],
  };
  const base = { confidentiality: { freeForCode: true }, caps: { defaultContext: 32768 } };

  const overCap = setup({ models: [banded], policyPatch: { ...base, caps: { ...base.caps, spendPerTaskUsd: 0.02 } } });
  const e = overCap.event();
  assert.equal(overCap.resolver.resolve(e), null, 'the ceiling band pushes the estimate over the per-task cap');
  assert.deepEqual(e.model, { providerID: 'p', id: 'dear' });
  assert.ok(overCap.logs.some((line) => line.includes('per-task-cap-exceeded')));

  const withinCap = setup({ models: [banded], policyPatch: { ...base, caps: { ...base.caps, spendPerTaskUsd: 0.05 } } });
  const decision = withinCap.resolver.resolve(withinCap.event());
  assert.equal(decision.model, 'p/banded');
  const expected = 1.0 * 32768 / 1e6;
  assert.ok(Math.abs(decision.spend - expected) < 1e-9, `expected ${expected}, got ${decision.spend}`);
});
