// oc-dispatch — the ordering, in one place.
//
// The `experimental.model.resolve` hook is synchronous and mutates `event.model`.
// The live event carries only {sessionID, agent, kind, model}; tier and cost
// inputs come from policy and the catalog, never from invented event fields.
// `resolve` gates first on mode, then picks a tier from agent role and the
// policy context constraint, filters the live catalog to that tier, applies the
// verifier-family rule, honours a valid model override, ranks the survivors,
// and either inherits (null), logs (shadow) or substitutes and writes one
// receipt line (enforce). No candidate, an empty catalog, an over-budget
// session and an over-cap dispatch all inherit the agent's own model.
import { FAST_KINDS, taskTier } from './policy.mjs';
import { filterCandidates, findModel, pickTier, rank, tokenPrice, unitCost } from './catalog.mjs';
import { formatLine } from './receipt.mjs';

// Choosing order for adequate tiers. Heavy is outside it: it is opt-in only
// through a role or override, and always subject to its own price caps.
const TIER_ORDER = { fast: 0, medium: 1, verify: 2 };

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
  // Spend is a ledger per session, not one process-wide number. A session's
  // ledger starts clean at its first dispatch and only that session's
  // dispatches add to it.
  const spends = new Map();
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
      const sessionID = typeof event.sessionID === 'string' && event.sessionID ? event.sessionID : '';
      const spent = spends.get(sessionID) ?? 0;
      if (spent >= Number(caps.maxSpendUsd ?? Infinity)) return null;

      const agent = typeof event.agent === 'string' ? event.agent : '';
      const kind = typeof event.kind === 'string' ? event.kind : 'primary';
      // The live event has no agent config: role and tier come from routing.
      const roleTier = taskTier(currentPolicy, agent, null, kind);
      // The live event has no context: the policy's default context is the
      // declared constraint that sets the choosing floor.
      const contextTier = pickTier(currentPolicy, caps.defaultContext ?? 0);
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
      const candidates = filterCandidates(list, spec, { providerID: incoming.providerID, caps, spend: spent, banked });
      let pool = candidates;
      if (tier === 'verify' || spec.differentFamily === true) {
        // Independence cannot be claimed without a known executor family.
        if (!executor || !executor.family) {
          say(`[oc-dispatch] different-family-unknown tier=${tier}`);
          return null;
        }
        pool = candidates.filter((m) => m.family !== executor.family);
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

      // A named override wins only when it is an eligible model on the caller's
      // provider. A stale or foreign name warns and drops back to ranking.
      const override = currentPolicy?.overrides?.[agent];
      const overrideModel = typeof override?.model === 'string' ? override.model : '';
      const forced = overrideModel
        ? pool.find((m) => m.providerID === incoming.providerID && m.modelID === overrideModel)
        : null;
      if (overrideModel && !forced) {
        say(`[oc-dispatch] override-model-unavailable agent=${agent} model=${overrideModel}`);
      }
      const chosen = forced ?? rank(pool, { grades, taskClass, spec })[0];
      if (!chosen) return null;
      if (chosen.providerID === incoming.providerID && chosen.modelID === incoming.id) return null;

      // A token price is per million tokens; the policy's default context is
      // the estimated token count. No real cost exists on the live event, so
      // every spend figure is an estimate.
      const estimatedTokens = Number(caps.defaultContext ?? 0);
      const increment = Number(tokenPrice(chosen) ?? 0) * estimatedTokens / 1e6;
      const perTaskCap = Number(caps.spendPerTaskUsd ?? Infinity);
      if (increment > perTaskCap) {
        say(`[oc-dispatch] per-task-cap-exceeded tier=${tier} estimate=$${increment.toFixed(4)} cap=$${perTaskCap.toFixed(4)}`);
        return null;
      }
      const sessionSpend = spent + increment;
      spends.set(sessionID, sessionSpend);

      const decision = {
        model: `${chosen.providerID}/${chosen.modelID}`,
        tier,
        reason: FAST_KINDS.includes(kind) ? `kind:${kind}` : `tier:${tier}`,
        cacheAgeMs: cacheAgeMs(),
        spend: sessionSpend,
        receiptText: '',
      };
      decision.receiptText = formatLine({ ...decision, estimated: true });

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
      spend: [...spends.values()].reduce((sum, value) => sum + value, 0),
      sessions: spends.size,
      banked: typeof grades?.bankedKeys === 'function' ? grades.bankedKeys() : [],
    };
  }

  return { cacheAgeMs, resolve, setMode, setModels, setPolicy, status };
}
