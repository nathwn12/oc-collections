// The one place in this package that speaks HTTP to the harness's own service.
//
// Every call is one authenticated round-trip against the local service that the
// harness already runs: no CLI child per call, no credential arguments, no port
// guessing at the call site. The service state file publishes `0.0.0.0:<port>`;
// this client always dials loopback, so the wildcard bind is never advertised to
// a caller and no port is ever constructed from anything but that file.
//
// Error vocabulary is fixed and is the same four codes the old CLI seam returned,
// so no caller changes shape: `backend_unavailable`, `timeout`,
// `session_not_found`, `backend_error`. Nothing here throws.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const STATE_FILE = path.join(os.homedir(), '.local', 'state', 'opencode', 'service.json');
const AUTH_USER = 'opencode';
const REQUEST_TIMEOUT_MS = 20000;
// One keep-alive agent for the whole module: the service is a sibling process on
// loopback, so reconnecting per call is pure waste. No dependency, no pool tuning.
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

let cached = null;

// Resolve and cache the endpoint: base URL plus the one auth header ever built.
// A missing or malformed state file is `backend_unavailable`, never a throw.
function serviceEndpoint() {
  if (cached) return cached;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    return { error: { ok: false, code: 'backend_unavailable', detail: 'opencode service state is unreadable: ' + String((err && err.message) || err) } };
  }
  const password = raw && raw.password;
  // The state file publishes `http://0.0.0.0:<port>`; rewrite the host to
  // loopback, which is the only address this client dials.
  let published = null;
  try {
    published = new URL(String(raw && raw.url));
  } catch {
    published = null;
  }
  const port = published ? Number(published.port) : Number(raw && raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof password !== 'string' || !password) {
    return { error: { ok: false, code: 'backend_unavailable', detail: 'opencode service state carries no usable url and password' } };
  }
  const host = '127.0.0.1';
  cached = {
    base: 'http://' + host + ':' + port,
    host,
    port,
    published: published ? published.host : '',
    auth: 'Basic ' + Buffer.from(AUTH_USER + ':' + password).toString('base64'),
  };
  return cached;
}

function query(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}

// One request. `body` is an object serialized as JSON or undefined. `signal`
// comes from the tool execute context, so an aborted turn cancels the call.
function request(method, pathname, opts) {
  const settings = opts || {};
  const ep = serviceEndpoint();
  if (ep.error) return Promise.resolve(ep.error);
  const url = new URL(ep.base + pathname + query(settings.query));
  const payload = settings.body === undefined ? '' : JSON.stringify(settings.body);
  const headers = { authorization: ep.auth, accept: 'application/json' };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request(
      { method, host: url.hostname, port: url.port, path: url.pathname + url.search, headers, agent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if (text.trim()) {
            try {
              json = JSON.parse(text);
            } catch {
              finish({ ok: false, code: 'backend_error', detail: 'server returned non-JSON output' });
              return;
            }
          }
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            finish({ ok: true, status, json: json === null ? { data: {} } : json });
            return;
          }
          const tag = String((json && json._tag) || '');
          const detail = String((json && (json.message || json.data)) || tag || 'request failed');
          if (status === 404 || /notfound/i.test(tag)) {
            finish({ ok: false, status, code: 'session_not_found', detail });
            return;
          }
          finish({ ok: false, status, code: 'backend_error', detail: status + ' ' + detail });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, code: 'timeout', detail: 'service call exceeded ' + REQUEST_TIMEOUT_MS + 'ms' });
    }, REQUEST_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    const onAbort = () => {
      req.destroy();
      finish({ ok: false, code: 'timeout', detail: 'request aborted by the caller' });
    };
    if (settings.signal) {
      if (settings.signal.aborted) {
        onAbort();
      } else {
        settings.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    req.on('error', (err) => {
      clearTimeout(timer);
      const code = err && (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') ? 'backend_unavailable' : 'backend_error';
      finish({ ok: false, code, detail: String((err && err.message) || err).slice(-200) });
    });
    req.on('close', () => clearTimeout(timer));
    if (payload) req.write(payload);
    req.end();
  });
}

// Durable admission of one input, 200 in milliseconds. `id` is client-chosen and
// idempotent, so a retried send returns the original admission instead of
// running the prompt hooks twice. The target acts on it at its next turn.
function prompt(sessionID, opts) {
  const body = { text: opts.text, delivery: opts.delivery || 'queue' };
  if (opts.id) body.id = opts.id;
  if (opts.metadata !== undefined) body.metadata = opts.metadata;
  return request('POST', '/api/session/' + encodeURIComponent(sessionID) + '/prompt', { body, signal: opts.signal });
}

// One page of messages: `{data, cursor:{previous,next}}`. Newest first unless the
// caller asks `order=asc`. A cursor is passed through verbatim, never built, and
// never travels with `order` (the server 400s that pair).
function messages(sessionID, opts) {
  const o = opts || {};
  const q = { limit: o.limit };
  if (o.cursor) q.cursor = o.cursor;
  else if (o.order) q.order = o.order;
  if (o.type) q.type = o.type;
  return request('GET', '/api/session/' + encodeURIComponent(sessionID) + '/message', { query: q, signal: o.signal });
}

// Title -> id resolution. The host ignores `?title=`; `search` is the key that
// actually matches a title substring.
function searchSessions(text, opts) {
  const o = opts || {};
  return request('GET', '/api/session', { query: { search: text, limit: o.limit, cursor: o.cursor }, signal: o.signal });
}

// One session by id; a 404 is a truthful session_not_found.
function session(sessionID, opts) {
  return request('GET', '/api/session/' + encodeURIComponent(sessionID), { signal: (opts || {}).signal });
}

function createSession(body, opts) {
  return request('POST', '/api/session', { body: body || {}, signal: (opts || {}).signal });
}

// The seam keeps the argv dialect its callers already speak — the same strings
// the CLI child used to receive — and answers the same `{ok, json}` shape, so
// every call site and the offline suite are unchanged while the wire underneath
// is HTTP. Only the verbs this package still calls are understood.
function param(args, name) {
  const hit = args.find((a) => typeof a === 'string' && a.startsWith(name + '='));
  return hit === undefined ? undefined : hit.slice(name.length + 1);
}

function call(args, opts) {
  const o = opts || {};
  const [verb, target] = args;
  if (verb === 'session.get') {
    return session(param(args, 'sessionID'), o);
  }
  if (verb === 'session.list') {
    return request('GET', '/api/session', {
      query: { limit: param(args, 'limit'), cursor: param(args, 'cursor'), parentID: param(args, 'parentID'), search: param(args, 'search') },
      signal: o.signal,
    });
  }
  if (verb === 'session.message.list') {
    const sid = param(args, 'sessionID');
    const q = { limit: param(args, 'limit') };
    const cursor = param(args, 'cursor');
    if (cursor) q.cursor = cursor;
    else if (param(args, 'order')) q.order = param(args, 'order');
    if (param(args, 'type')) q.type = param(args, 'type');
    return request('GET', '/api/session/' + encodeURIComponent(sid) + '/message', { query: q, signal: o.signal });
  }
  if (verb === 'post') {
    const bodyIndex = args.indexOf('--data');
    const body = bodyIndex > 0 ? args[bodyIndex + 1] : undefined;
    if (String(target).endsWith('/prompt')) {
      const sid = String(target).split('/')[3];
      return prompt(sid, { ...JSON.parse(body || '{}'), signal: o.signal });
    }
    if (target === '/api/session') {
      return createSession(JSON.parse(body || '{}'), o);
    }
  }
  return Promise.resolve({ ok: false, code: 'backend_error', detail: 'unsupported call: ' + String(verb) });
}

export { call, createSession, messages, prompt, request, searchSessions, serviceEndpoint, session };
