// Offline contract tests for the plugin surface.
//
// These prove the three things a host can break without any peer running:
// the tools register, title resolution answers with candidates instead of a
// guess, and a missing session comes back as a typed error instead of a throw.
//
// Nothing here reaches the network or starts a real peer: every resolution test
// injects its own session list, and the only tool call made is one that fails
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
};

const SESSIONS = [
  { id: 'ses_a', title: 'build lane', directory: '/work/a', updated: 10 },
  { id: 'ses_b', title: 'build lane two', directory: '/work/b', updated: 20 },
  { id: 'ses_solo', title: 'smoke tests', directory: '/work/c', updated: 30 },
];
const lister = async () => ({ ok: true, sessions: SESSIONS });

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

test('all three tools register, through setup and through server', async () => {
  const mod = await load();

  // A host with no tool domain registers nothing and must not throw.
  await assert.doesNotReject(() => mod.default.setup({ tool: {} }));
  await assert.doesNotReject(() => mod.default.setup(undefined));

  const viaSetup = host();
  await mod.default.setup(viaSetup.ctx);
  assert.deepEqual(viaSetup.added.map((t) => t.name), ['session_list', 'session_send', 'session_read']);

  for (const tool of viaSetup.added) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.options.codemode, false);
    assert.equal(tool.description, DESCRIPTIONS[tool.name], 'routing description drifted: ' + tool.name);
  }

  // The server path is the same gate: a fresh module registers the same three.
  const viaServer = host();
  await (await load()).default.server(viaServer.ctx);
  assert.deepEqual(viaServer.added.map((t) => t.name), ['session_list', 'session_send', 'session_read']);
});

test('an ambiguous title returns candidates instead of guessing', async () => {
  const { resolveTarget } = await load();
  const r = await resolveTarget('build lane', lister);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ambiguous_session');
  assert.match(r.reason, /^2 sessions match "build lane"/);
  assert.deepEqual(r.candidates, [
    { id: 'ses_a', title: 'build lane' },
    { id: 'ses_b', title: 'build lane two' },
  ]);

  const one = await resolveTarget('smoke', lister);
  assert.deepEqual(one, { ok: true, id: 'ses_solo' });

  // Case-sensitive by contract: a differently-cased title is a miss, not a guess.
  const cased = await resolveTarget('Build lane', lister);
  assert.equal(cased.error, 'session_not_found');
  assert.deepEqual(cased.candidates.map((c) => c.id), ['ses_a', 'ses_b', 'ses_solo']);
});

test('a missing session returns a typed error, never a throw', async () => {
  const { resolveTarget } = await load();
  const r = await resolveTarget('no such session', lister);
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

test('source carries no credential or localhost reference', () => {
  const src = fs.readFileSync(ENTRY, 'utf8');
  assert.doesNotMatch(src, /password|service\.json|127\.0\.0\.1/);
});
