// oc-dispatch — the live catalog.
//
// `ctx.model.list()` promises a list; this build answers `{ location, data }`.
// Both shapes are accepted, every location is flattened, and anything else is
// an empty catalog — which means "inherit the agent model", never a throw.
// Model ids come only from this source: no id is written in this package.
import { gradeKey } from './grade.mjs';

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const text = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const ORDER = ['fast', 'medium', 'heavy'];

function normalizeCost(cost) {
  const rows = Array.isArray(cost) ? cost : cost && typeof cost === 'object' ? [cost] : [];
  return rows.filter((row) => row && typeof row === 'object').map((row) => {
    const out = {
      input: num(row.input),
      output: num(row.output),
      cacheRead: num(row.cache?.read ?? row.cacheRead),
      cacheWrite: num(row.cache?.write ?? row.cacheWrite),
    };
    const size = row.size ?? row.tier?.size;
    if (typeof size === 'number' && Number.isFinite(size)) out.size = size;
    return out;
  });
}

/** One `Model.Info` -> the cached shape. Missing fields get honest defaults. */
function one(raw) {
  const id = text(raw.id ?? raw.modelID);
  const providerID = text(raw.providerID) || id.slice(0, Math.max(0, id.indexOf('/')));
  const modelID = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  return {
    providerID,
    modelID,
    name: text(raw.name),
    family: text(raw.family),
    status: text(raw.status, 'active'),
    enabled: raw.enabled !== false,
    released: num(raw.released),
    context: num(raw.limit?.context ?? raw.context),
    output: num(raw.limit?.output ?? raw.output),
    tools: raw.tools !== false,
    cost: normalizeCost(raw.cost),
    variants: Array.isArray(raw.variants) ? raw.variants.filter((v) => typeof v === 'string') : [],
  };
}

export function normalize(raw) {
  const lists = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (Array.isArray(item)) lists.push(item);
      else if (Array.isArray(item?.data)) lists.push(item.data);
      else if (item && typeof item === 'object' && (item.id !== undefined || item.modelID !== undefined)) lists.push([item]);
    }
  } else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.data)) lists.push(raw.data);
    else if (Array.isArray(raw.models)) lists.push(raw.models);
  }
  return lists.flat().filter((m) => m && typeof m === 'object').map(one);
}

/** A price row is present and free only when both token prices are zero. */
export function unitCost(model) {
  const row = Array.isArray(model?.cost) ? model.cost[0] : null;
  if (!row || typeof row.input !== 'number' || typeof row.output !== 'number') return null;
  return { input: row.input, output: row.output };
}

export const tokenPrice = (model) => {
  const cost = unitCost(model);
  return cost ? cost.input + cost.output : null;
};

/** Cheapest tier whose context window fits the expected context. */
export function pickTier(policy, expectedContext) {
  const want = num(expectedContext, num(policy?.caps?.defaultContext));
  for (const name of ORDER) {
    const spec = policy?.tiers?.[name];
    if (!spec) continue;
    if (want >= num(spec.contextFloor) && want <= num(spec.contextCeiling)) return name;
  }
  return 'heavy';
}

export function findModel(models, providerID, modelID) {
  return (Array.isArray(models) ? models : []).find(
    (m) => m.providerID === providerID && m.modelID === modelID,
  ) ?? null;
}

/**
 * The brief's filter: enabled, not deprecated, tools when the tier needs them,
 * context at or above the tier floor, not banked, inside price caps and budget.
 */
export function filterCandidates(models, spec, opts = {}) {
  const s = spec ?? {};
  const caps = opts.caps ?? {};
  const spend = num(opts.spend);
  // A total session budget is not a per-million-token price: the tier's own
  // maxInput/maxOutput are the price ceiling here, the session ceiling is
  // checked once in resolve.
  if (spend >= num(caps.maxSpendUsd, Infinity)) return [];
  const banked = typeof opts.banked === 'function' ? opts.banked : () => false;
  return (Array.isArray(models) ? models : []).filter((m) => {
    if (opts.providerID && m.providerID !== opts.providerID) return false;
    if (!m.enabled || m.status === 'deprecated') return false;
    if (s.requireTools && !m.tools) return false;
    if (num(m.context) < num(s.contextFloor)) return false;
    if (banked(`${m.providerID}/${m.modelID}`)) return false;
    const unit = unitCost(m);
    if (!unit) return false; // unpriced is not free
    if (unit.input > num(s.maxInput, Infinity) || unit.output > num(s.maxOutput, Infinity)) return false;
    return true;
  });
}

/**
 * Zero cost first, ranked by grade then ttft then context. Priced models rank
 * by cost per accepted task when the grade store has sampled one, else token
 * price, with the same grade and context tiebreaks.
 */
export function rank(candidates, opts = {}) {
  const grades = opts.grades ?? { get: () => null };
  const taskClass = opts.taskClass ?? 'primary';
  const gradeOf = (m) => grades.get(gradeKey(m.providerID, m.modelID, taskClass)) ?? {};
  const okRate = (g) => (num(g.samples) > 0 ? num(g.ok) / num(g.samples) : 0);
  const latency = (g) => num(g.p50, Infinity);
  const perTask = (m, g) => (num(g.taskCount) > 0 ? num(g.costSum) / num(g.taskCount) : tokenPrice(m));
  return (Array.isArray(candidates) ? candidates : []).slice().sort((a, b) => {
    const ua = unitCost(a);
    const ub = unitCost(b);
    const za = !!ua && ua.input + ua.output === 0;
    const zb = !!ub && ub.input + ub.output === 0;
    if (za !== zb) return za ? -1 : 1;
    const ga = gradeOf(a);
    const gb = gradeOf(b);
    if (za && zb) {
      const byGrade = okRate(gb) - okRate(ga);
      if (byGrade) return byGrade;
      const byTtft = latency(ga) - latency(gb);
      if (byTtft) return byTtft;
      return num(b.context) - num(a.context);
    }
    const byCost = (perTask(a, ga) ?? Infinity) - (perTask(b, gb) ?? Infinity);
    if (byCost) return byCost;
    const byGrade = okRate(gb) - okRate(ga);
    if (byGrade) return byGrade;
    const byTtft = latency(ga) - latency(gb);
    if (byTtft) return byTtft;
    return num(b.context) - num(a.context);
  });
}
