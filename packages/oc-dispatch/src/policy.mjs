// oc-dispatch — the policy contract.
//
// One shape, one default, one validator. Tier values are constraint objects,
// never model ids: the live catalog is the only source of ids. A bad file never
// throws; it falls back field by field through `merge` and reports its errors.
export const MODES = ['off', 'shadow', 'enforce'];
export const TIERS = ['fast', 'medium', 'verify', 'heavy'];
export const FAST_KINDS = ['title', 'summary', 'compaction', 'generate'];

export const DEFAULTS = {
  version: 1,
  mode: 'off',
  quality: { minSamples: 3, okRateFloor: 0.8, ttftFloorMs: 0 },
  tiers: {
    fast: { contextFloor: 0, contextCeiling: 32768, maxInput: 0.2, maxOutput: 0.8, requireTools: false, differentFamily: false },
    medium: { contextFloor: 0, contextCeiling: 131072, maxInput: 0.6, maxOutput: 2.4, requireTools: true, differentFamily: false },
    verify: { contextFloor: 0, contextCeiling: 131072, maxInput: 1.2, maxOutput: 4.8, requireTools: true, differentFamily: true },
    heavy: { contextFloor: 131072, contextCeiling: 1000000, maxInput: 3, maxOutput: 12, requireTools: true, differentFamily: false },
  },
  caps: { defaultContext: 32768, maxSpendUsd: 5, spendPerTaskUsd: 0.05, catalogTTLMs: 30000 },
  confidentiality: { freeForCode: false },
  roles: { known: {}, bare: {} },
  seedTiers: [],
  overrides: {},
};

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Deep merge of plain objects; arrays and scalars in `override` replace. */
export function merge(base, override) {
  if (!isPlain(override)) return override === undefined ? base : override;
  const out = isPlain(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlain(value) ? merge(out[key], value) : value;
  }
  return out;
}

/** Validation is a report, never a throw. One error per broken field. */
export function validate(policy) {
  const errors = [];
  const p = isPlain(policy) ? policy : {};
  if (!Number.isInteger(p.version)) errors.push('version must be an integer');
  if (!MODES.includes(p.mode)) errors.push('mode must be off, shadow or enforce');
  if (!isPlain(p.tiers)) errors.push('tiers must be an object');
  else {
    for (const name of TIERS) {
      const spec = p.tiers[name];
      if (!isPlain(spec)) {
        errors.push(`tiers.${name} must be a constraint object`);
        continue;
      }
      for (const key of ['contextFloor', 'contextCeiling', 'maxInput', 'maxOutput']) {
        if (!isNumber(spec[key])) errors.push(`tiers.${name}.${key} must be a non-negative number`);
      }
      if (isNumber(spec.contextFloor) && isNumber(spec.contextCeiling) && spec.contextCeiling < spec.contextFloor) {
        errors.push(`tiers.${name}.contextCeiling is below its floor`);
      }
    }
  }
  if (!isPlain(p.caps)) errors.push('caps must be an object');
  else {
    for (const key of ['defaultContext', 'maxSpendUsd', 'spendPerTaskUsd', 'catalogTTLMs']) {
      if (!isNumber(p.caps[key])) errors.push(`caps.${key} must be a non-negative number`);
    }
  }
  if (!isPlain(p.quality)) errors.push('quality must be an object');
  if (!isPlain(p.confidentiality) || typeof p.confidentiality.freeForCode !== 'boolean') {
    errors.push('confidentiality.freeForCode must be a boolean');
  }
  if (!isPlain(p.roles) || !isPlain(p.roles.known) || !isPlain(p.roles.bare)) {
    errors.push('roles.known and roles.bare must be objects');
  }
  if (!Array.isArray(p.seedTiers)) errors.push('seedTiers must be an array');
  if (!isPlain(p.overrides)) errors.push('overrides must be an object');
  return { ok: errors.length === 0, errors };
}

/** Parse a routing file over the defaults; a bad body degrades to defaults. */
export function loadPolicy(text) {
  try {
    const merged = merge(DEFAULTS, JSON.parse(text));
    const verdict = validate(merged);
    return { policy: merged, errors: verdict.errors };
  } catch {
    return { policy: structuredClone(DEFAULTS), errors: ['routing.json is not readable JSON'] };
  }
}

/** A tier named by agent config, when the config carries one. No ids here. */
export function infer(agentConfig) {
  if (!isPlain(agentConfig)) return null;
  const candidate = agentConfig.tier ?? agentConfig.role;
  return TIERS.includes(candidate) ? candidate : null;
}

/** roles.known[agent] ?? infer(agent config) ?? roles.bare[agent] ?? medium. */
export function resolveRole(policy, agent, agentConfig) {
  const roles = isPlain(policy?.roles) ? policy.roles : {};
  const known = isPlain(roles.known) ? roles.known[agent] : undefined;
  const bare = isPlain(roles.bare) ? roles.bare[agent] : undefined;
  return [known, infer(agentConfig), bare].find((v) => TIERS.includes(v)) ?? 'medium';
}

/** Cosmetic kinds always take the fast tier; an explicit override wins otherwise. */
export function taskTier(policy, agent, agentConfig, kind) {
  if (FAST_KINDS.includes(kind)) return 'fast';
  const override = isPlain(policy?.overrides) ? policy.overrides[agent] : null;
  if (isPlain(override) && TIERS.includes(override.tier)) return override.tier;
  return resolveRole(policy, agent, agentConfig);
}
