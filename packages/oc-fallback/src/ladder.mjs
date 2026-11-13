/**
 * oc-fallback - the ladder half: one tool, one automatic behaviour.
 *
 * `switch_model` is the only thing the model is offered. `experimental.model.resolve`
 * is the only thing that happens on its own: when the host records a failure, the
 * next request for that session is served one rung further down, on the same
 * provider. Nothing else is registered.
 *
 * The seat is learned, not guessed. The resolve hook carries `{ sessionID, agent,
 * kind, model }`; the tool's execute context carries `sessionID` and no agent. So
 * resolve stores the agent in a Map keyed by sessionID and the tool reads it back
 * — the mechanism this plugin has always used, because there is no other.
 *
 * A rung must pass every rule in `config.rules` before it is served or switched to:
 * same provider, never `-free`, present in the live catalog, a published benchmark,
 * inside the price caps, and no dearer than the pinned model. A rule is refused the
 * same way from the tool and from the automatic path; the only difference is that
 * the tool answers with the reason and the automatic path logs it and stays put.
 */
import { killSwitch, splitModel } from './config.mjs';
import { formatLine } from './log.mjs';

/** A model whose id says it is free is out of the ladder, whatever it costs. */
const FREE_RE = /(?:^|[-._])free(?:$|[-._])/i;

const DESCRIPTION =
  "Step down this agent seat's model fallback ladder when the current model fails. " +
  'No arguments moves one rung down; `rung` jumps to an absolute rung (0 is the pinned model); ' +
  "`model` names an explicit provider/model that must already be on this seat's ladder; " +
  '`list` prints the ladder and the current rung and changes nothing. ' +
  'Only models on the same provider as the current session are allowed.';

const INPUT = {
  type: 'object',
  properties: {
    rung: { type: 'integer', description: 'absolute rung on your ladder; 0 = the pinned model' },
    model: { type: 'string', description: 'explicit provider/model id; must be on your ladder' },
    list: { type: 'boolean', description: 'print the ladder and current rung, change nothing' },
  },
  additionalProperties: false,
};

/** Catalog entries are per-1M-token prices; the first entry is the base tier. */
function baseCost(model) {
  const entry = Array.isArray(model?.cost) ? model.cost.find((c) => c && typeof c === 'object') : null;
  if (!entry || typeof entry.input !== 'number' || typeof entry.output !== 'number') return null;
  return { input: entry.input, output: entry.output };
}

/**
 * The router. `ctx` is the plugin context (or a fake of it) and is used only for
 * `session.switchModel`, `model.list` and nothing else. `benchmark` answers
 * `{ state }` for a model id, and is the one seam the tests replace.
 */
export function createRouter({ config, ladders, ctx, log = () => {}, now = Date.now, benchmark, catalogTTLMs = 5000 }) {
  /** sessionID -> { agent, rung, model, failure } */
  const sessions = new Map();
  let catalog = null; // { at, byId: Map<id, entry> }

  const rules = config.rules;
  const say = (fields) => {
    try {
      log(formatLine(fields));
    } catch {
      /* logging is never load-bearing */
    }
  };

  const remember = (sessionID, state) => {
    if (sessions.size >= 500 && !sessions.has(sessionID)) {
      const oldest = sessions.keys().next();
      if (!oldest.done) sessions.delete(oldest.value);
    }
    sessions.set(sessionID, state);
  };

  async function listCatalog(force) {
    if (!force && catalog && now() - catalog.at < catalogTTLMs) return catalog.byId;
    // The docs promise a list; this build answers `{ location, data }`. Accept
    // either and treat anything else as "no models" rather than throwing.
    const raw = await ctx.model.list();
    const models = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
    const byId = new Map();
    for (const model of models) {
      if (!model || model.providerID !== config.provider || typeof model.id !== 'string') continue;
      byId.set(model.id, model);
    }
    catalog = { at: now(), byId };
    return byId;
  }

  /** A miss always earns one refresh, so a dead cache cannot fake an absence. */
  async function lookup(id) {
    const hit = (await listCatalog(false)).get(id);
    if (hit) return hit;
    return (await listCatalog(true)).get(id) ?? null;
  }

  async function costOf(id) {
    const model = await lookup(id);
    return model ? baseCost(model) : null;
  }

  /**
   * The rule chain for one rung. Returns `{ ok: true }` or
   * `{ ok: false, error, rule? }` — never throws, never switches anything.
   */
  async function admit(modelID, pinnedID) {
    const parsed = splitModel(modelID);
    if (!parsed) return { ok: false, error: 'not-on-ladder' };
    if (parsed.providerID !== config.provider) return { ok: false, error: 'cross-provider' };
    if (rules.excludeFree && FREE_RE.test(parsed.id)) return { ok: false, error: 'free-model' };

    if (!(await lookup(parsed.id))) return { ok: false, error: 'not-available' };

    if (rules.requirePublishedBenchmark) {
      const result = await benchmark(modelID);
      if (result?.state === 'zero') {
        return { ok: false, error: 'no-benchmark', rule: 'requirePublishedBenchmark' };
      }
      if (result?.state !== 'benchmarked') {
        say({ reason: `benchmark-skip:${result?.reason ?? 'unknown'}`, to: modelID });
      }
    }

    const cost = await costOf(parsed.id);
    if (!cost) {
      // Unpriced is not free: the cap is skipped and said so, never guessed.
      say({ reason: 'price-skip:unpriced', to: modelID });
      return { ok: true };
    }
    if (rules.maxInputUsd !== null && cost.input > rules.maxInputUsd) {
      return { ok: false, error: 'over-price', rule: 'maxInputUsd' };
    }
    if (rules.maxOutputUsd !== null && cost.output > rules.maxOutputUsd) {
      return { ok: false, error: 'over-price', rule: 'maxOutputUsd' };
    }
    if (rules.rungMayNotCostMoreThanPinned && pinnedID && pinnedID !== modelID) {
      const pinned = splitModel(pinnedID);
      const base = pinned ? await costOf(pinned.id) : null;
      if (base && (cost.input > base.input || cost.output > base.output)) {
        return { ok: false, error: 'over-pinned', rule: 'rungMayNotCostMoreThanPinned' };
      }
    }
    return { ok: true };
  }

  /**
   * Every request. Learn the seat, then serve the recorded rung. A pending
   * failure moves one rung down first, and only when that rung passes the rules.
   */
  async function resolve(event) {
    try {
      const sessionID = event?.sessionID;
      const incoming = event?.model;
      if (!sessionID || !incoming || typeof incoming.id !== 'string') return;
      const current = `${incoming.providerID}/${incoming.id}`;

      let state = sessions.get(sessionID);
      if (!state) {
        state = { agent: event?.agent, rung: -1, model: current, failure: null };
        remember(sessionID, state);
      }
      if (typeof event?.agent === 'string' && event.agent) state.agent = event.agent;

      const ladder = state.agent ? ladders?.[state.agent] : undefined;
      if (!ladder) {
        state.model = current;
        return;
      }
      // Never touch a session served by another provider, and never guess.
      if (incoming.providerID !== config.provider) {
        state.model = current;
        state.rung = -1;
        return;
      }
      // Title generation is cosmetic and must not spend a rung.
      if (event?.kind === 'title') return;

      if (state.rung < 0) state.rung = ladder.indexOf(current);

      if (state.failure && rules.autoFailover) {
        const base = state.rung >= 0 ? state.rung : -1;
        const next = Math.min(base + 1, ladder.length - 1);
        const failure = state.failure;
        state.failure = null;
        if (next > base) {
          const target = ladder[next];
          const verdict = await admit(target, ladder[0]);
          if (verdict.ok) {
            say({ sessionID, agent: state.agent, from: current, to: target, reason: 'failover', error: failure });
            state.rung = next;
          } else {
            say({
              sessionID,
              agent: state.agent,
              from: current,
              to: target,
              reason: `failover-blocked:${verdict.error}`,
              error: failure,
            });
          }
        }
      } else if (state.failure) {
        state.failure = null;
      }

      const target = state.rung >= 0 ? ladder[state.rung] : current;
      state.model = target;
      if (target === current) return;
      const parsed = splitModel(target);
      if (!parsed) return;
      // Same provider, always: the incoming variant is dropped on purpose.
      event.model = { providerID: parsed.providerID, id: parsed.id };
    } catch {
      /* resolution never fails a request */
    }
  }

  /** Record a failure so the next resolve steps down; veto a retry with nothing left. */
  function recordFailure(event) {
    try {
      const sessionID = event?.sessionID;
      const state = sessionID ? sessions.get(sessionID) : undefined;
      if (!state) return;
      const agent = event?.agent || state.agent;
      const ladder = agent ? ladders?.[agent] : undefined;
      if (!ladder) return;
      if (event?.model && event.model.providerID !== config.provider) return;

      const failure = { type: event?.error?.type, status: event?.error?.status };
      state.failure = failure;
      if (typeof agent === 'string' && agent) state.agent = agent;

      if (state.rung >= ladder.length - 1) {
        if (event?.decision) event.decision = { retry: false };
        say({ sessionID, agent: state.agent, from: state.model, reason: 'retry-veto:at-floor', error: failure });
      }
    } catch {
      /* a retry hook never costs the request its retry */
    }
  }

  /** The tool. Always resolves to one uniform object, never a throw. */
  async function switchModel(input = {}, meta = {}) {
    try {
      const options = input && typeof input === 'object' ? input : {};
      const sessionID = meta?.sessionID;
      const state = sessionID ? sessions.get(sessionID) : undefined;
      const agent = state?.agent || meta?.agent;
      if (!agent) return { ok: false, error: sessionID ? 'caller-unknown' : 'unknown-agent' };

      const ladder = ladders?.[agent];
      const current = state?.model ?? null;
      if (!ladder) return { ok: false, error: 'no-ladder' };

      const rungNow = () => (state && state.rung >= 0 ? state.rung : current ? ladder.indexOf(current) : -1);

      if (options.list === true) {
        const rung = rungNow();
        return {
          ok: true,
          agent,
          rung: rung >= 0 ? rung : null,
          ladder: [...ladder],
          current,
          model: current,
        };
      }

      if (!current) return { ok: false, error: 'caller-unknown' };
      const parsedNow = splitModel(current);
      if (!parsedNow) return { ok: false, error: 'caller-unknown' };
      if (parsedNow.providerID !== config.provider) return { ok: false, error: 'cross-provider' };
      if (!sessionID) return { ok: false, error: 'caller-unknown' };

      let rung;
      if (typeof options.model === 'string' && options.model) {
        rung = ladder.indexOf(options.model);
        if (rung < 0) return { ok: false, error: 'not-on-ladder' };
      } else if (options.rung !== undefined && options.rung !== null) {
        if (!Number.isInteger(options.rung) || options.rung < 0 || options.rung >= ladder.length) {
          return { ok: false, error: 'not-on-ladder' };
        }
        rung = options.rung;
      } else {
        rung = rungNow() + 1;
        if (rung >= ladder.length) return { ok: false, error: 'at-floor' };
      }

      const target = ladder[rung];
      const verdict = await admit(target, ladder[0]);
      if (!verdict.ok) {
        say({ sessionID, agent, from: current, to: target, reason: `tool-refused:${verdict.error}` });
        return { ok: false, error: verdict.error, ...(verdict.rule ? { rule: verdict.rule } : {}), target };
      }
      const parsed = splitModel(target);
      if (!parsed) return { ok: false, error: 'not-on-ladder', target };

      await ctx.session.switchModel({ sessionID, model: { providerID: parsed.providerID, id: parsed.id } });

      const session = state ?? { agent, rung: -1, model: current, failure: null };
      session.rung = rung;
      session.model = target;
      session.failure = null;
      remember(sessionID, session);

      say({ sessionID, agent, from: current, to: target, reason: 'tool' });
      return { ok: true, agent, rung, ladder: [...ladder], current: target, model: target };
    } catch {
      return { ok: false, error: 'internal' };
    }
  }

  return { resolve, recordFailure, switchModel, sessions };
}

/**
 * Register the hook and the tool, or nothing at all. Returns the router so the
 * calling adapter can hand it a context, or null when the plugin must stay out
 * of the way: no ladders, the kill switch, `enabled: false`, or a host without
 * the surfaces this needs.
 */
export function createFallback({ config, ladders, ctx, log = () => {}, now = Date.now, benchmark, env = {} }) {
  const hasLadders = ladders && typeof ladders === 'object' && Object.keys(ladders).length > 0;
  if (!hasLadders) return null;
  if (!config?.enabled) return null;
  if (killSwitch(env)) return null;
  if (typeof ctx?.tool?.transform !== 'function') return null;
  if (typeof ctx?.session?.hook !== 'function') return null;
  if (typeof ctx?.session?.switchModel !== 'function') return null;
  if (typeof ctx?.model?.list !== 'function') return null;
  if (typeof benchmark !== 'function') return null;

  const router = createRouter({ config, ladders, ctx, log, now, benchmark });

  for (const [name, callback] of [
    ['experimental.model.resolve', (event) => router.resolve(event)],
    ['retry', (event) => router.recordFailure(event)],
  ]) {
    try {
      Promise.resolve(ctx.session.hook(name, callback)).catch(() => {});
    } catch {
      /* a host without this hook keeps the tool */
    }
  }

  try {
    Promise.resolve(
      ctx.tool.transform((editor) => {
        try {
          if (typeof editor.namespace === 'function') {
            editor.namespace({
              name: 'model',
              description: 'Model fallback: step this seat down its ladder when a model fails.',
            });
          }
        } catch {
          /* the namespace is cosmetic; the tool still registers */
        }
        try {
          editor.add({
            name: 'switch_model',
            description: DESCRIPTION,
            input: INPUT,
            options: { namespace: 'model', codemode: true },
            execute: async (input = {}, context = {}) => {
              const result = await router.switchModel(input ?? {}, {
                sessionID: context?.sessionID,
                agent: context?.agent,
              });
              return { content: JSON.stringify(result) };
            },
          });
        } catch {
          /* one rejected tool never costs the hooks */
        }
      }),
    ).catch(() => {});
  } catch {
    /* the automatic path still works without the tool */
  }

  return router;
}
