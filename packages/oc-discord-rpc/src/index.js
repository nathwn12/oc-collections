// oc-discord-rpc wiring: subscribe to lifecycle events, publish the card on a
// revision change, and leave no ghost presence behind on shutdown.
//
// This is a bare default export, not Plugin.define({...}). define is identity in
// V2, and importing @opencode/plugin would fail here: this package declares no
// dependencies. The shape is what the host executes either way.

import { createClient } from "./ipc.mjs";
import { buildActivity, planAction, gateAfterAction, normalizeInterval } from "./presence.mjs";
import { createState, applyEvent, selectSnapshot, revisionOf } from "./state.mjs";

const DEFAULT_MIN_INTERVAL_MS = 15000;
const CLEANUP_TIMEOUT_MS = 2000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const DEFAULT_SWEEP_TIMEOUT_MS = 2000;
const DEFAULT_CATALOG_TIMEOUT_MS = 2000;
const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CATALOG_COOLDOWN_MS = 60 * 1000;
// Retry the seed sweep at these gaps, then every five minutes, with a hard cap
// so a host that never opens a session stops cleanly.
const SWEEP_RETRY_DELAYS_MS = [2000, 5000, 15000, 60000];
const SWEEP_RETRY_CAP = 12;
const DEFAULT_HOLD_GRACE_MS = 5000;

// The official OpenCode mark, pinned to an immutable commit so the URL cannot
// move under a user who never configured an image. Discord's media proxy
// fetches it; an external https URL means no Art Asset upload is needed.
export const DEFAULT_LARGE_IMAGE =
  "https://raw.githubusercontent.com/anomalyco/opencode/2204311ec6e966db8d67988ab3638ad95a811a46/packages/ui/src/assets/favicon/apple-touch-icon-v3.png";

// Test seams, not public API. The offline suite swaps the wire client for a
// recorder and drives a fake clock/timer queue so the send gate can be proved
// without sleeping. Production never calls either setter.
let clientFactory = createClient;
let clock = () => Date.now();
let schedule = (fn, ms) => setTimeout(fn, ms);
let cancel = (id) => clearTimeout(id);
let sweepTimeoutMs = DEFAULT_SWEEP_TIMEOUT_MS;
let catalogTimeoutMs = DEFAULT_CATALOG_TIMEOUT_MS;
let catalogTtlMs = DEFAULT_CATALOG_TTL_MS;
let catalogCooldownMs = DEFAULT_CATALOG_COOLDOWN_MS;
let holdGraceMs = DEFAULT_HOLD_GRACE_MS;

/** @param {(opts: object) => object} fn */
export function __setClientFactory(fn) {
  clientFactory = typeof fn === 'function' ? fn : createClient;
}

// The sweep deadline is a seam for the same reason as the clock: a host RPC
// that never settles must be provable in milliseconds, not by waiting 2s.
/** @param {number|undefined} ms */
export function __setSweepTimeout(ms) {
  sweepTimeoutMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_SWEEP_TIMEOUT_MS;
}

// The model catalogue gets the same bounded treatment as the session sweep: a
// hung ctx.model.list must never hold the card on a raw id forever.
/** @param {number|undefined} ms */
export function __setCatalogTimeout(ms) {
  catalogTimeoutMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_CATALOG_TIMEOUT_MS;
}

/** @param {number|undefined} ms */
export function __setCatalogTTL(ms) {
  catalogTtlMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_CATALOG_TTL_MS;
}

/** @param {number|undefined} ms */
export function __setCatalogCooldown(ms) {
  catalogCooldownMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_CATALOG_COOLDOWN_MS;
}

// A field that disappears is held briefly so a transient cannot flap the card.
// The seam keeps the grace instant in tests.
/** @param {number|undefined} ms */
export function __setHoldGrace(ms) {
  holdGraceMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_HOLD_GRACE_MS;
}

/** @param {{now?: () => number, setTimeout?: Function, clearTimeout?: Function}} [options] */
export function __setClock(options) {
  if (!options || typeof options !== 'object') {
    clock = () => Date.now();
    schedule = (fn, ms) => setTimeout(fn, ms);
    cancel = (id) => clearTimeout(id);
    return;
  }
  clock = typeof options.now === 'function' ? options.now : () => Date.now();
  schedule = typeof options.setTimeout === 'function' ? options.setTimeout : (fn, ms) => setTimeout(fn, ms);
  cancel = typeof options.clearTimeout === 'function' ? options.clearTimeout : (id) => clearTimeout(id);
}

const counters = { failures: 0, events: 0 };

function textOf(value) {
  return typeof value === 'string' && value ? value : undefined;
}

// Session.list spans every project, so a newest-wins sweep can otherwise
// borrow a model from unrelated work. Compare directories only when both sides
// are known; a row without a location is not evidence of a mismatch.
function normalizeDirectory(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalized || undefined;
}

function numberOr(value, fallback) {
  // Zero is an explicit request to disable the gate, not a missing value.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

// A backoff sleep must end on abort. It uses the injected timer so the restart
// discipline is testable without waiting a real second.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timer;
    const onAbort = () => { try { cancel(timer); } catch {} resolve(); };
    timer = schedule(() => {
      try { signal.removeEventListener('abort', onAbort); } catch {}
      resolve();
    }, ms);
    try { signal.addEventListener('abort', onAbort, { once: true }); } catch {}
    if (signal.aborted) onAbort();
  });
}

// A stuck promise is abandoned, not awaited forever. Resolves true when the
// work settled and false when the deadline won, so a caller can trace a timeout.
function bounded(run, ms) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) { try { cancel(timer); } catch {} }
      resolve(completed);
    };
    timer = schedule(() => finish(false), ms);
    try { Promise.resolve().then(run).then(() => finish(true), () => finish(true)); }
    catch { finish(true); }
  });
}

function fail(trace, where, err) {
  counters.failures++;
  try { trace('error in ' + where + ': ' + (err && err.message ? err.message : String(err))); }
  catch { /* a broken logger is never a reason to throw into the host */ }
}

export default {
  id: 'oc-discord-rpc',
  async setup(ctx) {
    let trace = () => {};
    try {
      const o = ctx && ctx.options && typeof ctx.options === 'object' ? ctx.options : {};
      trace = (process.env.OC_DISCORD_RPC_TRACE === '1' || o.trace === true)
        ? (message) => console.log('oc-discord-rpc: ' + message)
        : () => {};

      const appId = textOf(o.appId) ?? textOf(process.env.OC_DISCORD_APP_ID);
      if (!appId || o.enabled === false) {
        // Inert is the default: one line, no factory call, no socket, no timers.
        trace('inert: set appId in plugin options or OC_DISCORD_APP_ID to enable Discord presence');
        return () => {};
      }
      if (!ctx || !ctx.event || typeof ctx.event.subscribe !== 'function') {
        trace('inert: the host exposed no event subscription');
        return () => {};
      }

      const openedAt = clock(); // once, at open time, never per turn
      const directory = ctx.location && typeof ctx.location.directory === 'string' && ctx.location.directory
        ? ctx.location.directory : undefined;
      // The host's internal app name is not the display name: it is lowercase
      // in some builds, and a card that changes case with the host looks broken.
      const appName = textOf(o.appName) ?? 'OpenCode';
      // Empirical, contrary to Discord's docs: activity.name IS honoured as the
      // header over the local IPC path (seen live with an unrelated portal app
      // id), so no registered portal app is needed for the header line.
      trace('client id ' + appId + '; activity.name is honoured as the header over local IPC');
      const interval = normalizeInterval(numberOr(o.minIntervalMs, DEFAULT_MIN_INTERVAL_MS));
      // presence reads only these options; the old per-field switches are dead
      // and are deliberately not passed on. app.version feeds large_text.
      const activityOptions = { appName };
      if (ctx && ctx.app && typeof ctx.app.version === 'string' && ctx.app.version) {
        activityOptions.appVersion = ctx.app.version;
      }
      // An explicit '' is the documented opt-out, so ?? would be wrong here:
      // it treats the empty string as absent and resurrects the default mark.
      activityOptions.largeImage = typeof o.largeImage === 'string' ? o.largeImage : DEFAULT_LARGE_IMAGE;
      if (Array.isArray(o.buttons)) activityOptions.buttons = o.buttons;
      const snapshotOptions = { appName, openedAt };

      let client;
      try {
        // No connect override: ipc.mjs owns the production dial to the local
        // Discord pipes.
        client = clientFactory({
          clientId: appId,
          pid: process.pid,
          now: () => clock(),
          log: (...args) => trace(args.map((arg) => String(arg)).join(' ')),
          minIntervalMs: interval,
          setTimeout: (fn, ms) => schedule(fn, ms),
          clearTimeout: (id) => cancel(id),
        });
      } catch (err) {
        fail(trace, 'client factory', err);
        return () => {};
      }

      const controller = new AbortController();
      let state = createState();
      let sentRevision = -1; // forces one card at boot, before any selection
      let gate = 0;
      let timer = null;
      // One catalogue snapshot per provider, not one cache slot per model.
      // Failed or empty fetches never become snapshots; the attempt stamps only
      // stop a burst of misses from hammering the host RPC.
      const catalogs = new Map();
      const catalogAttempts = new Map();
      const fetching = new Set();
      // A fresh snapshot joins the state revision so the next send replaces a
      // fallback name with the catalogue's human name.
      let nameRevision = 0;
      // The card currently on screen. A reduced card is never published
      // instantly: it waits out a short grace in case the field comes back.
      let lastSentActivity = null;
      let held = null;
      let holdTimer = null;

      function cancelTimer() {
        if (timer === undefined || timer === null) return;
        try { cancel(timer); } catch (err) { fail(trace, 'timer cancel', err); }
        timer = null;
      }

      function armTimer(ms) {
        cancelTimer(); // never leave two pending plans armed
        if (!(ms > 0) || controller.signal.aborted) return;
        try {
          timer = schedule(() => {
            timer = null;
            if (!controller.signal.aborted) pump();
          }, ms);
        } catch (err) { fail(trace, 'timer arm', err); }
      }

      function settle(value) {
        if (value && typeof value.then === 'function') {
          value.catch((err) => fail(trace, 'async client call', err));
        }
      }

      // A downgrade removes something the owner could see. Missing buttons,
      // details and state are all the same class of symptom: hold the card.
      function downgradeOf(previous, current) {
        if (!previous || !current) return '';
        if (previous.details && !current.details) return 'details line missing';
        if (previous.state && !current.state) return 'state line missing';
        if (previous.buttons && !current.buttons) return 'buttons missing';
        return '';
      }

      function cancelHold() {
        if (holdTimer === null) return;
        try { cancel(holdTimer); } catch (err) { fail(trace, 'hold timer cancel', err); }
        holdTimer = null;
        held = null;
      }

      // The grace has elapsed: publish the reduced card as settled truth.
      function publishHeld() {
        holdTimer = null;
        if (!held || controller.signal.aborted) { held = null; return; }
        const { activity, revision } = held;
        held = null;
        trace('publish downgrade after grace');
        const before = gate;
        settle(client.setActivity(activity));
        gate = gateAfterAction('send', before, gate, clock());
        sentRevision = revision;
        lastSentActivity = activity;
      }

      function findName(snapshot, ref, model) {
        const catalogID = textOf(ref?.id) ?? textOf(ref?.modelID) ?? model;
        if (!catalogID) return undefined;
        const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
        const provider = textOf(ref?.providerID);
        const scoped = provider ? rows.filter((row) => {
          const rowProvider = textOf(row && row.providerID);
          return !rowProvider || rowProvider === provider;
        }) : rows;
        const wantedModelID = textOf(ref?.modelID) ?? catalogID;
        const wantedID = textOf(ref?.id) ?? catalogID;
        const byModelID = scoped.find((row) => textOf(row?.modelID) === wantedModelID);
        const byID = scoped.find((row) => textOf(row?.id) === wantedID);
        return textOf((byModelID ?? byID)?.name);
      }

      // Resolve a human name from one bounded ctx.model.list(providerID) call.
      // A miss or a failed RPC is NOT cached as an answer: until a real snapshot
      // arrives the prettifier renders the id, which is still readable.
      function lookupName(ref, model) {
        if (!ctx.model || typeof ctx.model.list !== 'function') return undefined;
        const provider = textOf(ref?.providerID) ?? '';
        const snapshot = catalogs.get(provider);
        const name = findName(snapshot, ref, model);

        const nowMs = clock();
        const fetchedAt = snapshot && snapshot.fetchedAt;
        const attemptedAt = catalogAttempts.get(provider);
        const age = Number.isFinite(fetchedAt) ? nowMs - fetchedAt : Infinity;
        const sinceAttempt = Number.isFinite(attemptedAt) ? nowMs - attemptedAt : Infinity;
        const expired = age >= catalogTtlMs;
        const cooledMiss = age >= catalogCooldownMs && sinceAttempt >= catalogCooldownMs;
        // Expiry wins even on a hit: an old snapshot must refresh, not keep
        // serving a name forever. A miss only refreshes after the cooldown.
        if (!expired) {
          if (name) return name;
          if (!cooledMiss) return undefined;
        }
        if (fetching.has(provider)) return name;

        fetching.add(provider);
        void (async () => {
          let rows;
          try {
            let listed;
            const completed = await bounded(async () => {
              listed = await (provider ? ctx.model.list(provider) : ctx.model.list());
            }, catalogTimeoutMs);
            if (!completed) throw new Error('timed out after ' + catalogTimeoutMs + 'ms');
            rows = Array.isArray(listed) ? listed
              : Array.isArray(listed && listed.data) ? listed.data
              : Array.isArray(listed && listed.items) ? listed.items : [];
            if (!rows.length) throw new Error('empty catalogue response');
          } catch (err) {
            // Never store a failure as an answer. An older snapshot, if any,
            // stays in place; the attempt stamp only prevents a retry storm.
            catalogAttempts.set(provider, clock());
            trace('catalogue refresh failed: ' + (err && err.message ? err.message : String(err)));
            return;
          } finally {
            fetching.delete(provider);
          }
          catalogs.set(provider, { rows, fetchedAt: clock() });
          catalogAttempts.set(provider, clock());
          trace('catalogue fetched ' + rows.length + ' rows for ' + (provider || 'all providers'));
          if (!controller.signal.aborted) {
            nameRevision++;
            pump();
          }
        })();
        return undefined;
      }

      // One plan per revision bump. A wait arms exactly one timer; a send never
      // waits for a previous one because the client coalesces pending activity.
      function pump() {
        try {
          cancelTimer();
          const nowMs = clock();
          const pre = selectSnapshot(state, snapshotOptions);
          let modelName;
          if (pre.model) modelName = lookupName(pre.modelRef, pre.model);
          const snapshot = selectSnapshot(state, { ...snapshotOptions, modelName: modelName || undefined });
          const built = buildActivity(snapshot, activityOptions);
          const desired = built.activity !== null && built.activity !== undefined;
          const revision = revisionOf(state) + '#' + nameRevision;
          // A clear is never held; it goes out at once. A reduced card is held
          // instead of published: the previous payload stays on screen while
          // the field may still come back. A newer plan supersedes the hold.
          if (!desired) {
            cancelHold();
          } else {
            const missing = downgradeOf(lastSentActivity, built.activity);
            if (missing) {
              cancelHold();
              held = { activity: built.activity, revision };
              trace('hold downgrade: ' + missing);
              try {
                holdTimer = schedule(() => { holdTimer = null; publishHeld(); }, holdGraceMs);
              } catch (err) {
                fail(trace, 'hold timer arm', err);
                publishHeld();
              }
              return;
            }
            if (held) {
              trace('hold released: field returned');
              cancelHold();
            }
          }

          const decision = planAction({
            desired,
            revision,
            sentRevision,
            lastSentMs: gate,
            intervalMs: interval,
          }, nowMs);
          trace('plan ' + decision.action + ': ' + built.reason);

          if (decision.action === 'send') {
            const before = gate;
            settle(client.setActivity(built.activity));
            gate = gateAfterAction('send', before, gate, nowMs);
            sentRevision = revision;
            lastSentActivity = built.activity;
          } else if (decision.action === 'clear') {
            settle(client.clearActivity());
            gate = 0;
            sentRevision = revision;
            lastSentActivity = null;
          } else if (decision.action === 'wait') {
            armTimer(decision.waitMs);
          }
        } catch (err) {
          fail(trace, 'plan', err);
        }
      }

      // A seed sweep that finds nothing is retried on a bounded schedule. One
      // timer at most, one sweep in flight, and a live model event cancels the
      // whole schedule. Every retry uses the same bounded sweep below.
      let sweepRetryTimer = null;
      let sweepAttempt = 0;
      let sweepRunning = false;

      function cancelSweepRetries() {
        if (sweepRetryTimer === null) return;
        try { cancel(sweepRetryTimer); } catch (err) { fail(trace, 'sweep retry cancel', err); }
        sweepRetryTimer = null;
      }

      function hasModel() {
        return Boolean(selectSnapshot(state, snapshotOptions).model);
      }

      function armSweepRetry() {
        if (controller.signal.aborted || sweepRetryTimer !== null || sweepRunning || hasModel()) return;
        if (sweepAttempt >= SWEEP_RETRY_CAP) {
          trace('sweep retries exhausted');
          return;
        }
        const ms = sweepAttempt < SWEEP_RETRY_DELAYS_MS.length
          ? SWEEP_RETRY_DELAYS_MS[sweepAttempt] : 300000;
        sweepAttempt++;
        try {
          sweepRetryTimer = schedule(() => {
            sweepRetryTimer = null;
            if (!controller.signal.aborted) void runSweepRetry();
          }, ms);
        } catch (err) { fail(trace, 'sweep retry arm', err); }
      }

      async function runSweepRetry() {
        if (sweepRunning || controller.signal.aborted) return;
        sweepRunning = true;
        let seeded;
        try {
          seeded = await sweep();
        } finally {
          sweepRunning = false;
        }
        if (controller.signal.aborted) return;
        if (seeded) {
          cancelSweepRetries();
          trace('sweep retry ' + sweepAttempt + ' seeded ' + seeded);
          pump();
        } else {
          armSweepRetry();
        }
      }

      // The host boots plugins into a session that is already open, so its
      // session.created fired before we subscribed. One sweep at setup recovers
      // that model; a live event still wins afterwards. Same discipline as
      // oc-title: isolated, shape-tolerant, and wholly inside try/catch so a
      // host that changes its API cannot break setup.
      async function sweep(scoped = true) {
        if (!ctx.session || typeof ctx.session.list !== 'function') return null;
        try {
          // An RPC that never settles must not hold plugin activation open: the
          // host awaits setup, so the sweep is bounded and only an optimisation.
          let listed;
          const completed = await bounded(async () => {
            // Only the directory comes from the context. With none there is no
            // scope to ask for, so keep the original unqualified call.
            const query = {};
            if (directory && scoped) {
              query.directory = directory;
              query.order = 'desc';
              query.limit = 50;
            }
            listed = await ctx.session.list(query);
          }, sweepTimeoutMs);
          if (!completed) {
            trace('session sweep timed out after ' + sweepTimeoutMs + 'ms; continuing without a seed');
            return null;
          }
          const rows = Array.isArray(listed) ? listed
            : Array.isArray(listed && listed.data) ? listed.data
            : Array.isArray(listed && listed.items) ? listed.items : [];
          const wanted = scoped ? normalizeDirectory(directory) : undefined;
          let newest;
          let newestAt = -Infinity;
          for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const id = textOf(row.id) ?? textOf(row.sessionID);
            if (!id) continue;
            // Only a row that actually carries a model can seed the card.
            if (row.model === undefined || row.model === null) continue;
            const rowDirectory = normalizeDirectory(row.location && row.location.directory);
            if (wanted && rowDirectory && wanted !== rowDirectory) continue;

            // A child is work inside a turn, never the card's owner.
            if (textOf(row.parentID) ?? textOf(row.parent_id)) continue;
            const time = row.time && typeof row.time === 'object' ? row.time : {};
            const at = typeof time.updated === 'number' ? time.updated
              : typeof time.created === 'number' ? time.created : 0;
            if (at > newestAt) { newestAt = at; newest = { row, id }; }
          }
          if (!newest) {
            // The directory is a preference, not a filter that may empty the
            // result: one unfiltered pass before concluding there is no model.
            if (scoped && directory && wanted) {
              trace('session sweep found no scoped model; retrying unfiltered');
              return sweep(false);
            }
            return null;
          }
          trace('sweep seeded model from ' + newest.id);
          state = applyEvent(state, {
            type: 'session.created',
            data: {
              sessionID: newest.id,
              title: newest.row.title,
              agent: newest.row.agent,
              model: newest.row.model,
            },
          }, clock());
          return newest.id;
        } catch (err) {
          fail(trace, 'session sweep', err);
          return null;
        }
      }

      const initialSeed = await sweep();
      try { client.start(); } catch (err) { fail(trace, 'client start', err); }
      pump();
      if (!initialSeed) armSweepRetry();

      void (async () => { // Restart the subscription on end or error until aborted.
        let delay = BACKOFF_START_MS;
        while (!controller.signal.aborted) {
          try {
            for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
              if (controller.signal.aborted) break;
              counters.events++;
              delay = BACKOFF_START_MS;
              try {
                state = applyEvent(state, event, clock());
                if (hasModel()) cancelSweepRetries();
                pump();
              } catch (err) {
                fail(trace, 'event', err);
              }
            }
            if (controller.signal.aborted) break;
            trace('subscription ended; restarting');
          } catch (err) {
            if (controller.signal.aborted) break;
            fail(trace, 'subscription', err);
          }
          await sleep(delay, controller.signal);
          delay = Math.min(delay * 2, BACKOFF_MAX_MS);
        }
      })();

      return async () => { // Abort, cancel, clear, then stop with a deadline.
        try { controller.abort(); } catch (err) { fail(trace, 'abort', err); }
        cancelTimer();
        cancelSweepRetries();
        cancelHold();
        try { settle(client.clearActivity()); } catch (err) { fail(trace, 'clear', err); }
        try { await bounded(() => client.stop(), CLEANUP_TIMEOUT_MS); }
        catch (err) { fail(trace, 'stop', err); }
      };
    } catch (err) {
      fail(trace, 'setup', err);
      return () => {};
    }
  },
};
