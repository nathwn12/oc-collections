// Offline contract tests for the plugin surface.
//
// These prove what a host can break without any peer running: all nine verbs
// register with their exact routing descriptions, one prefix rewrite never
// stacks, `done` is a lock the lifecycle verbs refuse while `open` alone lifts
// it, and title resolution answers with candidates or near-misses instead of a
// guess — plus that no removal verb exists anywhere in the source.
//
// Nothing here reaches the network or starts a real peer: every resolution test
// injects its own session scan, and the only tool calls made are ones that fail
// validation before any backend call happens. The live round trip (send a
// message to a real session and read its reply) is proven in the host, not here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ENTRY = path.join(import.meta.dirname, '..', 'src', 'index.js');

let loads = 0;
// Fresh module instance per test: the live registration handle is per-instance
// state, and a cached module would carry one test's registration into the next.
const load = () => import(pathToFileURL(ENTRY).href + '?n=' + ++loads);

const NINE = [
  'session_list',
  'session_send',
  'session_read',
  'session_close',
  'session_open',
  'session_kick',
  'session_park',
  'session_kill',
  'session_await',
];

const DESCRIPTIONS = {
  session_list:
    'List every live OpenCode session as id, title, directory and last-update time. ' +
    'Fire when you need to find a peer session to talk to, or to turn a title into an id. ' +
    'Lists only: it never sends, reads, wakes, or steers anything.',
  session_send:
    'Deliver one text message to another session by id (ses_...) or unambiguous title substring, with resume defaulting to true. ' +
    'Fire instead of dispatching a lane whenever a peer must act; `delivery` is `queue` by default so the peer finishes its turn, and `steer` preempts that turn instead. ' +
    'Refuses a `done ` session with a typed error, and never guesses: a missing or ambiguous title fails with candidates.',
  session_read:
    "Read another session's newest messages by id (ses_...) or unambiguous title substring, newest first, default 20, text verbatim. " +
    'Fire when you need what a peer actually said. ' +
    'Reads only: it never sends, wakes, or steers the other session, and never guesses — a missing or ambiguous title fails with candidates.',
  session_close:
    'Close a finished session in one call: rewrite its title to `done <work>`, then compact it, in that order. ' +
    'An explicit title is normalized to the same `done ` prefix, and an already-closed session is left byte-identical and reported `already-closed`. ' +
    'Fire when a session is finished and must stop reading as live.',
  session_open:
    'Create a session titled `active <work>`, optionally delivering one prompt, or revive the one live session whose title contains <work>; `delivery` is `queue` by default so the peer finishes its turn, `steer` to preempt it. ' +
    'The only verb that may lift `done`; zero matches create, several fail ambiguous with candidates, and a capped scan creates instead of reviving. ' +
    'Fire when work needs a fresh lane, or a closed one revived.',
  session_kick:
    'Wake a live session with one message, renaming it to `active <work>` first; `delivery` is `queue` by default so the peer finishes its turn, `steer` to preempt that turn. ' +
    'Fire when a peer already exists and must act now. ' +
    'Refuses a `done ` session with a typed error: reopen it with session_open instead.',
  session_park:
    'Park a live session: rewrite its title to `parked <work>` and return. ' +
    'Fire when a session should stop reading as active without being closed; prefix only, so no message is sent and no compaction runs. ' +
    'Refuses a `done ` session with a typed error; session_open is the only revival path.',
  session_kill:
    'Stop a live session hard: rewrite its title to `parked <work>`, then interrupt its active execution; park is graceful, kill is hard. ' +
    'The interrupt covers only the target session: cascaded is always false and live child sessions return as children ids, never claimed stopped. ' +
    'Refuses a `done ` session with a typed error; session_open is the only revival path.',
  session_await:
    'Send one message then wait for the reply, polling the session messages about once per second up to timeoutMs (default 60s, cap 300s), returning {text, messageId} or {timeout: true, lastSeen}. ' +
    'Fire when you are blocked on the answer; `delivery` is `steer` by default so the message preempts the peer\'s current turn, and `queue` waits behind it. ' +
    'Refuses a `done ` session with a typed error; session_open is the only revival path.',
};

const SESSIONS = [
  { id: 'ses_a', title: 'build lane', directory: '/work/a', updated: 10 },
  { id: 'ses_b', title: 'build lane two', directory: '/work/b', updated: 20 },
  { id: 'ses_solo', title: 'smoke tests', directory: '/work/c', updated: 30 },
];

// The scan seam the resolver takes in place of the real paginated backend.
const scan = async () => ({ ok: true, sessions: SESSIONS });

// A host-shaped ctx whose tool domain records everything the plugin adds.
function host() {
  const added = [];
  const ctx = {
    tool: {
      transform: async (fn) => fn({ add: (tool) => added.push(tool) }),
    },
  };
  return { ctx, added };
}

test('the V2 definition registers all nine tools through setup', async () => {
  const mod = await load();

  // A host with no tool domain registers nothing and must not throw.
  await assert.doesNotReject(() => mod.default.setup({ tool: {} }));
  await assert.doesNotReject(() => mod.default.setup(undefined));

  const { ctx, added } = host();
  await mod.default.setup(ctx);
  assert.deepEqual(added.map((t) => t.name), NINE);

  for (const tool of added) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.options.codemode, false);
    assert.equal(tool.description, DESCRIPTIONS[tool.name], 'routing description drifted: ' + tool.name);
  }
});

// The port itself. The V2 host loads a V1 object export and never calls its
// setup — the failure this release fixes — so the export must be exactly what
// `Plugin.define` returns: an id and a setup, with no V1 `server` member that
// would read as a live path while never running.
test('the default export is a V2 definition: id plus setup, no V1 server', async () => {
  const mod = await load();
  assert.deepEqual(Object.keys(mod.default).sort(), ['id', 'setup']);
  assert.equal(mod.default.id, 'oc-talk');
  assert.equal(typeof mod.default.setup, 'function');
  assert.equal(mod.default.server, undefined, 'a V1 server export is dead weight in V2');
});

test('an ambiguous title returns candidates instead of guessing', async () => {
  const { resolveTarget } = await load();
  const r = await resolveTarget('build lane', scan);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ambiguous_session');
  assert.match(r.reason, /^2 sessions match "build lane"/);
  assert.deepEqual(r.candidates, [
    { id: 'ses_a', title: 'build lane' },
    { id: 'ses_b', title: 'build lane two' },
  ]);

  const one = await resolveTarget('smoke', scan);
  assert.deepEqual(one, { ok: true, id: 'ses_solo' });

  // Case-sensitive by contract: a differently-cased title is a miss, not a guess.
  const cased = await resolveTarget('Build lane', scan);
  assert.equal(cased.error, 'session_not_found');
  assert.deepEqual(cased.candidates.map((c) => c.id), ['ses_a', 'ses_b', 'ses_solo']);
});

test('a missing session returns a typed error, never a throw', async () => {
  const { resolveTarget } = await load();
  const r = await resolveTarget('no such session', scan);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'session_not_found');
  assert.match(r.reason, /no session title contains "no such session"/);
  assert.deepEqual(r.candidates.map((c) => c.id), ['ses_a', 'ses_b', 'ses_solo']);

  const empty = await resolveTarget('anything', async () => ({ ok: true, sessions: [] }));
  assert.equal(empty.error, 'session_not_found');
  assert.deepEqual(empty.candidates, []);

  // A failed list is reported, not thrown.
  const failedList = await resolveTarget('anything', async () => ({ ok: false, code: 'backend_unavailable', detail: 'gone' }));
  assert.equal(failedList.error, 'backend_unavailable');

  // The tool boundary turns a typed failure into JSON content, and validation
  // fails before any backend call: no network is touched here.
  const { ctx, added } = host();
  await (await load()).default.setup(ctx);
  const send = added.find((t) => t.name === 'session_send');
  const out = await send.execute({ to: 'ses_x' });
  assert.deepEqual(JSON.parse(out.content), {
    error: 'bad_request',
    reason: 'text must be a non-empty string',
  });
});

test('an id-shaped target resolves by direct GET, never a list scan', async () => {
  const { resolveTarget } = await load();
  let scans = 0;
  let asked = '';
  const countedScan = async () => {
    scans++;
    return { ok: true, sessions: SESSIONS };
  };
  const getter = async (id) => {
    asked = id;
    return { ok: true, session: { id } };
  };

  assert.deepEqual(await resolveTarget('ses_a', countedScan, getter), { ok: true, id: 'ses_a' });
  assert.equal(asked, 'ses_a', 'the id must reach the direct getter verbatim');
  assert.equal(scans, 0, 'an id must never trigger a list scan');

  const gone = await resolveTarget('ses_gone', countedScan, async () => ({ ok: false, code: 'session_not_found', detail: 'not found' }));
  assert.equal(gone.error, 'session_not_found');
  assert.match(gone.reason, /session ses_gone is gone: not found/);

  const failed = await resolveTarget('ses_a', countedScan, async () => ({ ok: false, code: 'backend_error', detail: 'boom' }));
  assert.equal(failed.error, 'backend_error');
  assert.match(failed.reason, /lookup failed: boom/);
});

test('the lifecycle prefix is replaced, never stacked', async () => {
  const { stripPrefix } = await load();

  // One work label through the whole lifecycle: park, revive, close.
  const parked = 'parked ' + stripPrefix('foo');
  const revived = 'active ' + stripPrefix(parked);
  const closed = 'done ' + stripPrefix(revived);
  assert.equal(parked, 'parked foo');
  assert.equal(revived, 'active foo');
  assert.equal(closed, 'done foo');

  // Prefixes an older build stacked collapse instead of growing.
  assert.equal(stripPrefix('parked active foo'), 'foo');
  assert.equal('active ' + stripPrefix('done parked foo'), 'active foo');
  assert.equal('done ' + stripPrefix('active parked done foo'), 'done foo');

  // Stripping a clean or empty title is a no-op, never a throw.
  assert.equal(stripPrefix('foo'), 'foo');
  assert.equal(stripPrefix(''), '');
  assert.equal(stripPrefix(undefined), '');
});

test('`done` is a lock: kick refuses it, open alone revives', async () => {
  const mod = await load();

  assert.deepEqual(mod.doneRefusal({ title: 'done build lane' }), {
    error: 'session_closed',
    reason: 'session "done build lane" is closed (done); session_open is the only verb that may revive it',
  });
  assert.equal(mod.doneRefusal({ title: 'active build lane' }), null);
  assert.equal(mod.doneRefusal({ title: 'parked build lane' }), null);
  assert.equal(mod.doneRefusal({ title: '' }), null);

  // Wiring: every verb that must refuse consults the shared lock in its own
  // execute body, and session_open — the only revival path — does not.
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const body = (name) => added.find((t) => t.name === name).execute.toString();
  for (const name of ['session_send', 'session_kick', 'session_park', 'session_kill', 'session_await']) {
    assert.match(body(name), /doneRefusal\(/, name + ' must refuse a done session');
  }
  for (const name of ['session_open', 'session_list', 'session_read', 'session_close']) {
    assert.doesNotMatch(body(name), /doneRefusal\(/, name + ' must not consult the done lock');
  }
});

test('a truncated scan refuses instead of resolving a single match', async () => {
  const { resolveTarget } = await load();
  const capped = async () => ({ ok: true, sessions: SESSIONS, truncated: true, pages: 20 });

  // The probe that motivated the fix: one hit on a capped scan used to authorize.
  const r = await resolveTarget('smoke', capped);
  assert.equal(r.ok, false, 'a capped scan must not authorize a target');
  assert.equal(r.error, 'ambiguous_scan');
  assert.equal(r.truncated, true);
  assert.match(r.reason, /scan truncated at 20 pages; 1 scanned session\(s\) match "smoke"; use the full id/);
  assert.deepEqual(r.candidates, [{ id: 'ses_solo', title: 'smoke tests' }]);

  // The id path never scans, so a capped estate cannot touch it.
  let scans = 0;
  const counted = async () => {
    scans++;
    return { ok: true, sessions: SESSIONS, truncated: true, pages: 20 };
  };
  const viaId = await resolveTarget('ses_solo', counted, async (id) => ({ ok: true, session: { id } }));
  assert.deepEqual(viaId, { ok: true, id: 'ses_solo' });
  assert.equal(scans, 0);

  // A complete scan still resolves one hit; a capped scan that found nothing
  // resolves nothing either, and still reports itself as partial.
  assert.deepEqual(await resolveTarget('smoke', scan), { ok: true, id: 'ses_solo' });
  const none = await resolveTarget('no such session', capped);
  assert.equal(none.error, 'session_not_found');
  assert.equal(none.truncated, true);
});

test('session_send refuses a `done` session, and retitle re-checks the lock itself', async () => {
  const mod = await load();
  assert.equal(mod.doneRefusal({ title: 'done build lane' }).error, 'session_closed');

  // session_send posts a prompt with no rename of its own, so the lock must be
  // consulted in its own body, before the prompt is posted.
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const body = added.find((t) => t.name === 'session_send').execute.toString();
  const lock = body.indexOf('doneRefusal(');
  assert.ok(lock >= 0, 'session_send must consult the done lock');
  assert.ok(body.indexOf('/prompt') > lock, 'the lock must be checked before the prompt is posted');

  // retitle re-reads the session, so it carries its own check: a close landing
  // between the caller's check and that read is refused there, not only above.
  const src = fs.readFileSync(ENTRY, 'utf8');
  const retitle = src.slice(src.indexOf('async function retitle('), src.indexOf('// The only timer'));
  const relock = retitle.indexOf('doneRefusal(');
  assert.ok(relock >= 0, 'retitle must re-check the done lock itself');
  assert.ok(retitle.indexOf("'/api/session/'") > relock, 'retitle must check the lock before it patches');
});

test('source carries no credential, localhost reference or removal verb', () => {
  const src = fs.readFileSync(ENTRY, 'utf8');
  assert.doesNotMatch(src, /password|service\.json|127\.0\.0\.1/);
  // No removal capability in any spelling: the surface is nine verbs, none of
  // which removes a session.
  assert.doesNotMatch(src, /delete/i);
});

// A recording backend: every call is captured and each verb answers with the
// smallest payload its caller needs, so a whole tool execute runs offline with
// no peer, no CLI and no network.
function recorder(session = { id: 'ses_a', title: 'active work' }) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const [verb, target] = args;
    if (verb === 'session.get') return { ok: true, json: { data: session } };
    if (verb === 'session.list') return { ok: true, json: { data: [] } };
    if (verb === 'patch') return { ok: true, json: { data: {} } };
    if (verb === 'session.message.list') {
      return { ok: true, json: { data: [{ id: 'msg_reply', type: 'assistant', time: { created: Date.now() + 5000 }, text: 'done' }] } };
    }
    if (verb === 'post' && String(target).endsWith('/prompt')) {
      return { ok: true, json: { data: { id: 'msg_sent', sessionID: session.id, time: { created: 1 } } } };
    }
    if (verb === 'post' && target === '/api/session') return { ok: true, json: { data: { id: 'ses_new' } } };
    return { ok: true, json: { data: {} } };
  };
  return { calls, run };
}

// One fresh module, one registered tool, pointed at a recording backend.
async function toolWith(name) {
  const mod = await load();
  const rec = recorder();
  mod.setApiRunner(rec.run);
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  return { tool: added.find((t) => t.name === name), calls: rec.calls };
}

// The prompt body the backend actually received, parsed: the payload, not the
// intent, is what these cases assert on.
function promptBody(calls) {
  const call = calls.find((a) => a[0] === 'post' && String(a[1]).endsWith('/prompt'));
  return call ? JSON.parse(call[3]) : null;
}

// tool -> the delivery its caller means by default, plus a minimal valid input.
const DELIVERY_DEFAULTS = [
  { tool: 'session_send', input: { to: 'ses_a', text: 'hi' }, want: 'queue' },
  { tool: 'session_kick', input: { to: 'ses_a', text: 'hi' }, want: 'queue' },
  { tool: 'session_open', input: { work: 'api-smoke-tests', text: 'hi' }, want: 'queue' },
  { tool: 'session_await', input: { to: 'ses_a', text: 'hi' }, want: 'steer' },
];

test('each prompt tool sends its own default delivery, and an explicit value wins', async () => {
  for (const c of DELIVERY_DEFAULTS) {
    const byDefault = await toolWith(c.tool);
    assert.ok(byDefault.tool, c.tool + ' must register');
    const out = await byDefault.tool.execute(c.input);
    assert.equal(JSON.parse(out.content).error, undefined, c.tool + ' default run failed: ' + out.content);
    const body = promptBody(byDefault.calls);
    assert.ok(body, c.tool + ' must post a prompt');
    assert.equal(body.delivery, c.want, c.tool + ' default delivery must be ' + c.want);

    // The other value is honoured: an explicit argument always wins.
    const other = c.want === 'queue' ? 'steer' : 'queue';
    const explicit = await toolWith(c.tool);
    const out2 = await explicit.tool.execute({ ...c.input, delivery: other });
    assert.equal(JSON.parse(out2.content).error, undefined, c.tool + ' override run failed: ' + out2.content);
    assert.equal(promptBody(explicit.calls).delivery, other, c.tool + ' must honour an explicit ' + other);
  }
});

test('an invalid delivery is a typed bad_request, never a silent default', async () => {
  for (const c of DELIVERY_DEFAULTS) {
    const { tool, calls } = await toolWith(c.tool);
    const out = await tool.execute({ ...c.input, delivery: 'later' });
    assert.deepEqual(JSON.parse(out.content), {
      error: 'bad_request',
      reason: 'delivery must be "steer" or "queue"',
    }, c.tool + ' must refuse an invalid delivery');
    assert.equal(calls.length, 0, c.tool + ' must refuse before any backend call');
  }
});

test('descriptions stay at three sentences or fewer and state the delivery rule', async () => {
  const { ctx, added } = host();
  await (await load()).default.setup(ctx);
  const sentences = (d) => d.split(/(?<=[.!?])\s+/).filter(Boolean).length;

  for (const tool of added) {
    const n = sentences(tool.description);
    assert.ok(n <= 3, tool.name + ' description is ' + n + ' sentences: ' + tool.description);
    if (!DELIVERY_DEFAULTS.some((c) => c.tool === tool.name)) continue;
    // The two states and this tool's own default, in one clause.
    assert.match(tool.description, /`steer`/, tool.name + ' must name steer');
    assert.match(tool.description, /`queue`/, tool.name + ' must name queue');
    const want = DELIVERY_DEFAULTS.find((c) => c.tool === tool.name).want;
    assert.ok(tool.description.includes('`' + want + '` by default'), tool.name + ' must state its ' + want + ' default');
    assert.equal(tool.input.properties.delivery.type, 'string', tool.name + ' must accept a delivery argument');
  }
});

// A reload-shaped host: `transform` records every registration it hands out and
// the tools each one added, so a test can see what is live and what was disposed.
function reloadHost() {
  const registrations = [];
  const ctx = {
    tool: {
      transform: async (fn) => {
        const entry = { added: [], disposed: 0 };
        fn({ add: (tool) => entry.added.push(tool) });
        registrations.push(entry);
        return { dispose: async () => { entry.disposed++; } };
      },
    },
  };
  return { ctx, registrations };
}

test('a reload re-registers tools: setup twice leaves exactly one live registration', async () => {
  const mod = await load();
  const { ctx, registrations } = reloadHost();

  await mod.ensureTools(ctx);
  assert.equal(registrations.length, 1, 'the first call must register');
  assert.deepEqual(registrations[0].added.map((t) => t.name), NINE);
  assert.equal(registrations[0].disposed, 0, 'the first registration starts live');

  // The reload shape: the host disposed the previous transform and re-ran setup
  // on the same cached module instance. A one-shot guard returned here and left
  // zero tools, so the second call must register again rather than skip.
  await mod.ensureTools(ctx);
  assert.equal(registrations.length, 2, 'a reload must register again, not skip');
  assert.equal(registrations[0].disposed, 1, 'the previous registration must be disposed');
  assert.equal(registrations[1].disposed, 0, 'the new registration must be the live one');
  assert.deepEqual(registrations[1].added.map((t) => t.name), NINE);

  // The same shape through the public surface the host actually calls.
  const viaSetup = reloadHost();
  await mod.default.setup(viaSetup.ctx);
  await mod.default.setup(viaSetup.ctx);
  assert.equal(viaSetup.registrations.length, 2, 'setup must re-register on reload');
  assert.equal(viaSetup.registrations[0].disposed, 1);
  assert.equal(viaSetup.registrations[1].disposed, 0);
});

test('setup resolves to void and leaves exactly one live registration', async () => {
  const mod = await load();
  const { ctx, registrations } = reloadHost();

  // The definition's setup is async and resolves to nothing: disposal on unload
  // belongs to the V2 host, and `ensureTools` is what keeps one live
  // registration across a reload.
  assert.equal(await mod.default.setup(ctx), undefined);
  assert.equal(registrations.length, 1, 'setup must register');
  assert.deepEqual(registrations[0].added.map((t) => t.name), NINE);
  assert.equal(registrations[0].disposed, 0, 'the registration is live after setup');
});

