// oc-talk — cross-session talk for any OpenCode harness.
//
// Thirteen tools: the eight lifecycle verbs session_list, session_send,
// session_read, session_close, session_open, session_kick, session_park,
// session_kill, plus the conversation verbs session_ask, session_wait,
// session_reply, session_thread and session_broadcast.
//
// Ported verb for verb from the harness plugin `session-talk.ts` so the package
// and the plugin it ships beside cannot drift. The send-then-poll wait verb is
// gone: it queued its message behind the long turn it then waited on.
// Thirteen verbs and no removal verb: nothing here ends a session's existence.
//
// The backend is the `opencode` CLI itself, reached with argv (no shell) and a
// hard timeout. That CLI discovers and authenticates with the harness's own
// background server, so no credential file is opened here, no port is resolved
// here, and no secret ever crosses this module: the child process holds its own
// authentication and this module only ever sees the JSON it prints.
import { execFile } from 'node:child_process';
import { Plugin } from '@opencode/plugin';

const BIN = 'opencode';
const TIMEOUT_MS = 20000;
const READ_DEFAULT_LIMIT = 20;
const READ_MAX_LIMIT = 100;
// The conversation verbs' wait budget: one ask waits at most this long for
// the peer to idle, then reports what exists with timedOut:true.
const ASK_DEFAULT_WAIT_MS = 120000;
const ASK_MESSAGE_LIMIT = 100;
const ASK_MAX_PAGES = 5;

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

// The plugin host is the opencode binary itself, so prefer it over PATH.
function pickBin() {
  const base = String(process.execPath || '').split(/[/\\]/).pop() || '';
  if (base.toLowerCase().startsWith('opencode')) return process.execPath;
  return BIN;
}

// One authenticated round-trip through the harness's own CLI, which discovers
// and authenticates with the background server itself. No credential file is
// read, no port is resolved, no secret ever crosses this module.
function spawnApi(args) {
  return new Promise((resolve) => {
    execFile(pickBin(), ['api', ...args], { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      const out = String(stdout || '');
      if (!error) {
        // A 204-style empty body is success with no payload, not a parse error.
        if (!out.trim()) {
          resolve({ ok: true, json: { data: {} } });
          return;
        }
        try {
          resolve({ ok: true, json: JSON.parse(out) });
        } catch {
          resolve({ ok: false, code: 'bad_response', detail: 'server returned non-JSON output' });
        }
        return;
      }
      if (error.code === 'ENOENT') {
        resolve({ ok: false, code: 'backend_unavailable', detail: 'opencode CLI not reachable from the plugin host' });
        return;
      }
      if (error.killed) {
        resolve({ ok: false, code: 'timeout', detail: 'opencode api call exceeded ' + TIMEOUT_MS + 'ms' });
        return;
      }
      const start = out.indexOf('{');
      const end = out.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          const body = JSON.parse(out.slice(start, end + 1));
          const tag = String(body._tag || '');
          if (/notfound/i.test(tag)) {
            resolve({ ok: false, code: 'session_not_found', detail: String(body.message || tag) });
          } else {
            resolve({ ok: false, code: 'backend_error', detail: String(body.message || tag || 'request failed') });
          }
          return;
        } catch { /* fall through to stderr tail */ }
      }
      resolve({ ok: false, code: 'backend_error', detail: String(stderr || error.message || 'request failed').trim().slice(-200) });
    });
  });
}

// Every backend call goes through this seam so the offline suite can swap in a
// recording backend and prove the exact prompt payload without a peer. Production
// never calls setApiRunner, so the runner is always spawnApi there.
let apiRunner = spawnApi;

function runApi(args) {
  return apiRunner(args);
}

function setApiRunner(fn) {
  apiRunner = typeof fn === 'function' ? fn : spawnApi;
}

const ID_RE = /^ses_/;
// Resolution scans a page of SESSION_PAGE_LIMIT rows at a time and stops after
// RESOLVE_MAX_PAGES pages (20000 sessions): past that the scan reports
// truncated:true instead of claiming not-found or a complete candidate set.
const SESSION_PAGE_LIMIT = 1000;
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
// passes limit/cursor. A parentID narrows the page to one dispatcher's
// workers. Pagination belongs to resolution (scanSessions).
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

// Bounded full-estate scan for substring resolution. Returns truncated:true
// when RESOLVE_MAX_PAGES pages still leave a next cursor unvisited.
async function scanSessions() {
  const all = [];
  let cursor = null;
  let lastNext = null;
  for (let page = 0; page < RESOLVE_MAX_PAGES; page++) {
    const r = await listSessions(cursor ? { limit: SESSION_PAGE_LIMIT, cursor } : { limit: SESSION_PAGE_LIMIT });
    if (!r.ok) return r;
    all.push(...r.sessions);
    lastNext = (r.cursor && r.cursor.next) || null;
    if (!lastNext) return { ok: true, sessions: all, truncated: false, pages: page + 1 };
    cursor = lastNext;
  }
  return { ok: true, sessions: all, truncated: !!lastNext, pages: RESOLVE_MAX_PAGES };
}

async function listChildren(id) {
  const r = await runApi(['session.list', '--param', 'parentID=' + id, '--param', 'limit=' + SESSION_PAGE_LIMIT]);
  if (!r.ok) return r;
  const rows = Array.isArray(r.json.data) ? r.json.data : [];
  return { ok: true, sessions: rows.map(mapSession) };
}

function nearMisses(sessions, query) {
  const q = String(query).toLowerCase();
  const hits = sessions.filter((s) => s.title.toLowerCase().includes(q));
  const rest = sessions.filter((s) => !s.title.toLowerCase().includes(q));
  return hits.concat(rest).slice(0, 5).map((s) => ({ id: s.id, title: s.title }));
}

// One shared resolver. Id-shaped `to` (/^ses_/) resolves by a direct
// GET /api/session/{id}: never the list, never ambiguous. Anything else is an
// exact-substring title match (case-sensitive) over a bounded paginated scan:
// zero hits fail with nearMisses, several fail with candidates, and a scan that
// hit its page cap refuses with ambiguous_scan even on a single hit — an
// unscanned session may match too, so uniqueness is unproven and nothing is
// authorized. Never guesses.
//
// `scan` and `get` are injectable so resolution can be proved offline; the
// tools always call them with the real backend.
async function resolveTarget(to, scan = scanSessions, get = getSession) {
  if (typeof to !== 'string' || !to) {
    return { ok: false, error: 'bad_request', reason: 'to must be a session id or title substring' };
  }
  if (ID_RE.test(to)) {
    const g = await get(to);
    if (!g.ok) {
      if (g.code === 'session_not_found') return { ok: false, error: 'session_not_found', reason: 'session ' + to + ' is gone: ' + g.detail };
      return { ok: false, error: g.code, reason: 'lookup failed: ' + g.detail };
    }
    return { ok: true, id: g.session.id };
  }
  const scanned = await scan();
  if (!scanned.ok) return { ok: false, error: scanned.code, reason: 'list failed: ' + scanned.detail };
  const hits = scanned.sessions.filter((s) => s.title.includes(to));
  // A capped scan cannot prove uniqueness: an unscanned session may match too,
  // so even a single hit is not an authorization. Refuse and hand back what was
  // seen. The id path above never scans, so it is unaffected.
  if (scanned.truncated && hits.length > 0) {
    return {
      ok: false,
      error: 'ambiguous_scan',
      reason: 'scan truncated at ' + scanned.pages + ' pages; ' + hits.length + ' scanned session(s) match "' + to + '"; use the full id',
      truncated: true,
      candidates: hits.map((s) => ({ id: s.id, title: s.title })),
    };
  }
  if (hits.length === 1) return { ok: true, id: hits[0].id };
  if (hits.length === 0) {
    return {
      ok: false,
      error: 'session_not_found',
      reason: 'no session title contains "' + to + '"' + (scanned.truncated ? ' (scan truncated at ' + scanned.pages + ' pages)' : ''),
      candidates: nearMisses(scanned.sessions, to),
      truncated: scanned.truncated || undefined,
    };
  }
  return {
    ok: false,
    error: 'ambiguous_session',
    reason: hits.length + ' sessions match "' + to + '"; use the full id' + (scanned.truncated ? ' (scan truncated at ' + scanned.pages + ' pages)' : ''),
    candidates: hits.map((s) => ({ id: s.id, title: s.title })),
    truncated: scanned.truncated || undefined,
  };
}

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

// One row keeps the four historical keys first, then anything the peer sent:
// metadata (who sent it, which message it answers), outcome/finish and the
// completion stamp. Absent fields stay absent, never null.
function messageRow(m) {
  const row = {
    id: m.id,
    type: m.type,
    created: (m.time && m.time.created) || 0,
    text: messageText(m),
  };
  if (m.metadata !== undefined) row.metadata = m.metadata;
  if (m.outcome !== undefined) row.outcome = m.outcome;
  if (m.finish !== undefined) row.finish = m.finish;
  if (m.time && m.time.completed !== undefined) row.completed = m.time.completed;
  return row;
}

function parseWaitMs(value, fallback) {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: 'bad_request', reason: 'waitMs must be a non-negative number of milliseconds' };
  }
  return { ok: true, value: Math.floor(value) };
}

function metadataOf(args) {
  if (args.metadata === undefined) return { ok: true, value: undefined };
  const m = args.metadata;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    return { ok: false, error: 'bad_request', reason: 'metadata must be an object' };
  }
  return { ok: true, value: m };
}

// Block until the peer is idle through the CLI wait route: an idle peer
// answers 204 (empty body, reported ok), a busy peer holds the call until the
// CLI timeout ends it, which reads as code `timeout` and retries while the
// budget holds. Anything else is reported, never retried.
async function waitForIdle(sessionID, waitMs) {
  const start = Date.now();
  for (;;) {
    const r = await runApi(['post', '/api/experimental/session/' + sessionID + '/wait', '--data', '{}']);
    if (r.ok) return { ok: true, timedOut: false, waitedMs: Date.now() - start };
    if (r.code === 'session_not_found') return { ok: false, code: r.code, detail: r.detail };
    if (r.code === 'timeout') {
      if (Date.now() - start >= waitMs) return { ok: true, timedOut: true, waitedMs: Date.now() - start };
      continue;
    }
    return { ok: false, code: r.code || 'backend_error', detail: r.detail || 'wait failed' };
  }
}

// Newest-first pages of one session's messages, following cursor.next up to
// maxPages so a question asked a while ago is still found.
async function collectMessagesDesc(sessionID, perPage, maxPages) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const args = ['session.message.list', '--param', 'sessionID=' + sessionID, '--param', 'limit=' + perPage, '--param', 'order=desc'];
    if (cursor) args.push('--param', 'cursor=' + cursor);
    const r = await runApi(args);
    if (!r.ok) return r;
    const rows = Array.isArray(r.json.data) ? r.json.data : [];
    all.push(...rows);
    const next = (r.json.cursor && r.json.cursor.next) || null;
    if (!next) break;
    cursor = next;
  }
  return { ok: true, messages: all };
}

// Positional correlation: in oldest-first order, the answer to one user
// message is the assistant messages that follow it up to (not including) the
// next user message. A later unrelated exchange above never leaks in, because
// the slice stops at the next question either way.
function sliceAfter(messagesAsc, askedID) {
  const at = messagesAsc.findIndex((m) => m && m.id === askedID);
  if (at < 0) return { answer: [], outcome: '' };
  const answer = [];
  let outcome = '';
  for (let i = at + 1; i < messagesAsc.length; i++) {
    const m = messagesAsc[i] || {};
    if (m.type === 'user') break;
    if (m.type !== 'assistant') continue;
    answer.push({ id: m.id, text: messageText(m) });
    if (m.outcome !== undefined) outcome = m.outcome;
    else if (m.finish !== undefined) outcome = m.finish;
  }
  return { answer, outcome };
}

// The shared send-then-correlate flow behind session_ask and one broadcast
// row. Never throws: every failure — including a thrown transport — comes
// back as { ok:false, ... } so a broadcast row can carry it.
async function askFlow(sessionID, title, opts) {
  try {
    const prompt = { text: opts.text, resume: opts.resume, delivery: opts.delivery };
    if (opts.metadata !== undefined) prompt.metadata = opts.metadata;
    const posted = await runApi(['post', '/api/session/' + sessionID + '/prompt', '--data', JSON.stringify(prompt)]);
    if (!posted.ok) {
      if (posted.code === 'session_not_found') return { ok: false, error: 'session_not_found', reason: 'session ' + sessionID + ' is gone: ' + posted.detail };
      return { ok: false, error: posted.code || 'backend_error', reason: 'send failed: ' + (posted.detail || 'request failed') };
    }
    const askedMessageID = ((posted.json.data) || {}).id || '';
    if (!askedMessageID) return { ok: false, error: 'backend_error', reason: 'send succeeded but returned no message id' };
    const waited = await waitForIdle(sessionID, opts.waitMs);
    if (!waited.ok) {
      if (waited.code === 'session_not_found') return { ok: false, error: 'session_not_found', reason: 'session ' + sessionID + ' is gone: ' + waited.detail };
      return { ok: false, error: waited.code, reason: 'wait failed: ' + waited.detail };
    }
    const got = await collectMessagesDesc(sessionID, ASK_MESSAGE_LIMIT, ASK_MAX_PAGES);
    if (!got.ok) {
      if (got.code === 'session_not_found') return { ok: false, error: 'session_not_found', reason: 'session ' + sessionID + ' is gone: ' + got.detail };
      return { ok: false, error: got.code || 'backend_error', reason: 'read failed: ' + (got.detail || 'request failed') };
    }
    const cut = sliceAfter(got.messages.slice().reverse(), askedMessageID);
    return {
      ok: true,
      sessionID,
      title,
      askedMessageID,
      answer: cut.answer,
      outcome: cut.outcome,
      waitedMs: waited.waitedMs,
      timedOut: waited.timedOut,
    };
  } catch (err) {
    return { ok: false, error: 'backend_error', reason: 'ask failed: ' + String((err && err.message) || err) };
  }
}

// One peer of an ask: resolve, refuse a closed session, then run the shared
// flow. Broadcast-ready: success and failure both come back as rows.
async function askTarget(to, opts) {
  try {
    const t = await resolveTarget(to);
    if (!t.ok) return { ok: false, target: to, sessionID: '', error: t.error, reason: t.reason };
    const f = await findSession(t.id);
    if (!f.ok) {
      if (f.code === 'session_not_found') return { ok: false, target: to, sessionID: t.id, error: 'session_not_found', reason: 'session ' + t.id + ' is gone: ' + f.detail };
      return { ok: false, target: to, sessionID: t.id, error: f.code, reason: 'lookup failed: ' + f.detail };
    }
    const lock = doneRefusal(f.session);
    if (lock) return { ok: false, target: to, sessionID: t.id, error: lock.error, reason: lock.reason };
    const r = await askFlow(t.id, f.session.title || '', opts);
    if (!r.ok) return { ok: false, target: to, sessionID: t.id, error: r.error, reason: r.reason };
    return { ok: true, target: to, sessionID: r.sessionID, title: r.title, askedMessageID: r.askedMessageID, answer: r.answer, outcome: r.outcome, waitedMs: r.waitedMs, timedOut: r.timedOut };
  } catch (err) {
    return { ok: false, target: to, sessionID: '', error: 'backend_error', reason: 'ask failed: ' + String((err && err.message) || err) };
  }
}

const PREFIXES = ['active ', 'parked ', 'done '];

// One shared prefix rewrite: strip any existing lifecycle prefix, apply the new
// one. Looped so `parked active foo` collapses instead of stacking.
function stripPrefix(title) {
  let t = String(title || '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of PREFIXES) {
      if (t.startsWith(p)) {
        t = t.slice(p.length);
        changed = true;
      }
    }
  }
  return t;
}

function isDone(title) {
  return String(title || '').startsWith('done ');
}

// `done` is a lock: send, kick, park and kill refuse; open alone may lift it.
function doneRefusal(session) {
  if (!isDone(session.title)) return null;
  return { error: 'session_closed', reason: 'session "' + session.title + '" is closed (done); session_open is the only verb that may revive it' };
}

async function findSession(id) {
  const g = await getSession(id);
  if (!g.ok) return g;
  return { ok: true, session: g.session };
}

// Rewrite to one lifecycle prefix without stacking. No-op when already right
// (renamed:false) so a redundant PATCH is never sent.
//
// The lock is re-checked here on the freshly read title, not only at the caller:
// a close that landed between the caller's check and this read must not be
// renamed away. Caller-side checks stay as defence in depth.
async function retitle(id, prefix) {
  const f = await findSession(id);
  if (!f.ok) return f;
  const titleBefore = f.session.title || '';
  const lock = doneRefusal(f.session);
  if (lock) return { ok: false, code: lock.error, detail: lock.reason };
  const titleAfter = prefix + stripPrefix(titleBefore);
  if (titleBefore === titleAfter) {
    return { ok: true, titleBefore, titleAfter, renamed: false };
  }
  const r = await runApi(['patch', '/api/session/' + id, '--data', JSON.stringify({ title: titleAfter })]);
  if (!r.ok) return r;
  return { ok: true, titleBefore, titleAfter, renamed: true };
}

// `delivery` decides whether a prompt preempts the peer's running turn (steer)
// or waits behind it (queue). Each verb states its own default; an explicit
// value always wins, and anything else is a typed refusal, never a fallback.
function deliveryOf(args, fallback) {
  const v = args.delivery;
  if (v === undefined) return { ok: true, value: fallback };
  if (v === 'steer' || v === 'queue') return { ok: true, value: v };
  return { ok: false, error: 'bad_request', reason: 'delivery must be "steer" or "queue"' };
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
      name: 'session_list',
      description:
        'List every live OpenCode session as id, title, directory and last-update time; pass `parentID` to list only one dispatcher\'s workers. ' +
        'Fire when you need to find a peer session to talk to, or to turn a title into an id. ' +
        'Lists only: it never sends, reads, wakes, or steers anything.',
      input: { type: 'object', properties: { limit: { type: 'number', description: 'Page size; default is the server default page (newest 50)' }, cursor: { type: 'string', description: 'Opaque cursor from a previous session_list response' }, parentID: { type: 'string', description: 'Only sessions spawned by this parent session id' } }, additionalProperties: false },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        const opts = {};
        if (args.limit !== undefined) {
          const n = Math.floor(args.limit);
          if (!Number.isFinite(n) || n < 1) return fail('bad_request', 'limit must be a positive number');
          opts.limit = n;
        }
        if (args.cursor !== undefined) {
          if (typeof args.cursor !== 'string' || !args.cursor) return fail('bad_request', 'cursor must be a non-empty string');
          opts.cursor = args.cursor;
        }
        if (args.parentID !== undefined) {
          if (typeof args.parentID !== 'string' || !args.parentID) return fail('bad_request', 'parentID must be a non-empty session id');
          opts.parentID = args.parentID;
        }
        const r = await listSessions(opts);
        if (!r.ok) return fail(r.code, 'list failed: ' + r.detail);
        if (args.limit !== undefined || args.cursor !== undefined || args.parentID !== undefined) {
          return done({ sessions: r.sessions, cursor: r.cursor });
        }
        return done(r.sessions);
      },
    });

    tools.add({
      name: 'session_send',
      description:
        'Deliver one text message to another session by id (ses_...) or unambiguous title substring, with resume defaulting to true; an optional `metadata` object travels in the prompt body so the peer can see who sent it and which message it answers. ' +
        'Fire instead of dispatching a lane whenever a peer must act; `delivery` is `steer` by default so a correction preempts the peer\'s running turn, and `queue` waits behind it. ' +
        'Refuses a `done ` session with a typed error, and never guesses: a missing or ambiguous title fails with candidates.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          text: { type: 'string', description: 'Message text, delivered verbatim' },
          resume: { type: 'boolean', description: 'Let the receiver loop run; default true' },
          delivery: { type: 'string', description: '`steer` preempts the peer\'s current turn, `queue` waits for it; default steer' },
          metadata: { type: 'object', description: 'Optional object carried in the prompt body so the peer can see who sent it and which message it answers' },
        },
        required: ['to', 'text'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        if (typeof args.text !== 'string' || !args.text) {
          return fail('bad_request', 'text must be a non-empty string');
        }
        const dlv = deliveryOf(args, 'steer');
        if (!dlv.ok) return fail(dlv.error, dlv.reason);
        const resume = args.resume === undefined ? true : !!args.resume;
        const meta = metadataOf(args);
        if (!meta.ok) return fail(meta.error, meta.reason);
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        const f = await findSession(t.id);
        if (!f.ok) {
          if (f.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + f.detail);
          return fail(f.code, 'list failed: ' + f.detail);
        }
        // `done` is a lock: a prompt must not reach a closed session.
        const lock = doneRefusal(f.session);
        if (lock) return fail(lock.error, lock.reason);
        const body = { text: args.text, resume, delivery: dlv.value };
        if (meta.value !== undefined) body.metadata = meta.value;
        const r = await runApi(['post', '/api/session/' + t.id + '/prompt', '--data', JSON.stringify(body)]);
        if (!r.ok) {
          if (r.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + r.detail);
          return fail(r.code, 'send failed: ' + r.detail);
        }
        const d = r.json.data || {};
        return done({ id: d.id, sessionID: d.sessionID || t.id, created: (d.time && d.time.created) || 0 });
      },
    });

    tools.add({
      name: 'session_read',
      description:
        'Read another session\'s newest messages by id (ses_...) or unambiguous title substring, newest first, default 20, text verbatim; `cursor` pages forward, `since` keeps only newer messages, and each row carries `metadata`, `outcome`, `finish` and `completed` where the peer sent them. ' +
        'Fire when you need what a peer actually said. ' +
        'Reads only: it never sends, wakes, or steers the other session, and never guesses — a missing or ambiguous title fails with candidates.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          limit: { type: 'number', description: 'Newest messages to return, default 20, max 100' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous session_read response; pages forward' },
          since: { description: 'Keep only newer messages: a message id, or a created timestamp' },
        },
        required: ['to'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        let limit = args.limit === undefined ? READ_DEFAULT_LIMIT : Math.floor(args.limit);
        if (!Number.isFinite(limit)) return fail('bad_request', 'limit must be a number');
        limit = Math.min(Math.max(limit, 1), READ_MAX_LIMIT);
        const listArgs = ['session.message.list', '--param', 'sessionID=' + t.id, '--param', 'limit=' + limit, '--param', 'order=desc'];
        if (args.cursor !== undefined) {
          if (typeof args.cursor !== 'string' || !args.cursor) return fail('bad_request', 'cursor must be a non-empty string');
          listArgs.push('--param', 'cursor=' + args.cursor);
        }
        const hasSince = args.since !== undefined;
        if (hasSince) {
          const s = args.since;
          const okSince = (typeof s === 'string' && !!s) || (typeof s === 'number' && Number.isFinite(s));
          if (!okSince) return fail('bad_request', 'since must be a message id or a created timestamp');
        }
        const r = await runApi(listArgs);
        if (!r.ok) {
          if (r.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + r.detail);
          return fail(r.code, 'read failed: ' + r.detail);
        }
        const rows = Array.isArray(r.json.data) ? r.json.data : [];
        let kept = rows;
        if (typeof args.since === 'number') {
          kept = rows.filter((m) => ((m.time && m.time.created) || 0) > args.since);
        } else if (typeof args.since === 'string' && args.since) {
          const at = rows.findIndex((m) => m && m.id === args.since);
          kept = at >= 0 ? rows.slice(0, at) : rows;
        }
        const messages = kept.map((m) => messageRow(m));
        if (args.cursor !== undefined || hasSince) {
          return done({ messages, cursor: r.json.cursor || {} });
        }
        return done(messages);
      },
    });

    tools.add({
      name: 'session_close',
      description:
        'Close a finished session in one call: rewrite its title to `done <work>`, then compact it, in that order. ' +
        'An explicit title is normalized to the same `done ` prefix, and an already-closed session is left byte-identical and reported `already-closed`. ' +
        'Fire when a session is finished and must stop reading as live.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          title: { type: 'string', description: 'Explicit final title; defaults to `done <current title>`' },
        },
        required: ['to'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        const g = await getSession(t.id);
        if (!g.ok) {
          if (g.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + g.detail);
          return fail(g.code, 'lookup failed: ' + g.detail);
        }
        const found = g.session;
        const titleBefore = found.title || '';
        const alreadyClosed = titleBefore.startsWith('done ');
        const explicit = typeof args.title === 'string' && args.title ? args.title : null;
        // The close-prefix fix: strip first, then add `done ` once. An explicit
        // title wins but is normalized to the same prefix — a close that renamed
        // to a live-looking title would compact a session that still reads as
        // open. An already-closed session is left byte-identical.
        const explicitTitle = explicit ? (isDone(explicit) ? explicit : 'done ' + stripPrefix(explicit)) : null;
        const titleAfter = alreadyClosed ? titleBefore : (explicitTitle || ('done ' + stripPrefix(titleBefore)));
        // Order is fixed: rename, then compact. Never compact first.
        if (!alreadyClosed) {
          const r1 = await runApi(['patch', '/api/session/' + t.id, '--data', JSON.stringify({ title: titleAfter })]);
          if (!r1.ok) {
            if (r1.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + r1.detail);
            return fail(r1.code, 'rename failed: ' + r1.detail);
          }
        }
        const r2 = await runApi(['post', '/api/session/' + t.id + '/compact', '--data', '{}']);
        if (!r2.ok) {
          if (r2.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + r2.detail);
          return done({ error: r2.code, reason: 'compact failed after rename to "' + titleAfter + '": ' + r2.detail, sessionID: t.id, titleBefore, titleAfter });
        }
        const d = (r2.json && r2.json.data) || {};
        return done({ sessionID: t.id, titleBefore, titleAfter, compacted: true, compactionId: d.id || '', alreadyClosed, status: alreadyClosed ? 'already-closed' : 'closed' });
      },
    });

    tools.add({
      name: 'session_open',
      description:
        'Create a session titled `active <work>`, optionally delivering one prompt, or revive the one live session whose title contains <work>; `delivery` is `queue` by default so the peer finishes its turn, `steer` to preempt it. ' +
        'The only verb that may lift `done`; zero matches create, several fail ambiguous with candidates, and a capped scan creates instead of reviving. ' +
        'Fire when work needs a fresh lane, or a closed one revived.',
      input: {
        type: 'object',
        properties: {
          work: { type: 'string', description: 'Short work label; new title becomes `active <work>`' },
          text: { type: 'string', description: 'Optional one-shot prompt delivered after open' },
          resume: { type: 'boolean', description: 'Let the receiver loop run after the prompt; default true' },
          delivery: { type: 'string', description: '`steer` preempts the peer\'s current turn, `queue` waits for it; default queue (applies only when text is given)' },
        },
        required: ['work'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        if (typeof args.work !== 'string' || !args.work) {
          return fail('bad_request', 'work must be a non-empty string');
        }
        const dlv = deliveryOf(args, 'queue');
        if (!dlv.ok) return fail(dlv.error, dlv.reason);
        const resume = args.resume === undefined ? true : !!args.resume;
        const scanned = await scanSessions();
        if (!scanned.ok) return fail(scanned.code, 'list failed: ' + scanned.detail);
        const hits = scanned.sessions.filter((s) => s.title.includes(args.work));
        if (hits.length > 1) {
          return fail('ambiguous_session', hits.length + ' sessions match "' + args.work + '"; refine work' + (scanned.truncated ? ' (scan truncated at ' + scanned.pages + ' pages)' : ''), hits.map((s) => ({ id: s.id, title: s.title })), scanned.truncated || undefined);
        }
        let id, titleBefore, titleAfter, reopened;
        // Revive only on a proven-unique hit. A truncated scan never revives: an
        // unscanned session may be the one meant, so it creates instead and says
        // truncated:true rather than reusing an unproven target as a revival.
        const revive = hits.length === 1 && !scanned.truncated;
        if (revive) {
          // Open is the one verb that may lift `done`: no lock check here.
          id = hits[0].id;
          titleBefore = hits[0].title || '';
          titleAfter = 'active ' + stripPrefix(titleBefore);
          if (titleBefore !== titleAfter) {
            const r = await runApi(['patch', '/api/session/' + id, '--data', JSON.stringify({ title: titleAfter })]);
            if (!r.ok) {
              if (r.code === 'session_not_found') return fail('session_not_found', 'session ' + id + ' is gone: ' + r.detail);
              return fail(r.code, 'rename failed: ' + r.detail);
            }
          }
          reopened = true;
        } else {
          titleBefore = '';
          titleAfter = 'active ' + stripPrefix(args.work);
          const r = await runApi(['post', '/api/session', '--data', JSON.stringify({ title: titleAfter })]);
          if (!r.ok) return fail(r.code, 'create failed: ' + r.detail);
          id = (r.json.data || {}).id || '';
          if (!id) return fail('backend_error', 'create succeeded but returned no session id');
          reopened = false;
        }
        let messageID = '';
        if (typeof args.text === 'string' && args.text) {
          const rp = await runApi(['post', '/api/session/' + id + '/prompt', '--data', JSON.stringify({ text: args.text, resume, delivery: dlv.value })]);
          if (!rp.ok) {
            if (rp.code === 'session_not_found') return fail('session_not_found', 'session ' + id + ' is gone: ' + rp.detail);
            return fail(rp.code, 'send failed: ' + rp.detail);
          }
          messageID = ((rp.json.data) || {}).id || '';
        }
        return done({ sessionID: id, titleBefore, titleAfter, reopened, resume, messageID, truncated: scanned.truncated || undefined });
      },
    });

    tools.add({
      name: 'session_kick',
      description:
        'Wake a live session with one message, renaming it to `active <work>` first; `delivery` is `steer` by default so the message preempts the peer\'s running turn, `queue` to wait behind it. ' +
        'Fire when a peer already exists and must act now. ' +
        'Refuses a `done ` session with a typed error: reopen it with session_open instead.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          text: { type: 'string', description: 'Message text, delivered verbatim' },
          resume: { type: 'boolean', description: 'Let the receiver loop run; default true' },
          delivery: { type: 'string', description: '`steer` preempts the peer\'s current turn, `queue` waits for it; default steer' },
        },
        required: ['to', 'text'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        if (typeof args.text !== 'string' || !args.text) {
          return fail('bad_request', 'text must be a non-empty string');
        }
        const dlv = deliveryOf(args, 'steer');
        if (!dlv.ok) return fail(dlv.error, dlv.reason);
        const resume = args.resume === undefined ? true : !!args.resume;
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        const f = await findSession(t.id);
        if (!f.ok) {
          if (f.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + f.detail);
          return fail(f.code, 'list failed: ' + f.detail);
        }
        const lock = doneRefusal(f.session);
        if (lock) return fail(lock.error, lock.reason);
        const rt = await retitle(t.id, 'active ');
        if (!rt.ok) {
          if (rt.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + rt.detail);
          return fail(rt.code, 'rename failed: ' + rt.detail);
        }
        const r = await runApi(['post', '/api/session/' + t.id + '/prompt', '--data', JSON.stringify({ text: args.text, resume, delivery: dlv.value })]);
        if (!r.ok) {
          if (r.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + r.detail);
          return fail(r.code, 'send failed: ' + r.detail);
        }
        const d = r.json.data || {};
        return done({ sessionID: t.id, titleBefore: rt.titleBefore, titleAfter: rt.titleAfter, messageID: d.id || '', resumed: resume });
      },
    });

    tools.add({
      name: 'session_park',
      description:
        'Park a live session: rewrite its title to `parked <work>` and return. ' +
        'Fire when a session should stop reading as active without being closed; prefix only, so no message is sent and no compaction runs. ' +
        'Refuses a `done ` session with a typed error; session_open is the only revival path.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
        },
        required: ['to'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        const f = await findSession(t.id);
        if (!f.ok) {
          if (f.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + f.detail);
          return fail(f.code, 'list failed: ' + f.detail);
        }
        const lock = doneRefusal(f.session);
        if (lock) return fail(lock.error, lock.reason);
        const rt = await retitle(t.id, 'parked ');
        if (!rt.ok) {
          if (rt.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + rt.detail);
          return fail(rt.code, 'rename failed: ' + rt.detail);
        }
        return done({ sessionID: t.id, titleBefore: rt.titleBefore, titleAfter: rt.titleAfter });
      },
    });

    tools.add({
      name: 'session_kill',
      description:
        'Stop a live session hard: rewrite its title to `parked <work>`, then interrupt its active execution; park is graceful, kill is hard. ' +
        'The interrupt covers only the target session: cascaded is always false and live child sessions return as children ids, never claimed stopped. ' +
        'Refuses a `done ` session with a typed error; session_open is the only revival path.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
        },
        required: ['to'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        const f = await findSession(t.id);
        if (!f.ok) {
          if (f.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + f.detail);
          return fail(f.code, 'list failed: ' + f.detail);
        }
        const lock = doneRefusal(f.session);
        if (lock) return fail(lock.error, lock.reason);
        const rt = await retitle(t.id, 'parked ');
        if (!rt.ok) {
          if (rt.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + rt.detail);
          return fail(rt.code, 'rename failed: ' + rt.detail);
        }
        const lc = await listChildren(t.id);
        if (!lc.ok) return fail(lc.code, 'children lookup failed: ' + lc.detail);
        const children = lc.sessions.map((s) => s.id);
        const r = await runApi(['post', '/api/session/' + t.id + '/interrupt', '--data', '{}']);
        if (!r.ok) {
          if (r.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + r.detail);
          return fail(r.code, 'interrupt failed: ' + r.detail);
        }
        return done({ sessionID: t.id, titleBefore: rt.titleBefore, titleAfter: rt.titleAfter, interrupted: !!((r.json.data) || {}).interrupted, cascaded: false, children });
      },
    });

    tools.add({
      name: 'session_ask',
      description:
        'Send one message to a peer and wait until it is idle, then return the assistant messages that answer that exact message and nothing after the next question. ' +
        'Fire when you need a peer\'s answer, not just its newest text; `delivery` is `steer` by default so the question preempts the peer\'s running turn, and `queue` waits behind it. ' +
        'A peer that never idles within `waitMs` returns `timedOut:true` with what exists, never a success.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          text: { type: 'string', description: 'Message text, delivered verbatim' },
          resume: { type: 'boolean', description: 'Let the receiver loop run; default true' },
          delivery: { type: 'string', description: '`steer` preempts the peer\'s current turn, `queue` waits for it; default steer' },
          waitMs: { type: 'number', description: 'How long to wait for the peer to idle; default 120000' },
          metadata: { type: 'object', description: 'Optional object carried in the prompt body so the peer can see who sent it' },
        },
        required: ['to', 'text'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        if (typeof args.text !== 'string' || !args.text) {
          return fail('bad_request', 'text must be a non-empty string');
        }
        const dlv = deliveryOf(args, 'steer');
        if (!dlv.ok) return fail(dlv.error, dlv.reason);
        const resume = args.resume === undefined ? true : !!args.resume;
        const w = parseWaitMs(args.waitMs, ASK_DEFAULT_WAIT_MS);
        if (!w.ok) return fail(w.error, w.reason);
        const meta = metadataOf(args);
        if (!meta.ok) return fail(meta.error, meta.reason);
        const r = await askTarget(args.to, { text: args.text, resume, delivery: dlv.value, waitMs: w.value, metadata: meta.value });
        if (!r.ok) return fail(r.error, r.reason);
        return done({ sessionID: r.sessionID, title: r.title, askedMessageID: r.askedMessageID, answer: r.answer, outcome: r.outcome, waitedMs: r.waitedMs, timedOut: r.timedOut });
      },
    });

    tools.add({
      name: 'session_wait',
      description:
        'Block until a peer session is idle without sending anything, giving up after `waitMs` with `timedOut:true`. ' +
        'Fire when an answer you already asked for needs time to land before you read it.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          waitMs: { type: 'number', description: 'How long to wait for the peer to idle; default 120000' },
        },
        required: ['to'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        const w = parseWaitMs(args.waitMs, ASK_DEFAULT_WAIT_MS);
        if (!w.ok) return fail(w.error, w.reason);
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        let waited;
        try {
          waited = await waitForIdle(t.id, w.value);
        } catch (err) {
          return fail('backend_error', 'wait failed: ' + String((err && err.message) || err));
        }
        if (!waited.ok) {
          if (waited.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + waited.detail);
          return fail(waited.code || 'backend_error', 'wait failed: ' + (waited.detail || 'request failed'));
        }
        let outcome = '';
        try {
          const got = await collectMessagesDesc(t.id, 5, 1);
          if (got.ok) {
            for (const m of got.messages) {
              if (m && (m.outcome !== undefined || m.finish !== undefined)) {
                outcome = m.outcome !== undefined ? m.outcome : m.finish;
                break;
              }
            }
          }
        } catch {
          outcome = '';
        }
        return done({ sessionID: t.id, waitedMs: waited.waitedMs, timedOut: waited.timedOut, outcome });
      },
    });

    tools.add({
      name: 'session_reply',
      description:
        'Answer the session that asked you: send one message carrying `metadata.re` with the message id it answers. ' +
        'Fire to close someone\'s `session_ask` with your result; `delivery` is `steer` by default so the reply preempts the peer\'s running turn, and `queue` waits behind it. ' +
        'Refuses a `done ` session with a typed error, like `session_send`.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          text: { type: 'string', description: 'Message text, delivered verbatim' },
          re: { type: 'string', description: 'The message id this reply answers; carried as metadata.re' },
          resume: { type: 'boolean', description: 'Let the receiver loop run; default true' },
          delivery: { type: 'string', description: '`steer` preempts the peer\'s current turn, `queue` waits for it; default steer' },
          metadata: { type: 'object', description: 'Optional object merged with { re } in the prompt body' },
        },
        required: ['to', 'text', 're'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        if (typeof args.text !== 'string' || !args.text) {
          return fail('bad_request', 'text must be a non-empty string');
        }
        if (typeof args.re !== 'string' || !args.re) {
          return fail('bad_request', 're must be the message id this reply answers');
        }
        const dlv = deliveryOf(args, 'steer');
        if (!dlv.ok) return fail(dlv.error, dlv.reason);
        const resume = args.resume === undefined ? true : !!args.resume;
        const meta = metadataOf(args);
        if (!meta.ok) return fail(meta.error, meta.reason);
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        const f = await findSession(t.id);
        if (!f.ok) {
          if (f.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + f.detail);
          return fail(f.code, 'list failed: ' + f.detail);
        }
        const lock = doneRefusal(f.session);
        if (lock) return fail(lock.error, lock.reason);
        const body = { text: args.text, resume, delivery: dlv.value, metadata: { ...(meta.value || {}), re: args.re } };
        const r = await runApi(['post', '/api/session/' + t.id + '/prompt', '--data', JSON.stringify(body)]);
        if (!r.ok) {
          if (r.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + r.detail);
          return fail(r.code, 'send failed: ' + r.detail);
        }
        const d = r.json.data || {};
        return done({ id: d.id, sessionID: d.sessionID || t.id, created: (d.time && d.time.created) || 0 });
      },
    });

    tools.add({
      name: 'session_thread',
      description:
        'Read one exchange from a peer as an ordered both-sides view starting at the given message id, stopping before the next question. ' +
        'Fire when an answer needs its asking message beside it to make sense.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          messageID: { type: 'string', description: 'The message id the exchange starts at' },
        },
        required: ['to', 'messageID'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        if (typeof args.messageID !== 'string' || !args.messageID) {
          return fail('bad_request', 'messageID must be a message id in that session');
        }
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates, t.truncated);
        const got = await collectMessagesDesc(t.id, ASK_MESSAGE_LIMIT, ASK_MAX_PAGES);
        if (!got.ok) {
          if (got.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + got.detail);
          return fail(got.code || 'backend_error', 'read failed: ' + (got.detail || 'request failed'));
        }
        const asc = got.messages.slice().reverse();
        const at = asc.findIndex((m) => m && m.id === args.messageID);
        if (at < 0) return fail('message_not_found', 'message ' + args.messageID + ' is not in session ' + t.id);
        const view = [];
        for (let i = at; i < asc.length; i++) {
          if (i > at && asc[i] && asc[i].type === 'user') break;
          view.push(messageRow(asc[i]));
        }
        return done({ sessionID: t.id, messageID: args.messageID, messages: view });
      },
    });

    tools.add({
      name: 'session_broadcast',
      description:
        'Ask one question of many peer sessions at once and return one row per target with its answer or its error. ' +
        'Fire to fan out to a dispatcher\'s workers; one peer\'s failure is a row, never a rejection.',
      input: {
        type: 'object',
        properties: {
          targets: { type: 'array', description: 'Session ids or title substrings, one per worker' },
          text: { type: 'string', description: 'Message text, delivered verbatim to every target' },
          resume: { type: 'boolean', description: 'Let each receiver loop run; default true' },
          delivery: { type: 'string', description: '`steer` preempts each peer\'s current turn, `queue` waits for it; default steer' },
          waitMs: { type: 'number', description: 'How long to wait for each peer to idle; default 120000' },
          metadata: { type: 'object', description: 'Optional object carried in every prompt body' },
        },
        required: ['targets', 'text'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        if (!Array.isArray(args.targets) || args.targets.length === 0) {
          return fail('bad_request', 'targets must be a non-empty array of session ids or title substrings');
        }
        for (const target of args.targets) {
          if (typeof target !== 'string' || !target) return fail('bad_request', 'every target must be a session id or title substring');
        }
        if (typeof args.text !== 'string' || !args.text) {
          return fail('bad_request', 'text must be a non-empty string');
        }
        const dlv = deliveryOf(args, 'steer');
        if (!dlv.ok) return fail(dlv.error, dlv.reason);
        const resume = args.resume === undefined ? true : !!args.resume;
        const w = parseWaitMs(args.waitMs, ASK_DEFAULT_WAIT_MS);
        if (!w.ok) return fail(w.error, w.reason);
        const meta = metadataOf(args);
        if (!meta.ok) return fail(meta.error, meta.reason);
        const flow = { text: args.text, resume, delivery: dlv.value, waitMs: w.value, metadata: meta.value };
        const settled = await Promise.allSettled(args.targets.map((target) => askTarget(target, flow)));
        const rows = settled.map((s, i) => {
          if (s.status === 'fulfilled') return s.value;
          return { ok: false, target: args.targets[i], sessionID: '', error: 'backend_error', reason: 'ask failed: ' + String((s.reason && s.reason.message) || s.reason) };
        });
        return done(rows);
      },
    });
  });
  registrations.set(key, registration);
  return registration;
}

export { doneRefusal, ensureTools, listSessions, resolveTarget, setApiRunner, stripPrefix };

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
