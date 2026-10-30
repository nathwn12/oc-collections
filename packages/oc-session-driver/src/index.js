// oc-session-driver — cross-session talk for any OpenCode harness.
//
// Three tools: session_list, session_send, session_read.
//
// The backend is the `opencode` CLI itself, reached with argv (no shell) and a
// hard timeout. That CLI discovers and authenticates with the harness's own
// background server, so no credential file is opened here, no port is resolved
// here, and no secret ever crosses this module: the child process holds its own
// authentication and this module only ever sees the JSON it prints.
import { execFile } from 'node:child_process';

const BIN = 'opencode';
const TIMEOUT_MS = 20000;
const READ_DEFAULT_LIMIT = 20;
const READ_MAX_LIMIT = 100;

let registered = false;

function fail(error, reason, candidates) {
  const out = { error, reason };
  if (candidates !== undefined) out.candidates = candidates;
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
function runApi(args) {
  return new Promise((resolve) => {
    execFile(pickBin(), ['api', ...args], { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      const out = String(stdout || '');
      if (!error) {
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

async function listSessions() {
  const r = await runApi(['get', '/api/session']);
  if (!r.ok) return r;
  const rows = Array.isArray(r.json.data) ? r.json.data : [];
  return {
    ok: true,
    sessions: rows.map((s) => ({
      id: s.id,
      title: s.title || '',
      directory: (s.location && s.location.directory) || '',
      updated: (s.time && s.time.updated) || 0,
    })),
  };
}

function nearMisses(sessions, query) {
  const q = String(query).toLowerCase();
  const hits = sessions.filter((s) => s.title.toLowerCase().includes(q));
  const rest = sessions.filter((s) => !s.title.toLowerCase().includes(q));
  return hits.concat(rest).slice(0, 5).map((s) => ({ id: s.id, title: s.title }));
}

// Exact-substring title match, case-sensitive. Never guesses.
// `lister` is injectable so resolution can be proved offline; the tools always
// call it with the real lister.
async function resolveTarget(to, lister = listSessions) {
  if (typeof to !== 'string' || !to) {
    return { ok: false, error: 'bad_request', reason: 'to must be a session id or title substring' };
  }
  if (to.startsWith('ses_')) return { ok: true, id: to };
  const listed = await lister();
  if (!listed.ok) return { ok: false, error: listed.code, reason: 'list failed: ' + listed.detail };
  const hits = listed.sessions.filter((s) => s.title.includes(to));
  if (hits.length === 1) return { ok: true, id: hits[0].id };
  if (hits.length === 0) {
    return { ok: false, error: 'session_not_found', reason: 'no session title contains "' + to + '"', candidates: nearMisses(listed.sessions, to) };
  }
  return { ok: false, error: 'ambiguous_session', reason: hits.length + ' sessions match "' + to + '"; use the full id', candidates: hits.map((s) => ({ id: s.id, title: s.title })) };
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

async function ensureTools(ctx) {
  if (registered) return;
  const transform = ctx && ctx.tool && ctx.tool.transform;
  if (typeof transform !== 'function') return;
  registered = true;
  await ctx.tool.transform((tools) => {
    tools.add({
      name: 'session_list',
      description:
        'List every live OpenCode session as id, title, directory and last-update time. ' +
        'Fire when you need to find a peer session to talk to, or to turn a title into an id. ' +
        'Lists only: it never sends, reads, wakes, or steers anything.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      options: { codemode: false },
      execute: async () => {
        const r = await listSessions();
        if (!r.ok) return fail(r.code, 'list failed: ' + r.detail);
        return done(r.sessions);
      },
    });

    tools.add({
      name: 'session_send',
      description:
        'Deliver one text message to another session by id (ses_...) or unambiguous title substring, then let its loop run; ' +
        'resume defaults to true because the reply is the point. ' +
        'Fire instead of dispatching a lane whenever a peer must act. ' +
        'Sends one message only: it never reads history, and it never guesses — a missing or ambiguous title fails with candidates.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          text: { type: 'string', description: 'Message text, delivered verbatim' },
          resume: { type: 'boolean', description: 'Let the receiver loop run; default true' },
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
        const resume = args.resume === undefined ? true : !!args.resume;
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates);
        const r = await runApi(['post', '/api/session/' + t.id + '/prompt', '--data', JSON.stringify({ text: args.text, resume })]);
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
        'Read another session\'s newest messages by id (ses_...) or unambiguous title substring, newest first, default 20, text verbatim including newlines. ' +
        'Fire when you need what a peer actually said. ' +
        'Reads only: it never sends, wakes, or steers the other session, and it never guesses — a missing or ambiguous title fails with candidates.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session id (ses_...) or exact title substring' },
          limit: { type: 'number', description: 'Newest messages to return, default 20, max 100' },
        },
        required: ['to'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => {
        const args = input ?? {};
        const t = await resolveTarget(args.to);
        if (!t.ok) return fail(t.error, t.reason, t.candidates);
        let limit = args.limit === undefined ? READ_DEFAULT_LIMIT : Math.floor(args.limit);
        if (!Number.isFinite(limit)) return fail('bad_request', 'limit must be a number');
        limit = Math.min(Math.max(limit, 1), READ_MAX_LIMIT);
        const r = await runApi(['get', '/api/session/' + t.id + '/message', '--param', 'limit=' + limit, '--param', 'order=desc']);
        if (!r.ok) {
          if (r.code === 'session_not_found') return fail('session_not_found', 'session ' + t.id + ' is gone: ' + r.detail);
          return fail(r.code, 'read failed: ' + r.detail);
        }
        const rows = Array.isArray(r.json.data) ? r.json.data : [];
        return done(rows.map((m) => ({ id: m.id, type: m.type, created: (m.time && m.time.created) || 0, text: messageText(m) })));
      },
    });
  });
}

export { ensureTools, listSessions, resolveTarget };

export default {
  id: 'session-talk',
  // V2 config loader: requires id + setup|effect; registers tools when the
  // host exposes the tool domain here, otherwise server retries below.
  setup(ctx) {
    return ensureTools(ctx);
  },
  // Server runtime: same registration gate; no hooks to dispatch.
  server: async (ctx) => {
    await ensureTools(ctx);
    return {};
  },
};
