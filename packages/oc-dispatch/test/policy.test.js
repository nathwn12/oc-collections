import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS, loadPolicy, merge, resolveRole, taskTier, validate } from '../src/policy.mjs';

const ROUTING = path.join(import.meta.dirname, '..', 'routing.json');

test('defaults are dormant and carry only constraints, never model ids', () => {
  assert.equal(DEFAULTS.mode, 'off');
  assert.deepEqual(Object.keys(DEFAULTS).sort(), [
    'caps', 'confidentiality', 'mode', 'overrides', 'quality', 'roles', 'seedTiers', 'tiers', 'version',
  ]);
  assert.deepEqual(Object.keys(DEFAULTS.tiers).sort(), ['fast', 'heavy', 'medium', 'verify']);
  const shape = JSON.stringify(DEFAULTS.tiers);
  assert.doesNotMatch(shape, /providerID|modelID|"[a-z0-9-]+\/[a-z0-9-]+"/i, 'tiers hold constraints, not model ids');
  assert.equal(DEFAULTS.confidentiality.freeForCode, false);
  assert.deepEqual(DEFAULTS.seedTiers, []);
  assert.deepEqual(DEFAULTS.overrides, {});
  assert.deepEqual(JSON.parse(readFileSync(ROUTING, 'utf8')), DEFAULTS, 'shipped file must equal the default');
});

test('loadPolicy is a report, never a throw', () => {
  const good = loadPolicy(JSON.stringify({ mode: 'shadow', caps: { maxSpendUsd: 1 } }));
  assert.equal(good.policy.mode, 'shadow');
  assert.equal(good.policy.caps.maxSpendUsd, 1);
  assert.equal(good.policy.caps.defaultContext, DEFAULTS.caps.defaultContext, 'unset fields keep their default');
  assert.deepEqual(good.errors, []);

  const bad = loadPolicy('{not json');
  assert.equal(bad.policy.mode, 'off');
  assert.match(bad.errors[0], /not readable JSON/);

  const invalid = loadPolicy(JSON.stringify({ mode: 'loud' }));
  assert.equal(invalid.policy.mode, 'loud', 'the raw value is kept for inspection');
  assert.match(invalid.errors.join(' '), /mode must be off, shadow or enforce/);
});

test('validate names the broken field for every bad shape', () => {
  assert.equal(validate(DEFAULTS).ok, true);
  const verdict = validate({
    ...DEFAULTS,
    version: 'one',
    tiers: { ...DEFAULTS.tiers, fast: { contextFloor: 10, contextCeiling: 1, maxInput: 'x', maxOutput: 1 } },
    caps: { ...DEFAULTS.caps, maxSpendUsd: -1 },
    roles: { known: [], bare: {} },
    seedTiers: {},
  });
  assert.equal(verdict.ok, false);
  for (const part of ['version', 'contextCeiling', 'maxInput', 'maxSpendUsd', 'roles', 'seedTiers']) {
    assert.ok(verdict.errors.some((e) => e.includes(part)), 'expected an error naming ' + part + ': ' + verdict.errors);
  }
});

test('merge is deep for objects and replaces arrays', () => {
  const out = merge(DEFAULTS, { caps: { maxSpendUsd: 2 }, roles: { known: { build: 'fast' } }, seedTiers: ['x'] });
  assert.equal(out.caps.maxSpendUsd, 2);
  assert.equal(out.caps.defaultContext, DEFAULTS.caps.defaultContext);
  assert.deepEqual(out.roles.known, { build: 'fast' });
  assert.deepEqual(out.roles.bare, {});
  assert.deepEqual(out.seedTiers, ['x']);
  assert.equal(DEFAULTS.caps.maxSpendUsd, 5, 'the base is not mutated');
});

test('role precedence is known, inferred, bare, medium', () => {
  const policy = merge(DEFAULTS, { roles: { known: { build: 'heavy' }, bare: { ghost: 'fast' } } });
  assert.equal(resolveRole(policy, 'build', { tier: 'fast' }), 'heavy', 'known wins');
  assert.equal(resolveRole(policy, 'review', { tier: 'verify' }), 'verify', 'inference is next');
  assert.equal(resolveRole(policy, 'ghost', null), 'fast', 'bare is next');
  assert.equal(resolveRole(policy, 'unknown', null), 'medium', 'the last resort is medium');
  assert.equal(taskTier(policy, 'build', null, 'title'), 'fast', 'cosmetic kinds always go fast');
  assert.equal(taskTier(merge(DEFAULTS, { overrides: { build: { tier: 'heavy' } } }), 'build', null, 'primary'), 'heavy');
});
