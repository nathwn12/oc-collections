// oc-talk — cross-session talk for any OpenCode harness.
//
// Two tools, and only two: `talk_send` puts one message into another session and
// `talk_inbox` reads what a session has said. The other eleven lifecycle verbs
// are gone: this package talks, it does not manage sessions.
//
// The backend is the harness's own local service, reached over HTTP with the
// credential the service already publishes. No CLI child per call, no shell, no
// secret crossing this module's public surface: `transport.mjs` resolves the
// endpoint once and is the only file that speaks to the wire.
import { randomUUID } from 'node:crypto';
import { Plugin } from '@opencode/plugin';
import { call as httpCall } from './transport.mjs';

const READ_DEFAULT_LIMIT = 20;
const READ_MAX_LIMIT = 100;
// Bounded block for `wait`: how long a caller may hold a turn waiting for the
// peer's turn boundary, and how often the newest message is re-read while it does.
const WAIT_DEFAULT_SECONDS = 0;
const WAIT_MAX_SECONDS = 600;
const POLL_INTERVAL_MS = 250;

// One live tool-transform registration per host location, keyed by location.
// The host boots this plugin once per location (workspace + directory) and each
// boot has its own tool domain, so a single module-level handle was the bug: the
// second location's setup disposed the first location's transform, and the first
// location's sessions were left with zero oc-talk tools. A reload re-runs setup
// for the same location on this cached module instance, so the map — not a
// one-shot boolean — is the truth about what is live: setup disposes only its own
// location's handle before re-registering, never another location's.
const FALLBACK_KEY = ':';
const registrations = new Map();

// The location a ctx belongs to. A ctx without a location keeps one stable
// fallback key, so a single-location host behaves exactly as before.
function locationKey(ctx) {
  const loc = ctx && ctx.location;
  if (!loc) return FALLBACK_KEY;
  return `${loc.workspaceID ?? ''}:${loc.directory}`;
}

function fail(error, reason, candidates, truncated) {
  const out = { error, reason };
  if (candidates !== undefined) out.candidates = candidates;
  if (truncated) out.truncated = true;
  return { content: JSON.stringify(out) };
}

function done(value) {
  return { content: JSON.stringify(value) };
}

// Every backend call goes through this seam so the offline suite can swap in a
// recording backend and prove the exact payload without a peer. Production never
// calls setApiRunner, so the runner is always the HTTP transport there.
let apiRunner = httpCall;

function runApi(args, opts) {
  return apiRunner(args, opts);
}

function setApiRunner(fn) {
  apiRunner = typeof fn === 'function' ? fn : httpCall;
}

const ID_RE = /^ses_/;
// Resolution follows at most this many search pages: past that the scan reports
// truncated:true instead of claiming not-found or a complete candidate set.
const SESSION_PAGE_LIMIT = 100;
const RESOLVE_MAX_PAGES = 20;

function mapSession(s) {
  return {
    id: s.id,
    title: s.title || '',
    directory: (s.location && s.location.directory) || '',
    updated: (s.time && s.time.updated) || 0,
    parentID: s.parentID || '',
  };
}

// Display listing: the server's default page (newest 50) unless the caller
// passes limit/cursor. A parentID narrows the page to one dispatcher's workers.
async function listSessions(opts) {
  const args = ['session.list'];
  if (opts && opts.limit !== undefined) {
    args.push('--param', 'limit=' + opts.limit);
  }
  if (opts && opts.cursor) {
    args.push('--param', 'cursor=' + opts.cursor);
  }
  if (opts && opts.parentID) {
    args.push('--param', 'parentID=' + opts.parentID);
  }
  if (opts && opts.search) {
    args.push('--param', 'search=' + opts.search);
  }
  const r = await runApi(args);
  if (!r.ok) return r;
  const rows = Array.isArray(r.json.data) ? r.json.data : [];
  const cursor = r.json.cursor || {};
  return { ok: true, sessions: rows.map(mapSession), cursor };
}

// Direct id lookup: GET /api/session/{id}. No list, no pagination. A 404 is a
// truthful session_not_found; anything else is reported as it came back.
async function getSession(id) {
  const r = await runApi(['session.get', '--param', 'sessionID=' + id]);
  if (!r.ok) return r;
  return { ok: true, session: mapSession(r.json.data || {}) };
}

// Substring resolution through the route that actually matches titles: the host
// silently ignores `?title=`, `search` is the key. Pages keep the same search
// term; a page that still has a next cursor marks the scan truncated.
async function scanSessions(query) {
  const all = [];
  let cursor = null;
  let lastNext = null;
  for (let page = 0; page < RESOLVE_MAX_PAGES; page++) {
    const opts = { limit: SESSION_PAGE_LIMIT, search: query };
    if (cursor) opts.cursor = cursor;
    const r = await listSessions(opts);
    if (!r.ok) return r;
    all.push(...r.sessions);
    lastNext = (r.cursor && r.cursor.next) || null;
    if (!lastNext) return { ok: true, sessions: all, truncated: false, pages: page + 1 };
    cursor = lastNext;
  }
  return { ok: true, sessions: all, truncated: !!lastNext, pages: RESOLVE_MAX_PAGES };
}

function nearMisses(sessions, query) {
  const q = String(query).toLowerCase();
  const hits = sessions.filter((s) => s.title.toLowerCase().includes(q));
  const rest = sessions.filter((s) => !s.title.toLowerCase().includes(q));
  return hits.concat(rest).slice(0, 5).map((s) => ({ id: s.id, title: s.title }));
}

// One shared resolver. Id-shaped `session` (/^ses_/) resolves by a direct
// GET /api/session/{id}: never a search, never ambiguous. Anything else is an
// exact-substring title match (case-sensitive) over the server's search pages:
// zero hits fail with nearMisses, several fail with candidates, and a scan that
// hit its page cap refuses with ambiguous_scan even on a single hit — an
// unscanned session may match too, so uniqueness is unproven. Never guesses, and
// the candidate list comes back as data rather than as a throw.
//
// `scan` and `get` are injectable so resolution can be proved offline; the tools
// always call them with the real backend.
async function resolveTarget(session, scan = scanSessions, get = getSession) {
  if (typeof session !== 'string' || !session) {
    return { ok: false, error: 'bad_request', reason: 'session must be a session id or title substring' };
  }
  if (ID_RE.test(session)) {
    const g = await get(session);
    if (!g.ok) {
      if (g.code === 'session_not_found') return { ok: false, error: 'session_not_found', reason: 'session ' + session + ' is gone: ' + g.detail };
      return { ok: false, error: g.code, reason: 'lookup failed: ' + g.detail };
    }
    return { ok: true, id: g.session.id, title: g.session.title || '' };
  }
  const scanned = await scan(session);
  if (!scanned.ok) return { ok: false, error: scanned.code, reason: 'search failed: ' + scanned.detail };
  const hits = scanned.sessions.filter((s) => s.title.includes(session));
  // A capped scan cannot prove uniqueness: an unscanned session may match too,
  // so even a single hit is not an authorization. Refuse and hand back what was
  // seen. The id path above never scans, so it is unaffected.
  if (scanned.truncated && hits.length > 0) {
    return {
      ok: false,
      error: 'ambiguous_scan',
      reason: 'search truncated at ' + scanned.pages + ' pages; ' + hits.length + ' scanned session(s) match "' + session + '"; use the full id',
      truncated: true,
      candidates: hits.map((s) => ({ id: s.id, title: s.title })),
    };
  }
  if (hits.length === 1) return { ok: true, id: hits[0].id, title: hits[0].title };
  if (hits.length === 0) {
    return {
      ok: false,
      error: 'session_not_found',
      reason: 'no session title contains "' + session + '"' + (scanned.truncated ? ' (search truncated at ' + scanned.pages + ' pages)' : ''),
      candidates: nearMisses(scanned.sessions, session),
      truncated: scanned.truncated || undefined,
    };
  }
  return {
    ok: false,
    error: 'ambiguous_session',
    reason: hits.length + ' sessions match "' + session + '"; use the full id' + (scanned.truncated ? ' (search truncated at ' + scanned.pages + ' pages)' : ''),
    candidates: hits.map((s) => ({ id: s.id, title: s.title })),
    truncated: scanned.truncated || undefined,
  };
}

// Assistant text lives in `content[]` parts of type text, and the user echo does
// too; a flat `text` field wins when the host sends one.
function messageText(m) {
  if (typeof m.text === 'string') return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

// Tool calls ride the same envelope as text: one row per `content[]` part of
// type tool, named the way the part names it, with its status when it has one.
function messageTools(m) {
  if (!Array.isArray(m.content)) return [];
  return m.content
    .filter((p) => p && p.type === 'tool')
    .map((p) => {
      const row = { name: String(p.name || p.tool || p.id || '') };
      const status = (p.state && p.state.status) || p.status;
      if (status !== undefined) row.status = status;
      return row;
    });
}

// One inbox row: who said it, what it said, which tools ran, when. `role` is the
// message's own type where the host names it, so `idle` stays visible as the turn
// boundary rather than being flattened into a user or assistant row.
function messageRow(m) {
  return {
    id: m.id,
    role: m.role || m.type,
    text: messageText(m),
    tools: messageTools(m),
    time: (m.time && m.time.created) || 0,
  };
}

// `wait` is seconds, default 0 (never block). A non-negative number is the only
// accepted spelling; anything else is a typed refusal, never a fallback.
function parseWait(value, fallback) {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: 'bad_request', reason: 'wait must be a non-negative number of seconds' };
  }
  return { ok: true, value: Math.min(value, WAIT_MAX_SECONDS) };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

// The turn boundary, read rather than guessed: the newest message of type `idle`
// marks the end of a turn. Poll until it appears or the budget runs out; a peer
// that never idles reports timedOut:true and is never reported as done.
async function waitForIdle(sessionID, waitMs) {
  const start = Date.now();
  for (;;) {
    const r = await runApi(['session.message.list', '--param', 'sessionID=' + sessionID, '--param', 'limit=1']);
    if (!r.ok) return { ok: false, code: r.code || 'backend_error', detail: r.detail || 'read failed' };
    const rows = Array.isArray(r.json.data) ? r.json.data : [];
    const newest = rows[0];
    if (newest && newest.type === 'idle') return { ok: true, timedOut: false, waitedMs: Date.now() - start };
    if (Date.now() - start >= waitMs) return { ok: true, timedOut: true, waitedMs: Date.now() - start };
    await sleep(POLL_INTERVAL_MS);
  }
}

// Canonical internal order is chronological ascending (oldest first):
// the first page asks order=asc explicitly and cursor pages follow with the
// cursor alone (the cursor preserves that order; cursor+order is 400), so the
// accumulation is oldest-to-newest with no reversal anywhere on this path.
async function collectMessages(sessionID, perPage, maxPages) {
  const asc = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const args = ['session.message.list', '--param', 'sessionID=' + sessionID, '--param', 'limit=' + perPage];
    if (cursor) args.push('--param', 'cursor=' + cursor);
    else args.push('--param', 'order=asc');
    const r = await runApi(args);
    if (!r.ok) return r;
    const rows = Array.isArray(r.json.data) ? r.json.data : [];
    asc.push(...rows);
    const next = (r.json.cursor && r.json.cursor.next) || null;
    if (!next) break;
    cursor = next;
  }
  return { ok: true, messages: asc };
}

// Dispose one location's live registration, if any, and forget it. Only that
// key's transform is touched: another location's registration is live for its
// own sessions. Safe to call when there is none, and safe to call on a
// registration the host already disposed on unload (the host's dispose is an
// idempotent finalizer).
function dropRegistration(key) {
  const current = registrations.get(key);
  registrations.delete(key);
  if (current && typeof current.dispose === 'function') return current.dispose();
  return undefined;
}

async function ensureTools(ctx) {
  const transform = ctx && ctx.tool && ctx.tool.transform;
  if (typeof transform !== 'function') return null;
  const key = locationKey(ctx);
  // Dispose this location's previous registration before re-registering: a reload,
  // or the server path after setup, must replace that location's transform instead
  // of stacking a second one or skipping the call. Another location's transform is
  // a different key and stays live.
  await dropRegistration(key);
  const registration = await transform((tools) => {
    tools.add({
      name: 'talk_send',
      description:
        'Deliver one text message into another session by id (ses_...) or unambiguous title substring; it is queued behind the target\'s current turn and acted on at its next one, and the call returns in milliseconds with the admission, not an answer. ' +
        'Fire to hand work or a correction to a peer; with `wait` seconds it then blocks until that session reaches a turn boundary and returns what it said. ' +
        'Never guesses: an unknown or ambiguous title returns the candidate list as data.',
      input: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          text: { type: 'string', description: 'Message text, delivered verbatim' },
          wait: { type: 'number', description: 'Seconds to block after sending until the target reaches a turn boundary; default 0 (never block)' },
        },
        required: ['session', 'text'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        const args = input ?? {};
        if (typeof args.text !== 'string' || !args.text) {
          return fail('bad_request', 'text must be a non-empty string');
        }
        const w = parseWait(args.wait, WAIT_DEFAULT_SECONDS);
        if (!w.ok) return fail(w.error, w.reason);
        const t = await resolveTarget(args.session);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        const signal = context && context.signal;
        // The service types this field as a message id (`msg_...`): a fresh one per
        // send keeps the admission idempotent without ever replaying a real one.
        const clientID = 'msg_' + randomUUID().replaceAll('-', '');
        const r = await runApi(['post', '/api/session/' + t.id + '/prompt', '--data', JSON.stringify({ text: args.text, delivery: 'queue', id: clientID })], { signal });
        if (!r.ok) {
          if (r.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + r.detail);
          return fail(r.code, 'send failed: ' + r.detail);
        }
        const d = r.json.data || {};
        const out = { id: d.id || '', sessionID: d.sessionID || t.id, title: t.title || '', delivered: true };
        if (w.value > 0) {
          const waited = await waitForIdle(t.id, w.value * 1000);
          if (!waited.ok) {
            if (waited.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + waited.detail);
            return fail(waited.code, 'wait failed: ' + waited.detail);
          }
          const got = await collectMessages(t.id, READ_MAX_LIMIT, 1);
          out.timedOut = waited.timedOut;
          out.waitedMs = waited.waitedMs;
          out.messages = got.ok ? got.messages.map((m) => messageRow(m)) : [];
        }
        return done(out);
      },
    });

    tools.add({
      name: 'talk_inbox',
      description:
        'Read one session\'s messages as id, role, text, tools and time, newest first, default 20; `session` defaults to the session that called this tool, `since` keeps only what is newer, and `cursor` pages. ' +
        'Fire to see what a peer said or what your own conversation has produced; with `wait` seconds it blocks until the session reaches a turn boundary first. ' +
        'Reads only: it never sends, wakes, or steers the other session, and an unknown title returns candidates instead of a guess.',
      input: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Session id (ses_...) or exact title substring; defaults to the calling session' },
          since: { type: 'string', description: 'A message id to read newer than, or an opaque cursor from a previous talk_inbox' },
          limit: { type: 'number', description: 'Messages to return, default 20, max 100' },
          type: { type: 'string', description: 'Only messages of this type, e.g. assistant, user, idle' },
          wait: { type: 'number', description: 'Seconds to block until the session reaches a turn boundary before reading; default 0' },
        },
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        const args = input ?? {};
        const caller = context && typeof context.sessionID === 'string' ? context.sessionID : '';
        const target = args.session === undefined ? caller : args.session;
        if (!target) return fail('bad_request', 'session must be a session id or title substring');
        const w = parseWait(args.wait, WAIT_DEFAULT_SECONDS);
        if (!w.ok) return fail(w.error, w.reason);
        let limit = args.limit === undefined ? READ_DEFAULT_LIMIT : Math.floor(args.limit);
        if (!Number.isFinite(limit)) return fail('bad_request', 'limit must be a number');
        limit = Math.min(Math.max(limit, 1), READ_MAX_LIMIT);
        if (args.type !== undefined && (typeof args.type !== 'string' || !args.type)) {
          return fail('bad_request', 'type must be a non-empty message type');
        }
        if (args.since !== undefined && (typeof args.since !== 'string' || !args.since)) {
          return fail('bad_request', 'since must be a message id or a cursor');
        }
        const t = await resolveTarget(target);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        const out = {};
        if (w.value > 0) {
          const waited = await waitForIdle(t.id, w.value * 1000);
          if (!waited.ok) {
            if (waited.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + waited.detail);
            return fail(waited.code, 'wait failed: ' + waited.detail);
          }
          out.timedOut = waited.timedOut;
        }
        // A message id is satisfied from the page itself (everything newer than
        // it); anything else the caller passes is an opaque cursor and goes to the
        // server verbatim. Never construct a cursor, never mix it with `order`.
        const listArgs = ['session.message.list', '--param', 'sessionID=' + t.id, '--param', 'limit=' + limit];
        if (args.type !== undefined) listArgs.push('--param', 'type=' + args.type);
        const r = await runApi(listArgs, { signal: context && context.signal });
        if (!r.ok) {
          if (r.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + r.detail);
          return fail(r.code, 'read failed: ' + r.detail);
        }
        const rows = Array.isArray(r.json.data) ? r.json.data : [];
        let kept = rows;
        if (args.since !== undefined) {
          const at = rows.findIndex((m) => m && m.id === args.since);
          if (at >= 0) {
            kept = rows.slice(0, at);
          } else {
            const paged = await runApi(['session.message.list', '--param', 'sessionID=' + t.id, '--param', 'limit=' + limit, '--param', 'cursor=' + args.since], { signal: context && context.signal });
            if (!paged.ok) {
              if (paged.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + paged.detail);
              return fail(paged.code, 'read failed: ' + paged.detail);
            }
            kept = Array.isArray(paged.json.data) ? paged.json.data : [];
            out.cursor = paged.json.cursor || {};
            out.sessionID = t.id;
            out.messages = kept.map((m) => messageRow(m));
            return done(out);
          }
        }
        out.sessionID = t.id;
        out.messages = kept.map((m) => messageRow(m));
        out.cursor = r.json.cursor || {};
        return done(out);
      },
    });
  });
  registrations.set(key, registration);
  return registration;
}

export { collectMessages, ensureTools, listSessions, messageRow, resolveTarget, setApiRunner, waitForIdle };

// V2 plugin definition, and the only shape the V2 host executes: a V1 object
// export is loaded (it appears in `opencode plugin list`) but its `setup` is
// never called, which is exactly how this package registered zero tools. The
// V1 `server` fallback is gone for the same reason: a V1 implementation does not
// run in V2, so it was dead weight that also misread as a live path.
//
// `setup` returns void by design: `ensureTools` keeps one live registration per
// location and disposes only that location's own registration before
// re-registering, so a reload replaces the transform instead of stacking a
// second one, and a second location never disposes the first location's tools.
export default Plugin.define({
  id: 'oc-talk',
  async setup(ctx) {
    await ensureTools(ctx);
  },
});
