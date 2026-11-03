// Offline contract tests for the plugin surface.
//
// These prove what a host can break without any peer running: all thirteen
// verbs register with their exact routing descriptions, one prefix rewrite
// never stacks, `done` is a lock the lifecycle verbs refuse while `open` alone
// lifts it, title resolution answers with candidates or near-misses instead of
// a guess, and an ask answers the exact message it asked — proven positionally
// against a transcript with a later unrelated exchange above it — plus that no
// removal verb exists anywhere in the source.
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

const TOOLS = [
  'session_list',
  'session_send',
  'session_read',
  'session_close',
  'session_open',
  'session_kick',
  'session_park',
  'session_kill',
  'session_ask',
  'session_wait',
  'session_reply',
  'session_thread',
  'session_broadcast',
];

const DESCRIPTIONS = {
  session_list:
    'List every live OpenCode session as id, title, directory and last-update time; pass `parentID` to list only one dispatcher\'s workers. ' +
    'Fire when you need to find a peer session to talk to, or to turn a title into an id. ' +
    'Lists only: it never sends, reads, wakes, or steers anything.',
  session_send:
    'Deliver one text message to another session by id (ses_...) or unambiguous title substring, with resume defaulting to true; an optional `metadata` object travels in the prompt body so the peer can see who sent it and which message it answers. ' +
    'Fire instead of dispatching a lane whenever a peer must act; `delivery` is `steer` by default so a correction preempts the peer\'s running turn, and `queue` waits behind it. ' +
    'Refuses a `done ` session with a typed error, and never guesses: a missing or ambiguous title fails with candidates.',
  session_read:
    "Read another session's newest messages by id (ses_...) or unambiguous title substring, newest first, default 20, text verbatim; `cursor` pages forward, `since` keeps only newer messages, and each row carries `metadata`, `outcome`, `finish` and `completed` where the peer sent them. " +
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
    'Wake a live session with one message, renaming it to `active <work>` first; `delivery` is `steer` by default so the message preempts the peer\'s running turn, `queue` to wait behind it. ' +
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
  session_ask:
    'Send one message to a peer and wait until it is idle, then return the assistant messages that answer that exact message and nothing after the next question. ' +
    'Fire when you need a peer\'s answer, not just its newest text; `delivery` is `steer` by default so the question preempts the peer\'s running turn, and `queue` waits behind it. ' +
    'A peer that never idles within `waitMs` returns `timedOut:true` with what exists, never a success.',
  session_wait:
    'Block until a peer session is idle without sending anything, giving up after `waitMs` with `timedOut:true`. ' +
    'Fire when an answer you already asked for needs time to land before you read it.',
  session_reply:
    'Answer the session that asked you: send one message carrying `metadata.re` with the message id it answers. ' +
    'Fire to close someone\'s `session_ask` with your result; `delivery` is `steer` by default so the reply preempts the peer\'s running turn, and `queue` waits behind it. ' +
    'Refuses a `done ` session with a typed error, like `session_send`.',
  session_thread:
    'Read one exchange from a peer as an ordered both-sides view starting at the given message id, stopping before the next question. ' +
    'Fire when an answer needs its asking message beside it to make sense.',
  session_broadcast:
    'Ask one question of many peer sessions at once and return one row per target with its answer or its error. ' +
    'Fire to fan out to a dispatcher\'s workers; one peer\'s failure is a row, never a rejection.',
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

test('the V2 definition registers all thirteen tools through setup', async () => {
  const mod = await load();

  // A host with no tool domain registers nothing and must not throw.
  await assert.doesNotReject(() => mod.default.setup({ tool: {} }));
  await assert.doesNotReject(() => mod.default.setup(undefined));

  const { ctx, added } = host();
  await mod.default.setup(ctx);
  assert.deepEqual(added.map((t) => t.name), TOOLS);

  for (const tool of added) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.options.codemode, false);
    assert.equal(tool.description, DESCRIPTIONS[tool.name], 'routing description drifted: ' + tool.name);
  }
});

// The send-then-poll wait verb queued its message behind the long turn it then
// waited on, so it was removed rather than fixed. An absent tool must fail here
// before a host can offer it again. Its `timeoutMs` spelling stays banned with
// it; the conversation verbs' bounded `waitMs` is the legitimate budget now.
test('session_await is not registered, and the surface is exactly the thirteen verbs', async () => {
  const mod = await load();
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const names = added.map((t) => t.name);

  assert.ok(!names.includes('session_await'), 'session_await must not be registered');
  // Exactly the remaining verbs, in order: no ninth verb and no renamed one.
  assert.deepEqual(names, TOOLS);
  assert.equal(names.length, 13);

  // The source carries no registration for it either, nor its wait budget, so a
  // stray block cannot come back with the tool list silently left at thirteen.
  // `waitMs` is allowed: it is the bounded budget the conversation verbs take.
  const src = fs.readFileSync(ENTRY, 'utf8');
  assert.doesNotMatch(src, /session_await|AWAIT_/);
  assert.match(src, /waitMs/);
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
  for (const name of ['session_send', 'session_kick', 'session_park', 'session_kill']) {
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
  const retitle = src.slice(src.indexOf('async function retitle('), src.indexOf('// `delivery` decides'));
  const relock = retitle.indexOf('doneRefusal(');
  assert.ok(relock >= 0, 'retitle must re-check the done lock itself');
  assert.ok(retitle.indexOf("'/api/session/'") > relock, 'retitle must check the lock before it patches');
});

test('source carries no credential, localhost reference or removal verb', () => {
  const src = fs.readFileSync(ENTRY, 'utf8');
  assert.doesNotMatch(src, /password|service\.json|127\.0\.0\.1/);
  // No removal capability in any spelling: the surface is eight verbs, none of
  // which removes a session. The one exclusion is bookkeeping on this module's
  // own registration map, which is not a tool and not an API route.
  const surface = src.replaceAll('registrations.delete(key)', '');
  assert.doesNotMatch(surface, /delete/i);
});

// The live server rejects cursor+order together with 400 InvalidCursorError:
// `opencode api session.message.list --param sessionID=<id> --param limit=5
// --param order=desc` plus a cursor always 400s on the second page, while the
// same cursor without order succeeds. Every message.list fake below enforces
// the same rule so this class cannot pass again.
function cursorOrderError(args) {
  const hasCursor = args.some((a) => String(a).startsWith('cursor='));
  const hasOrder = args.some((a) => String(a).startsWith('order='));
  if (hasCursor && hasOrder) {
    return { ok: false, code: 'backend_error', detail: 'InvalidCursorError: Cursor cannot be combined with order' };
  }
  return null;
}

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
      const bad = cursorOrderError(args);
      if (bad) return bad;
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
  { tool: 'session_send', input: { to: 'ses_a', text: 'hi' }, want: 'steer' },
  { tool: 'session_kick', input: { to: 'ses_a', text: 'hi' }, want: 'steer' },
  { tool: 'session_open', input: { work: 'api-smoke-tests', text: 'hi' }, want: 'queue' },
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
// `location` is the host's per-boot location: the host boots the plugin once per
// location, and a ctx without one keeps the plugin's stable fallback key.
function reloadHost(location) {
  const registrations = [];
  const ctx = {
    location,
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
  assert.deepEqual(registrations[0].added.map((t) => t.name), TOOLS);
  assert.equal(registrations[0].disposed, 0, 'the first registration starts live');

  // The reload shape: the host disposed the previous transform and re-ran setup
  // on the same cached module instance. A one-shot guard returned here and left
  // zero tools, so the second call must register again rather than skip.
  await mod.ensureTools(ctx);
  assert.equal(registrations.length, 2, 'a reload must register again, not skip');
  assert.equal(registrations[0].disposed, 1, 'the previous registration must be disposed');
  assert.equal(registrations[1].disposed, 0, 'the new registration must be the live one');
  assert.deepEqual(registrations[1].added.map((t) => t.name), TOOLS);

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
  assert.deepEqual(registrations[0].added.map((t) => t.name), TOOLS);
  assert.equal(registrations[0].disposed, 0, 'the registration is live after setup');
});

// The live service boots the plugin once per location — the workspace directory
// and the config directory under it — and each boot owns its own tool domain.
// One module-level registration made the second boot dispose the first boot's
// transform, so that location's sessions saw zero oc-talk tools while the plugin
// still reported active. Registrations are per location, and a reload of one
// location must not touch another's.
test('two host locations each keep their own live registration', async () => {
  const mod = await load();
  const first = reloadHost({ workspaceID: 'ws', directory: 'C:\\proj' });
  const second = reloadHost({ workspaceID: 'ws', directory: 'C:\\proj\\.config\\opencode' });

  // Both boots, in the order the live service logged them.
  await mod.ensureTools(first.ctx);
  await mod.ensureTools(second.ctx);

  assert.equal(first.registrations.length, 1, 'the first location must register');
  assert.equal(second.registrations.length, 1, 'the second location must register');
  assert.equal(first.registrations[0].disposed, 0, 'the second location must not dispose the first location\'s tools');
  assert.equal(second.registrations[0].disposed, 0, 'the second location\'s own registration is live');
  assert.deepEqual(first.registrations[0].added.map((t) => t.name), TOOLS);
  assert.deepEqual(second.registrations[0].added.map((t) => t.name), TOOLS);

  // A reload of one location disposes only its own previous registration.
  await mod.ensureTools(first.ctx);
  assert.equal(first.registrations.length, 2, 'a reload must re-register that location');
  assert.equal(first.registrations[0].disposed, 1, 'a reload disposes its own previous registration');
  assert.equal(first.registrations[1].disposed, 0, 'the re-registered transform is live');
  assert.equal(second.registrations.length, 1, 'the other location must not re-register');
  assert.equal(second.registrations[0].disposed, 0, 'the other location must be untouched');

  // The public surface the host calls takes the same per-location path: a second
  // setup of one location leaves the other location's live transform alone.
  assert.equal(await mod.default.setup(second.ctx), undefined);
  assert.equal(second.registrations.length, 2, 'setup must re-register the same location');
  assert.equal(second.registrations[0].disposed, 1, 'setup disposes that location\'s previous registration');
  assert.equal(second.registrations[1].disposed, 0);
  assert.equal(first.registrations[1].disposed, 0, 'the other location stays live across a setup');
});

// ---- Conversation verbs: ask, wait, reply, thread, broadcast ----

// A fake estate for one peer: the accepted question plus two answers, with a
// later unrelated exchange above them. Newest first, as the backend returns.
function askTranscript() {
  return [
    { id: 'msg_new_asst', type: 'assistant', time: { created: 60 }, text: 'LATER: unrelated answer' },
    { id: 'msg_new_user', type: 'user', time: { created: 59 }, text: 'unrelated later question' },
    { id: 'msg_ans2', type: 'assistant', time: { created: 50 }, text: 'second', outcome: 'completed' },
    { id: 'msg_ans1', type: 'assistant', time: { created: 49 }, text: 'first' },
    { id: 'msg_ours', type: 'user', time: { created: 40 }, text: 'the question' },
    { id: 'msg_old', type: 'assistant', time: { created: 10 }, text: 'older exchange' },
  ];
}

// A fake backend for one peer: prompt accepts with a known id, wait is idle
// at once, and the transcript above is what a read finds. Strict like the
// live server: cursor+order together is a 400 InvalidCursorError. Order-aware
// like the live server: order=asc returns oldest-first, anything else
// (order=desc or no order) returns newest-first.
function askPeerRunner(askedID = 'msg_ours', transcript = askTranscript()) {
  return async (args) => {
    const [verb, target] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_peer', title: 'active peer' } } };
    if (verb === 'post' && String(target).endsWith('/wait')) return { ok: true, json: { data: {} } };
    if (verb === 'post' && String(target).endsWith('/prompt')) {
      return { ok: true, json: { data: { id: askedID, sessionID: 'ses_peer', time: { created: 40 } } } };
    }
    if (verb === 'session.message.list') {
      const bad = cursorOrderError(args);
      if (bad) return bad;
      const wantAsc = args.some((a) => String(a) === 'order=asc');
      const data = wantAsc ? transcript.slice().reverse() : transcript;
      return { ok: true, json: { data } };
    }
    return { ok: true, json: { data: {} } };
  };
}

test('session_ask returns only the assistant messages between our question and the next one', async () => {
  const mod = await load();
  mod.setApiRunner(askPeerRunner());
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const ask = added.find((t) => t.name === 'session_ask');
  const out = JSON.parse((await ask.execute({ to: 'ses_peer', text: 'the question', waitMs: 5000 })).content);
  assert.equal(out.error, undefined, 'ask must succeed: ' + JSON.stringify(out));
  assert.equal(out.sessionID, 'ses_peer');
  assert.equal(out.title, 'active peer');
  assert.equal(out.askedMessageID, 'msg_ours');
  // Positional, not "the last assistant message": the later unrelated exchange
  // above must not leak in, and nothing below the question may either.
  assert.deepEqual(out.answer, [
    { id: 'msg_ans1', text: 'first' },
    { id: 'msg_ans2', text: 'second' },
  ]);
  assert.equal(out.outcome, 'completed');
  assert.equal(out.timedOut, false);
  assert.ok(typeof out.waitedMs === 'number' && out.waitedMs >= 0);
});

test('a peer that never idles reports timedOut:true, never success', async () => {
  const neverIdle = async (args) => {
    const [verb, target] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_busy', title: 'active busy' } } };
    if (verb === 'post' && String(target).endsWith('/wait')) return { ok: false, code: 'timeout', detail: 'opencode api call exceeded 20000ms' };
    if (verb === 'post' && String(target).endsWith('/prompt')) {
      return { ok: true, json: { data: { id: 'msg_q', sessionID: 'ses_busy', time: { created: 1 } } } };
    }
    if (verb === 'session.message.list') {
      const bad = cursorOrderError(args);
      if (bad) return bad;
      return { ok: true, json: { data: [{ id: 'msg_q', type: 'user', time: { created: 1 }, text: 'q' }] } };
    }
    return { ok: true, json: { data: {} } };
  };

  const mod = await load();
  mod.setApiRunner(neverIdle);
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const wait = added.find((t) => t.name === 'session_wait');
  const wout = JSON.parse((await wait.execute({ to: 'ses_busy', waitMs: 40 })).content);
  assert.equal(wout.error, undefined);
  assert.equal(wout.sessionID, 'ses_busy');
  assert.equal(wout.timedOut, true, 'a wait that gave up must say so');
  assert.ok(typeof wout.waitedMs === 'number' && wout.waitedMs >= 0);

  // The ask path asks first, then reports the same flag with what exists.
  const mod2 = await load();
  mod2.setApiRunner(neverIdle);
  const h2 = host();
  await mod2.default.setup(h2.ctx);
  const ask = h2.added.find((t) => t.name === 'session_ask');
  const aout = JSON.parse((await ask.execute({ to: 'ses_busy', text: 'q', waitMs: 40 })).content);
  assert.equal(aout.error, undefined, 'a timeout is a row with a flag, not a failure: ' + JSON.stringify(aout));
  assert.equal(aout.timedOut, true, 'timedOut:true must be explicit, never a silent success');
  assert.equal(aout.askedMessageID, 'msg_q');
  assert.deepEqual(aout.answer, []);
});

test('session_broadcast answers the healthy peers when one peer throws', async () => {
  const mod = await load();
  mod.setApiRunner(async (args) => {
    const [verb, target] = args;
    const m = String(target || '');
    const sid = (args.find((a) => String(a).startsWith('sessionID=')) || '').slice('sessionID='.length)
      || (/\/api\/session\/([^/]+)/.exec(m) || [])[1]
      || '';
    if (verb === 'session.get') return { ok: true, json: { data: { id: sid, title: 'active ' + sid } } };
    if (verb === 'post' && m.endsWith('/wait')) return { ok: true, json: { data: {} } };
    if (verb === 'post' && m.endsWith('/prompt')) {
      if (sid === 'ses_bad') throw new Error('boom');
      return { ok: true, json: { data: { id: 'msg_q_' + sid, sessionID: sid, time: { created: 1 } } } };
    }
    if (verb === 'session.message.list') {
      const bad = cursorOrderError(args);
      if (bad) return bad;
      const wantAsc = args.some((a) => String(a) === 'order=asc');
      const rows = [
        { id: 'msg_a_' + sid, type: 'assistant', time: { created: 2 }, text: 'answer ' + sid },
        { id: 'msg_q_' + sid, type: 'user', time: { created: 1 }, text: 'q' },
      ];
      return {
        ok: true,
        json: {
          data: wantAsc ? rows.slice().reverse() : rows,
        },
      };
    }
    return { ok: true, json: { data: {} } };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const bc = added.find((t) => t.name === 'session_broadcast');
  const out = JSON.parse((await bc.execute({ targets: ['ses_ok1', 'ses_bad', 'ses_ok2'], text: 'status?', waitMs: 5000 })).content);
  assert.equal(out.length, 3);
  const [r1, r2, r3] = out;
  assert.equal(r1.ok, true);
  assert.equal(r1.sessionID, 'ses_ok1');
  assert.deepEqual(r1.answer, [{ id: 'msg_a_ses_ok1', text: 'answer ses_ok1' }]);
  assert.equal(r1.timedOut, false);
  assert.equal(r2.ok, false, 'one peer failing must be a row, never a rejection');
  assert.ok(r2.error, 'the failing row carries its error');
  assert.equal(r3.ok, true);
  assert.deepEqual(r3.answer, [{ id: 'msg_a_ses_ok2', text: 'answer ses_ok2' }]);
});

test('metadata travels in the prompt body, and reply marks re', async () => {
  const mod = await load();
  const calls = [];
  mod.setApiRunner(async (args) => {
    calls.push(args);
    const [verb] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'active work' } } };
    if (verb === 'post') return { ok: true, json: { data: { id: 'msg_sent', sessionID: 'ses_a', time: { created: 1 } } } };
    return { ok: true, json: { data: {} } };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const send = added.find((t) => t.name === 'session_send');
  await send.execute({ to: 'ses_a', text: 'hi', metadata: { from: 'dispatcher' } });
  assert.deepEqual(promptBody(calls).metadata, { from: 'dispatcher' });

  const reply = added.find((t) => t.name === 'session_reply');
  calls.length = 0;
  const rout = JSON.parse((await reply.execute({ to: 'ses_a', text: 'done', re: 'msg_123' })).content);
  assert.equal(rout.error, undefined);
  assert.equal(rout.id, 'msg_sent');
  assert.equal(rout.sessionID, 'ses_a');
  assert.deepEqual(promptBody(calls).metadata, { re: 'msg_123' });

  // A caller-supplied object merges instead of being replaced.
  calls.length = 0;
  await reply.execute({ to: 'ses_a', text: 'done', re: 'msg_123', metadata: { from: 'worker' } });
  assert.deepEqual(promptBody(calls).metadata, { from: 'worker', re: 'msg_123' });
});

test('session_read carries peer metadata and pages with since/cursor', async () => {
  const mod = await load();
  const calls = [];
  mod.setApiRunner(async (args) => {
    calls.push(args);
    const [verb] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'active work' } } };
    if (verb === 'session.message.list') {
      const bad = cursorOrderError(args);
      if (bad) return bad;
      const wantAsc = args.some((a) => String(a) === 'order=asc');
      const descRows = [
        { id: 'msg_new', type: 'assistant', time: { created: 30, completed: 31 }, text: 'new', metadata: { from: 'peer' }, outcome: 'completed', finish: 'stop' },
        { id: 'msg_mid', type: 'user', time: { created: 20 }, text: 'q' },
        { id: 'msg_old', type: 'assistant', time: { created: 10 }, text: 'old' },
      ];
      return {
        ok: true,
        json: {
          data: wantAsc ? descRows.slice().reverse() : descRows,
          cursor: { next: 'next-page' },
        },
      };
    }
    return { ok: true, json: { data: {} } };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const read = added.find((t) => t.name === 'session_read');

  // No pagination args: the historical bare array, with extras appended after
  // the four historical keys.
  const plain = JSON.parse((await read.execute({ to: 'ses_a' })).content);
  assert.equal(plain.length, 3);
  assert.deepEqual(Object.keys(plain[0]), ['id', 'type', 'created', 'text', 'metadata', 'outcome', 'finish', 'completed']);
  assert.deepEqual(plain[0].metadata, { from: 'peer' });
  assert.equal(plain[0].completed, 31);

  // since as a message id keeps only newer rows and returns the page shape.
  const paged = JSON.parse((await read.execute({ to: 'ses_a', since: 'msg_mid' })).content);
  assert.deepEqual(paged.messages.map((m) => m.id), ['msg_new']);
  assert.equal(paged.cursor.next, 'next-page');

  // since as a timestamp filters by creation time instead.
  const timed = JSON.parse((await read.execute({ to: 'ses_a', since: 15 })).content);
  assert.deepEqual(timed.messages.map((m) => m.id), ['msg_new', 'msg_mid']);

  // cursor reaches the backend verbatim, and never together with order: the
  // live server 400s InvalidCursorError on the pair.
  const cout = JSON.parse((await read.execute({ to: 'ses_a', cursor: 'next-page' })).content);
  assert.equal(cout.error, undefined, 'cursor page must succeed: ' + JSON.stringify(cout));
  const listCall = calls.filter((a) => a[0] === 'session.message.list').pop();
  assert.ok(listCall.includes('cursor=next-page'));
  assert.ok(!listCall.some((a) => String(a).startsWith('order=')), 'cursor and order must never combine');
});

test('session_list passes parentID so a dispatcher can enumerate its workers', async () => {
  const mod = await load();
  const calls = [];
  mod.setApiRunner(async (args) => {
    calls.push(args);
    return { ok: true, json: { data: [{ id: 'ses_w', title: 'worker one', location: { directory: '/w' }, time: { updated: 1 }, parentID: 'ses_p' }], cursor: {} } };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const list = added.find((t) => t.name === 'session_list');
  const out = JSON.parse((await list.execute({ parentID: 'ses_p' })).content);
  assert.deepEqual(out.sessions.map((s) => s.id), ['ses_w']);
  assert.ok(calls.some((a) => a.includes('parentID=ses_p')), 'parentID must reach the backend');
});

test('session_thread shows one exchange both-sides in order', async () => {
  const mod = await load();
  mod.setApiRunner(askPeerRunner());
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const thread = added.find((t) => t.name === 'session_thread');
  const out = JSON.parse((await thread.execute({ to: 'ses_peer', messageID: 'msg_ours' })).content);
  assert.equal(out.error, undefined);
  assert.equal(out.sessionID, 'ses_peer');
  assert.equal(out.messageID, 'msg_ours');
  assert.deepEqual(out.messages.map((m) => m.id), ['msg_ours', 'msg_ans1', 'msg_ans2']);

  const missing = JSON.parse((await thread.execute({ to: 'ses_peer', messageID: 'msg_nope' })).content);
  assert.equal(missing.error, 'message_not_found');
});

test('ask, reply and broadcast steer by default and honour queue', async () => {
  for (const name of ['session_ask', 'session_reply', 'session_broadcast']) {
    const mod = await load();
    const calls = [];
    mod.setApiRunner(async (args) => {
      calls.push(args);
      const [verb, target] = args;
      const m = String(target || '');
      const sid = (args.find((a) => String(a).startsWith('sessionID=')) || '').slice('sessionID='.length)
        || (/\/api\/session\/([^/]+)/.exec(m) || [])[1]
        || 'ses_a';
      if (verb === 'session.get') return { ok: true, json: { data: { id: sid, title: 'active work' } } };
      if (verb === 'post' && m.endsWith('/wait')) return { ok: true, json: { data: {} } };
      if (verb === 'post' && m.endsWith('/prompt')) {
        return { ok: true, json: { data: { id: 'msg_q', sessionID: sid, time: { created: 1 } } } };
      }
      if (verb === 'session.message.list') {
        const bad = cursorOrderError(args);
        if (bad) return bad;
        const wantAsc = args.some((a) => String(a) === 'order=asc');
        const rows = [
          { id: 'msg_a', type: 'assistant', time: { created: 2 }, text: 'answer' },
          { id: 'msg_q', type: 'user', time: { created: 1 }, text: 'q' },
        ];
        return {
          ok: true,
          json: {
            data: wantAsc ? rows.slice().reverse() : rows,
          },
        };
      }
      return { ok: true, json: { data: {} } };
    });
    const { ctx, added } = host();
    await mod.default.setup(ctx);
    const tool = added.find((t) => t.name === name);
    const base = name === 'session_broadcast'
      ? { targets: ['ses_a'], text: 'hi' }
      : name === 'session_reply'
        ? { to: 'ses_a', text: 'hi', re: 'msg_q' }
        : { to: 'ses_a', text: 'hi', waitMs: 5000 };
    const out = JSON.parse((await tool.execute(base)).content);
    assert.equal(out.error, undefined, name + ' default run failed: ' + JSON.stringify(out));
    assert.equal(promptBody(calls).delivery, 'steer', name + ' must steer by default');
    calls.length = 0;
    const out2 = JSON.parse((await tool.execute({ ...base, delivery: 'queue' })).content);
    assert.equal(out2.error, undefined, name + ' override run failed: ' + JSON.stringify(out2));
    assert.equal(promptBody(calls).delivery, 'queue', name + ' must honour queue');
  }
});

// The live defect: the server 400s cursor+order together, so a peer with more
// messages than one page broke every ask/thread that reached a second page.
// These force at least two pages (page size 2) and prove ascending paging
// with no order collects the whole transcript and still correlates.
function pagedTranscriptAsc() {
  return [
    { id: 'msg_old', type: 'assistant', time: { created: 10 }, text: 'older exchange' },
    { id: 'msg_ours', type: 'user', time: { created: 40 }, text: 'the question' },
    { id: 'msg_ans1', type: 'assistant', time: { created: 49 }, text: 'first' },
    { id: 'msg_ans2', type: 'assistant', time: { created: 50 }, text: 'second', outcome: 'completed' },
    { id: 'msg_new_user', type: 'user', time: { created: 59 }, text: 'unrelated later question' },
    { id: 'msg_new_asst', type: 'assistant', time: { created: 60 }, text: 'LATER: unrelated answer' },
  ];
}

// Strict paginating fake, live-faithful: no order on a first page means desc
// (newest first, like the server); an explicit order wins there; a cursor
// alone preserves its page's order and cursor+order is 400. Cursors encode
// their order as `<asc|desc>-off-<n>` exactly like the live cursor embeds it.
function pagedRunner(calls) {
  const asc = pagedTranscriptAsc();
  const desc = asc.slice().reverse();
  return async (args) => {
    const [verb, target] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_peer', title: 'active peer' } } };
    if (verb === 'post' && String(target).endsWith('/wait')) return { ok: true, json: { data: {} } };
    if (verb === 'post' && String(target).endsWith('/prompt')) {
      return { ok: true, json: { data: { id: 'msg_ours', sessionID: 'ses_peer', time: { created: 40 } } } };
    }
    if (verb === 'session.message.list') {
      calls.push(args);
      const bad = cursorOrderError(args);
      if (bad) return bad;
      const cur = (args.find((a) => String(a).startsWith('cursor=')) || '').slice('cursor='.length);
      const orderArg = (args.find((a) => String(a).startsWith('order=')) || '').slice('order='.length);
      let order;
      let start = 0;
      if (cur) {
        const m = /^(asc|desc)-off-(\d+)$/.exec(cur);
        assert.ok(m, 'cursor must encode its order, saw ' + cur);
        order = m[1];
        start = parseInt(m[2], 10);
      } else {
        order = orderArg === 'asc' ? 'asc' : 'desc';
      }
      const full = order === 'asc' ? asc : desc;
      const page = full.slice(start, start + 2);
      const nextOff = start + 2 < full.length ? start + 2 : null;
      return {
        ok: true,
        json: {
          data: page,
          cursor: { previous: null, next: nextOff === null ? null : order + '-off-' + nextOff },
        },
      };
    }
    return { ok: true, json: { data: {} } };
  };
}

test('session_ask pages past one page without cursor+order and correlates', async () => {
  const mod = await load();
  const calls = [];
  mod.setApiRunner(pagedRunner(calls));
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const ask = added.find((t) => t.name === 'session_ask');
  const out = JSON.parse((await ask.execute({ to: 'ses_peer', text: 'the question', waitMs: 5000 })).content);
  assert.equal(out.error, undefined, 'multi-page ask must succeed: ' + JSON.stringify(out));
  assert.deepEqual(out.answer, [
    { id: 'msg_ans1', text: 'first' },
    { id: 'msg_ans2', text: 'second' },
  ]);
  assert.equal(out.outcome, 'completed');
  assert.ok(calls.length >= 2, 'must force at least two pages, saw ' + calls.length);
  assert.ok(calls[0].some((a) => String(a) === 'order=asc'), 'first page must ask order=asc: ' + JSON.stringify(calls[0]));
  for (const c of calls.slice(1)) {
    assert.ok(c.some((a) => String(a).startsWith('cursor=')), 'later pages must carry the cursor: ' + JSON.stringify(c));
    assert.ok(!c.some((a) => String(a).startsWith('order=')), 'no cursor page may send order: ' + JSON.stringify(c));
  }
});

test('session_thread pages past one page without cursor+order and stays ordered', async () => {
  const mod = await load();
  const calls = [];
  mod.setApiRunner(pagedRunner(calls));
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const thread = added.find((t) => t.name === 'session_thread');
  const out = JSON.parse((await thread.execute({ to: 'ses_peer', messageID: 'msg_ours' })).content);
  assert.equal(out.error, undefined, 'multi-page thread must succeed: ' + JSON.stringify(out));
  assert.deepEqual(out.messages.map((m) => m.id), ['msg_ours', 'msg_ans1', 'msg_ans2']);
  assert.ok(calls.length >= 2, 'must force at least two pages, saw ' + calls.length);
  assert.ok(calls[0].some((a) => String(a) === 'order=asc'), 'first page must ask order=asc: ' + JSON.stringify(calls[0]));
  for (const c of calls.slice(1)) {
    assert.ok(c.some((a) => String(a).startsWith('cursor=')), 'later pages must carry the cursor: ' + JSON.stringify(c));
    assert.ok(!c.some((a) => String(a).startsWith('order=')), 'no cursor page may send order: ' + JSON.stringify(c));
  }
});

// ---- Live orientation regression: the ask must answer the question just asked ----
//
// The live server returns newest-first when no order is given (like order=desc);
// only an explicit order=asc returns oldest-first, and a cursor preserves the
// order of its first page (cursor+order is 400). A fake that answers no-order
// with oldest-first hides the double-reverse class, so these fakes model the
// live rule exactly and the transcript below is kept in chronological ascending
// order with desc derived as its reverse.
function faithfulStaticRunner(asc, askedID) {
  return async (args) => {
    const [verb, target] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_peer', title: 'active peer' } } };
    if (verb === 'post' && String(target).endsWith('/wait')) return { ok: true, json: { data: {} } };
    if (verb === 'post' && String(target).endsWith('/prompt')) {
      return { ok: true, json: { data: { id: askedID, sessionID: 'ses_peer', time: { created: 1 } } } };
    }
    if (verb === 'session.message.list') {
      const bad = cursorOrderError(args);
      if (bad) return bad;
      const wantAsc = args.some((a) => String(a) === 'order=asc');
      const data = wantAsc ? asc : asc.slice().reverse();
      return { ok: true, json: { data } };
    }
    return { ok: true, json: { data: {} } };
  };
}

function twoExchangeAsc() {
  return [
    { id: 'msg_q1', type: 'user', time: { created: 10 }, text: 'reply OCTALK-LIVE-OK' },
    { id: 'msg_a1', type: 'assistant', time: { created: 11 }, text: 'OCTALK-LIVE-OK' },
    { id: 'msg_q2', type: 'user', time: { created: 20 }, text: 'reply OCTALK-SECOND-OK' },
    { id: 'msg_a2', type: 'assistant', time: { created: 21 }, text: 'OCTALK-SECOND-OK' },
  ];
}

test('session_ask on the second exchange returns the SECOND answer, never the first', async () => {
  const mod = await load();
  mod.setApiRunner(faithfulStaticRunner(twoExchangeAsc(), 'msg_q2'));
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const ask = added.find((t) => t.name === 'session_ask');
  const out = JSON.parse((await ask.execute({ to: 'ses_peer', text: 'reply OCTALK-SECOND-OK', waitMs: 5000 })).content);
  assert.equal(out.error, undefined, 'second ask must succeed: ' + JSON.stringify(out));
  assert.equal(out.askedMessageID, 'msg_q2');
  assert.deepEqual(out.answer, [{ id: 'msg_a2', text: 'OCTALK-SECOND-OK' }]);
  assert.ok(!out.answer.some((a) => a.text.includes('LIVE-OK')), 'must never leak the LIVE answer into the SECOND ask');
});

test('an ask with no assistant turn yet returns empty, never a previous answer', async () => {
  const asc = [
    { id: 'msg_q1', type: 'user', time: { created: 10 }, text: 'first' },
    { id: 'msg_a1', type: 'assistant', time: { created: 11 }, text: 'PREV-ANSWER' },
    { id: 'msg_q2', type: 'user', time: { created: 20 }, text: 'second, unanswered' },
  ];
  const mod = await load();
  mod.setApiRunner(faithfulStaticRunner(asc, 'msg_q2'));
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const ask = added.find((t) => t.name === 'session_ask');
  const out = JSON.parse((await ask.execute({ to: 'ses_peer', text: 'second, unanswered', waitMs: 5000 })).content);
  assert.equal(out.error, undefined, 'unanswered ask must succeed: ' + JSON.stringify(out));
  assert.deepEqual(out.answer, []);
  assert.equal(out.timedOut, false);
});

test('session_thread across two exchanges stays chronological', async () => {
  const asc = twoExchangeAsc();
  const mod = await load();
  mod.setApiRunner(faithfulStaticRunner(asc, 'msg_q2'));
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const thread = added.find((t) => t.name === 'session_thread');
  const first = JSON.parse((await thread.execute({ to: 'ses_peer', messageID: 'msg_q1' })).content);
  assert.equal(first.error, undefined, 'thread q1 must succeed: ' + JSON.stringify(first));
  assert.deepEqual(first.messages.map((m) => m.id), ['msg_q1', 'msg_a1']);
  const second = JSON.parse((await thread.execute({ to: 'ses_peer', messageID: 'msg_q2' })).content);
  assert.equal(second.error, undefined, 'thread q2 must succeed: ' + JSON.stringify(second));
  assert.deepEqual(second.messages.map((m) => m.id), ['msg_q2', 'msg_a2']);
});



