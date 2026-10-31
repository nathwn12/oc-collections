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
// Fresh module instance per test: the registration guard is per-instance, and a
// cached module would make the second registration test pass vacuously.
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
    'Deliver one text message to another session by id (ses_...) or unambiguous title substring, then let its loop run; ' +
    'resume defaults to true because the reply is the point. ' +
    'Fire instead of dispatching a lane whenever a peer must act. ' +
    'Sends one message only: it never reads history, and it never guesses — a missing or ambiguous title fails with candidates.',
  session_read:
    "Read another session's newest messages by id (ses_...) or unambiguous title substring, newest first, default 20, text verbatim including newlines. " +
    'Fire when you need what a peer actually said. ' +
    'Reads only: it never sends, wakes, or steers the other session, and it never guesses — a missing or ambiguous title fails with candidates.',
  session_close:
    'Close a finished session in one call: set its title to `done <work>` then compact it. ' +
    'Queues rename (PATCH title to `done <current title>` unless an explicit title is given, never double-prefixing `done `, reporting `already-closed` when already done) then compact (POST compact); one call, never two commands typed by hand.',
  session_open:
    'Create a session titled `active <work>`, optionally delivering one prompt; resume defaults to true so the loop runs. ' +
    'The only verb that may lift `done`: when exactly one live session title contains <work> it reopens that session to `active <work>` instead of creating. ' +
    'Zero matches create; several matches fail ambiguous with candidates.',
  session_kick:
    'Wake a live session with one message; resume defaults to true because the reply is the point. ' +
    'Renames to `active <work>` (prefix replaced, never stacked) then delivers the message. ' +
    'Refuses a `done ` session with a typed error: reopen it with session_open instead.',
  session_park:
    'Park a live session: rewrite its title to `parked <work>` (prefix replaced, never stacked) and return. ' +
    'Prefix only — no message is sent and no compaction runs. ' +
    'Refuses a `done ` session with a typed error; session_open is the only revival path.',
  session_kill:
    'Stop a live session hard: rewrite its title to `parked <work>` (prefix replaced, never stacked), then interrupt its active execution. ' +
    'Park is graceful, kill is hard. ' +
    'The interrupt covers only the target session: cascaded is always false and live child sessions return as children ids, never claimed stopped. ' +
    'Refuses a `done ` session with a typed error; session_open is the only revival path.',
  session_await:
    'Send one message (resume forced true) then wait for the reply: poll the session messages about once per second up to timeoutMs (default 60s, cap 300s) for an assistant message created after the send. ' +
    'Returns {text, messageId} on success or {timeout: true, lastSeen} on expiry; never hangs past its timeout. ' +
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

test('all nine tools register, through setup and through server', async () => {
  const mod = await load();

  // A host with no tool domain registers nothing and must not throw.
  await assert.doesNotReject(() => mod.default.setup({ tool: {} }));
  await assert.doesNotReject(() => mod.default.setup(undefined));

  const viaSetup = host();
  await mod.default.setup(viaSetup.ctx);
  assert.deepEqual(viaSetup.added.map((t) => t.name), NINE);

  for (const tool of viaSetup.added) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.options.codemode, false);
    assert.equal(tool.description, DESCRIPTIONS[tool.name], 'routing description drifted: ' + tool.name);
  }

  // The server path is the same gate: a fresh module registers the same nine.
  const viaServer = host();
  await (await load()).default.server(viaServer.ctx);
  assert.deepEqual(viaServer.added.map((t) => t.name), NINE);
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
  for (const name of ['session_kick', 'session_park', 'session_kill', 'session_await']) {
    assert.match(body(name), /doneRefusal\(/, name + ' must refuse a done session');
  }
  for (const name of ['session_open', 'session_list', 'session_send', 'session_read', 'session_close']) {
    assert.doesNotMatch(body(name), /doneRefusal\(/, name + ' must not consult the done lock');
  }
});

test('source carries no credential, localhost reference or removal verb', () => {
  const src = fs.readFileSync(ENTRY, 'utf8');
  assert.doesNotMatch(src, /password|service\.json|127\.0\.0\.1/);
  // No removal capability in any spelling: the surface is nine verbs, none of
  // which removes a session.
  assert.doesNotMatch(src, /delete/i);
});
