// oc-dispatch — the ordering, in one place.
//
// The `experimental.model.resolve` hook is synchronous and mutates `event.model`.
// `resolve` gates first on mode, then picks a tier from task class and expected
// context, filters the live catalog to that tier, applies the verifier-family
// rule, ranks the survivors, and either inherits (null), logs (shadow) or
// substitutes and writes one receipt line (enforce). No candidate, an empty
// catalog and an over-budget session all inherit the agent's own model.
import { FAST_KINDS, taskTier } from './policy.mjs';
import { filterCandidates, findModel, pickTier, rank, tokenPrice, unitCost } from './catalog.mjs';
import { formatLine } from './receipt.mjs';

// Choosing order for adequate tiers. Heavy is outside it: it is opt-in only
// through a role or override, and always subject to its own price caps.
const TIER_ORDER = { fast: 0, medium: 1, verify: 2 };

/** A real message cost, when the host put one on the event; null otherwise. */
function realCost(event) {
  const candidates = [event?.cost, event?.costUsd, event?.message?.cost, event?.usage?.cost];
  return candidates.find((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) ?? null;
}

export function createResolver({
  policy,
  models,
  grades,
  log = () => {},
  append = () => {},
  logPath = '',
  now = Date.now,
} = {}) {
  let currentPolicy = policy;
  let list = Array.isArray(models) ? models : [];
  let cacheAt = now();
  let spend = 0;
  let spendEstimate = 0;
  let spendActual = 0;
  let hasActual = false;
  let mode = currentPolicy?.mode ?? 'off';

  function setPolicy(next) {
    currentPolicy = next;
    mode = next?.mode ?? 'off';
  }
  function setMode(next) {
    if (['off', 'shadow', 'enforce'].includes(next)) mode = next;
  }
  function setModels(next) {
    list = Array.isArray(next) ? next : [];
    cacheAt = now();
  }
  function cacheAgeMs() {
    return Math.max(0, now() - cacheAt);
  }
  const say = (line) => {
    try {
      log(String(line));
    } catch {
      /* logging is never load-bearing */
    }
  };

  function resolve(event) {
    try {
      if (mode === 'off') return null;
      const incoming = event?.model;
      if (!incoming || typeof incoming.id !== 'string' || typeof incoming.providerID !== 'string') return null;
      const caps = currentPolicy?.caps ?? {};
      const actual = realCost(event);
      if (spend >= Number(caps.maxSpendUsd ?? Infinity)) return null;

      const agent = typeof event.agent === 'string' ? event.agent : '';
      const kind = typeof event.kind === 'string' ? event.kind : 'primary';
      const roleTier = taskTier(currentPolicy, agent, event.agentConfig, kind);
      const contextTier = pickTier(currentPolicy, event.context ?? caps.defaultContext ?? 0);
      // Heavy is opt-in through a role or override; a large context raises the
      // choosing floor to verify, never silently to the heavy price band.
      const contextFloorTier = contextTier === 'heavy' ? 'verify' : contextTier;
      const tier = FAST_KINDS.includes(kind)
        ? 'fast'
        : roleTier === 'heavy'
          ? 'heavy'
          : (TIER_ORDER[roleTier] ?? 1) >= (TIER_ORDER[contextFloorTier] ?? 1) ? roleTier : contextFloorTier;
      const spec = currentPolicy?.tiers?.[tier];
      if (!spec) return null;

      const executor = findModel(list, incoming.providerID, incoming.id);
      const taskClass = kind;
      const banked = (key) => (typeof grades?.isBanked === 'function' ? grades.isBanked(`${key}#${taskClass}`) : false);
      const candidates = filterCandidates(list, spec, { providerID: incoming.providerID, caps, spend, banked });
      let pool = candidates;
      if (tier === 'verify' || spec.differentFamily === true) {
        pool = candidates.filter((m) => !executor || m.family !== executor.family);
        if (!pool.length) {
          say(`[oc-dispatch] verify-no-independent-family tier=${tier}`);
          return null;
        }
      }
      // Code-carrying tiers do not spend a free model's context on a prompt
      // that may contain source. Fast reads are never gated; a stored provider
      // opt-in is the only way through.
      const confidentiality = currentPolicy?.confidentiality ?? {};
      const gatedCode = !FAST_KINDS.includes(kind) && kind === 'primary' &&
        (tier === 'medium' || tier === 'verify') && confidentiality.freeForCode === false;
      if (gatedCode) {
        const optedIn = Array.isArray(confidentiality.freeForCodeProviders) &&
          confidentiality.freeForCodeProviders.includes(incoming.providerID);
        if (!optedIn) {
          pool = pool.filter((m) => {
            const unit = unitCost(m);
            return !!unit && unit.input + unit.output > 0;
          });
          if (!pool.length) {
            say(`[oc-dispatch] confidentiality-free-blocked tier=${tier}`);
            return null;
          }
        }
      }
      if (!pool.length) return null;

      const chosen = rank(pool, { grades, taskClass })[0];
      if (!chosen) return null;
      if (chosen.providerID === incoming.providerID && chosen.modelID === incoming.id) return null;

      const increment = actual ?? Number(tokenPrice(chosen) ?? 0);
      spend += increment;
      if (actual === null) spendEstimate += increment;
      else {
        spendActual += increment;
        hasActual = true;
      }

      const decision = {
        model: `${chosen.providerID}/${chosen.modelID}`,
        tier,
        reason: FAST_KINDS.includes(kind) ? `kind:${kind}` : `tier:${tier}`,
        cacheAgeMs: cacheAgeMs(),
        spend,
        spendEstimate,
        spendActual: hasActual ? spendActual : null,
        spendIsEstimate: actual === null,
        receiptText: '',
      };
      decision.receiptText = formatLine({ ...decision, estimated: actual === null });

      if (mode === 'shadow') {
        say(`[oc-dispatch] shadow ${decision.receiptText}`);
        return decision;
      }
      // Enforce: same provider only, and keep the caller's variant when present.
      event.model = {
        providerID: chosen.providerID,
        id: chosen.modelID,
        ...(incoming.variant ? { variant: incoming.variant } : {}),
      };
      try {
        append(logPath, decision.receiptText);
      } catch {
        /* a failed receipt never undoes the substitution */
      }
      return decision;
    } catch {
      return null; // resolution never fails a request
    }
  }

  function status() {
    return {
      mode,
      cacheAgeMs: cacheAgeMs(),
      models: list.length,
      spend,
      spendEstimate,
      spendActual: hasActual ? spendActual : null,
      banked: typeof grades?.bankedKeys === 'function' ? grades.bankedKeys() : [],
    };
  }

  return { cacheAgeMs, resolve, setMode, setModels, setPolicy, status };
}
