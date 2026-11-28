// Offline contract tests for both surfaces: two tools by default for a stranger,
// four when a host opts in with boardFile/board.
//
// These prove what a host can break without any peer running: exactly four tools
// register with their exact routing descriptions, title resolution answers with
// candidates or near-misses instead of a guess, a capped resolution refuses
// instead of authorizing a single match, every send steers and carries a client
// id, a `wait` is a post-send poll that cannot change the lane, the inbox
// defaults to the calling session, and the transport file is the only place a
// credential or a loopback address appears.
//
// Nothing here reaches the network or starts a real peer: every resolution test
// injects its own session scan, every tool test injects a recording backend, and
// the only calls that leave a tool are ones whose payload is then asserted. The
// live round trip is `test/live.test.js`, which runs only under OC_TALK_LIVE=1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ENTRY = path.join(import.meta.dirname, '..', 'src', 'index.js');
const TRANSPORT = path.join(import.meta.dirname, '..', 'src', 'transport.mjs');

let loads = 0;
// Fresh module instance per test: the live registration handle is per-instance
// state, and a cached module would carry one test's registration into the next.
const load = () => import(pathToFileURL(ENTRY).href + '?n=' + ++loads);

const DEFAULT_TOOLS = ['talk_send', 'talk_inbox'];
const TOOLS = ['talk_send', 'talk_inbox', 'talk_board', 'talk_claim'];
const BOARD_FILE = path.join(os.tmpdir(), 'oc-talk-opt-in-board.yaml');

const DESCRIPTIONS = {
  talk_send:
    'Deliver one text message into another session by `session` (id `ses_...` or unambiguous title substring; never `session_id`), as synthetic session input: it schedules the peer, appears in its inbox as a synthetic note, and never renders as a TUI user turn. ' +
    'The text carries an envelope with your session id, title and reply target so the peer can answer with talk_send, and metadata.ocTalk carries the same fields for tools; a positive `wait` polls until the peer idles and returns only messages newer than this send, not a fixed delay. ' +
    'Never guesses: an unknown or ambiguous title returns the candidate list as data, and only `delivery: "steer"` is accepted because queue delivery was removed.',
  talk_inbox:
    'Read one session\'s messages as id, role, text, tools and time, newest first, default 20; peer mail arrives as synthetic notes carrying the `[oc-talk] from` envelope, and `session` (never `session_id`) defaults to the session that called this tool. ' +
    '`since` keeps only what is newer, `type` filters, `wait` seconds blocks until the session idles again before reading, and an opaque `cursor` from a previous read is reused rather than reconstructed. ' +
    'Reads only: it never sends, wakes, or steers another session, and an unknown title returns candidates instead of a guess.',
  talk_board:
    'Read the nstack board at <repo>/.nstack/board.yaml as rows of session, state, ticket, seam and since; the file\'s `heartbeat` and `leaseUntil` are internal lease fields outside this row contract. ' +
    'A missing file returns an empty list and a clear message instead of an error. ' +
    'Read-only: it never claims a seam or changes the board.',
  talk_claim:
    'Claim a seam for the calling session in <repo>/.nstack/board.yaml, writing a row with session, state, ticket, seam and an ISO-8601 since; state defaults to active and ticket is optional. ' +
    'A seam held by an active or parked row is refused with the holder named; a closed row is finished work and is taken over. ' +
    'Re-claiming your own seam updates that row instead of adding a duplicate.',
};

const SESSIONS = [
  { id: 'ses_a', title: 'build lane', directory: '/work/a', updated: 10 },
  { id: 'ses_b', title: 'build lane two', directory: '/work/b', updated: 20 },
  { id: 'ses_solo', title: 'smoke tests', directory: '/work/c', updated: 30 },
];

// The scan seam the resolver takes in place of the real search backend.
const scan = async () => ({ ok: true, sessions: SESSIONS });

// A host-shaped ctx whose tool domain records everything the plugin adds.
function host(options) {
  const added = [];
  const ctx = {
    ...(options === undefined ? {} : { options }),
    tool: {
      transform: async (fn) => fn({ add: (tool) => added.push(tool) }),
    },
  };
  return { ctx, added };
}

test('the V2 definition registers exactly the four talk tools when boardFile is set', async () => {
  const mod = await load();

  // A host with no tool domain registers nothing and must not throw.
  await assert.doesNotReject(() => mod.default.setup({ tool: {} }));
  await assert.doesNotReject(() => mod.default.setup(undefined));

  const { ctx, added } = host({ boardFile: BOARD_FILE });
  await mod.default.setup(ctx);
  assert.deepEqual(added.map((t) => t.name), TOOLS);

  for (const tool of added) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.options.codemode, false);
    assert.equal(tool.description, DESCRIPTIONS[tool.name], 'routing description drifted: ' + tool.name);
  }
});

test('a default install registers only two tools and leaks no board convention', async () => {
  const mod = await load();
  const { ctx, added } = host(); // no options: the surface a stranger installs
  await mod.default.setup(ctx);
  assert.deepEqual(added.map((t) => t.name), DEFAULT_TOOLS);

  const surface = added.map(({ name, description, input, options }) => ({ name, description, input, options }));
  assert.doesNotMatch(JSON.stringify(surface), /nstack/i, 'the default tool surface must not advertise a host-only board path');
  const readme = fs.readFileSync(path.join(import.meta.dirname, '..', 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /nstack/i, 'the quick start and the whole README stay stranger-readable');
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.doesNotMatch(pkg.description, /nstack/i, 'the npm description stays about messaging');
});

// The eleven lifecycle and conversation verbs are gone, not hidden behind a flag:
// an absent tool must fail here before a host can offer it again.
test('the deleted verbs are absent from the surface and from the source', async () => {
  const mod = await load();
  const { ctx, added } = host({ boardFile: BOARD_FILE });
  await mod.default.setup(ctx);
  const names = added.map((t) => t.name);
  assert.equal(names.length, 4, 'the surface is exactly four tools');

  const banned = ['await', 'list', 'send', 'read', 'close', 'open', 'kick', 'park', 'kill', 'ask', 'wait', 'reply', 'thread', 'broadcast'].map((v) => 'session_' + v);
  for (const name of banned) {
    assert.ok(!names.includes(name), name + ' must not be registered');
  }
  const src = fs.readFileSync(ENTRY, 'utf8');
  for (const name of banned) {
    assert.ok(!src.includes(name), name + ' must not survive in the source');
  }
  // No V1 `server` member: dead weight in V2 that would read as a live path.
  assert.equal(mod.default.server, undefined);
});

test('the default export is a V2 definition: id plus setup, no V1 server', async () => {
  const mod = await load();
  assert.deepEqual(Object.keys(mod.default).sort(), ['id', 'setup']);
  assert.equal(mod.default.id, 'oc-talk');
  assert.equal(typeof mod.default.setup, 'function');
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
  assert.deepEqual(one, { ok: true, id: 'ses_solo', title: 'smoke tests' });

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

  // A failed search is reported, not thrown.
  const failed = await resolveTarget('anything', async () => ({ ok: false, code: 'backend_unavailable', detail: 'gone' }));
  assert.equal(failed.error, 'backend_unavailable');
  assert.match(failed.reason, /search failed: gone/);

  // The tool boundary turns a typed failure into JSON content, and validation
  // fails before any backend call: no network is touched here.
  const { ctx, added } = host();
  await (await load()).default.setup(ctx);
  const send = added.find((t) => t.name === 'talk_send');
  const out = await send.execute({ session: 'ses_x' });
  assert.deepEqual(JSON.parse(out.content), {
    error: 'bad_request',
    reason: 'text must be a non-empty string',
  });
});

test('an id-shaped target resolves by direct GET, never a search', async () => {
  const { resolveTarget } = await load();
  let scans = 0;
  let asked = '';
  const countedScan = async () => {
    scans++;
    return { ok: true, sessions: SESSIONS };
  };
  const getter = async (id) => {
    asked = id;
    return { ok: true, session: { id, title: 'active work' } };
  };

  assert.deepEqual(await resolveTarget('ses_a', countedScan, getter), { ok: true, id: 'ses_a', title: 'active work' });
  assert.equal(asked, 'ses_a', 'the id must reach the direct getter verbatim');
  assert.equal(scans, 0, 'an id must never trigger a title search');

  const gone = await resolveTarget('ses_gone', countedScan, async () => ({ ok: false, code: 'session_not_found', detail: 'not found' }));
  assert.equal(gone.error, 'session_not_found');
  assert.match(gone.reason, /session ses_gone is gone: not found/);

  const failed = await resolveTarget('ses_a', countedScan, async () => ({ ok: false, code: 'backend_error', detail: 'boom' }));
  assert.equal(failed.error, 'backend_error');
  assert.match(failed.reason, /lookup failed: boom/);

  // A blank target is a typed refusal, never a search for the empty string.
  assert.equal((await resolveTarget('', countedScan)).error, 'bad_request');
});

test('a truncated search refuses instead of resolving a single match', async () => {
  const { resolveTarget } = await load();
  const capped = async () => ({ ok: true, sessions: SESSIONS, truncated: true, pages: 20 });

  // The probe that motivated the fix: one hit on a capped scan used to authorize.
  const r = await resolveTarget('smoke', capped);
  assert.equal(r.ok, false, 'a capped scan must not authorize a target');
  assert.equal(r.error, 'ambiguous_scan');
  assert.equal(r.truncated, true);
  assert.match(r.reason, /search truncated at 20 pages; 1 scanned session\(s\) match "smoke"; use the full id/);
  assert.deepEqual(r.candidates, [{ id: 'ses_solo', title: 'smoke tests' }]);

  // The id path never scans, so a capped estate cannot touch it.
  let scans = 0;
  const counted = async () => {
    scans++;
    return { ok: true, sessions: SESSIONS, truncated: true, pages: 20 };
  };
  const viaId = await resolveTarget('ses_solo', counted, async (id) => ({ ok: true, session: { id } }));
  assert.deepEqual(viaId, { ok: true, id: 'ses_solo', title: '' });
  assert.equal(scans, 0);

  // A complete scan still resolves one hit; a capped scan that found nothing
  // resolves nothing either, and still reports itself as partial.
  assert.deepEqual(await resolveTarget('smoke', scan), { ok: true, id: 'ses_solo', title: 'smoke tests' });
  const none = await resolveTarget('no such session', capped);
  assert.equal(none.error, 'session_not_found');
  assert.equal(none.truncated, true);
});

test('the transport is the only file that carries the credential or loopback address', () => {
  const src = fs.readFileSync(ENTRY, 'utf8');
  assert.doesNotMatch(src, /password|service\.json|127\.0\.0\.1/, 'the plugin entry stays credential-free');
  // No removal capability in any spelling: this surface has no delete verb. The
  // one exclusion is bookkeeping on this module's own registration map.
  const surface = src.replaceAll('registrations.delete(key)', '');
  assert.doesNotMatch(surface, /delete/i);

  // The transport reads the state file at call time: no literal credential, no
  // wildcard bind advertised to a caller.
  const transport = fs.readFileSync(TRANSPORT, 'utf8');
  assert.match(transport, /service\.json/);
  assert.match(transport, /127\.0\.0\.1/);
  assert.doesNotMatch(transport, /password:\s*['"][^'"]+['"]/, 'no password literal in the transport');
});

// A recording backend: every call is captured and each verb answers with the
// smallest payload its caller needs, so a whole tool execute runs offline with
// no peer and no network.
function recorder(session = { id: 'ses_a', title: 'active work', location: { directory: '/work/a' } }) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const [verb, target] = args;
    if (verb === 'session.get') {
      const asked = String(args.find((a) => String(a).startsWith('sessionID=')) || '').slice('sessionID='.length);
      return { ok: true, json: { data: { ...session, id: asked || session.id } } };
    }
    if (verb === 'session.list') return { ok: true, json: { data: [] } };
    if (verb === 'session.message.list') {
      return {
        ok: true,
        json: {
          data: [
            { id: 'msg_reply', type: 'assistant', time: { created: 5000, completed: 5001 }, content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'done' }, { type: 'tool', name: 'read', state: { status: 'completed' } }] },
            { id: 'msg_ours', type: 'user', time: { created: 1000 }, text: 'hi' },
          ],
          cursor: { previous: null, next: 'next-page' },
        },
      };
    }
    if (verb === 'post' && String(target).endsWith('/synthetic')) {
      return { ok: true, json: { data: { id: 'msg_sent', sessionID: session.id, time: { created: 1 } } } };
    }
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

// The synthetic body the backend actually received, parsed: the payload, not the
// intent, is what these cases assert on.
function syntheticBody(calls) {
  const call = calls.find((a) => a[0] === 'post' && String(a[1]).endsWith('/synthetic'));
  return call ? JSON.parse(call[3]) : null;
}

// The exact envelope the tool must put in `text`. Spelled out so a drift in the
// header, the reply line or the blank line is a red test.
function envel(text, id = 'ses_caller', title = 'active work') {
  return `[oc-talk] from ${id} "${title}"\nReply with talk_send(session="${id}", text="...").\n\n${text}`;
}

const CALLER = { sessionID: 'ses_caller', signal: undefined };

// A backend whose session is already at a turn boundary and produces a fresh one
// right after the send, so a blocking call returns at once instead of sleeping.
async function waitingTool() {
  const mod = await load();
  const calls = [];
  let posted = false;
  mod.setApiRunner(async (args) => {
    calls.push(args);
    const [verb, target] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'active work' } } };
    if (verb === 'post' && String(target).endsWith('/synthetic')) {
      posted = true;
      return { ok: true, json: { data: { id: 'msg_sent', sessionID: 'ses_a' } } };
    }
    return { ok: true, json: { data: [{ id: posted ? 'msg_new_idle' : 'msg_prev_idle', type: 'idle', time: { created: 1 } }] } };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  return { tool: added.find((t) => t.name === 'talk_send'), calls };
}

// A long, neutral brief, far past the length a trigger table used to guard: it
// proves a long body steers intact instead of being classified.
const LONG_HANDOFF =
  'Take the parser lane from red to green: read the failure output, find the input that breaks it, fix the smallest thing that explains it, add a regression case, and run the full suite before reporting. '.repeat(
    4,
  ) + 'Do that now.';

// The send table: the delivery contract as realistic messages. Every row must
// steer and must reach the wire byte for byte, whatever it says. These were lane
// rows once; the lane they used to choose no longer exists, and what they still
// prove is that no wording changes the lane and no text is rewritten on the way
// out.
const SEND_TABLE = [
  "don't forget to update the changelog when you are done",
  'wait for the build to finish before you push',
  'that file is no longer needed, delete it in your current task',
  'use pnpm instead of npm here',
  'the failed test is in the auth file, please fix it',
  'critical path: review the schema before merge',
  'blocker cleared, you can continue',
  'cancel the pending release note draft',
  'tests are red on main',
  'Please investigate the failed tests and report back',
  'Use the red logo in the next mockup',
  'Build the parser instead of the renderer',
  'Stop — the migration is wrong, revert it.',
  'Actually, revert that last commit.',
  'Emergency: the production key is in the log file.',
  'Do not merge that branch.',
  'asap: the client is on the call',
  'No — hold off until the suite is green.',
  'Nova, stop the build.',
  LONG_HANDOFF,
];

test('every send steers, carries a client id, and returns the admission', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: 'do the thing' }, CALLER)).content);
  assert.deepEqual(out, {
    id: 'msg_sent',
    sessionID: 'ses_a',
    title: 'active work',
    from: { sessionID: 'ses_caller', title: 'active work' },
    replyTo: 'ses_caller',
    delivered: true,
    delivery: 'steer',
    deliveryReason: 'default',
  });

  const body = syntheticBody(calls);
  assert.equal(body.text, envel('do the thing'));
  assert.equal(body.delivery, 'steer', 'there is one lane, and it is on the wire');
  assert.equal(body.resume, undefined, 'the admission shape carries no resume flag');
  assert.match(body.id, /^msg_[0-9a-f]{32}$/, 'the id is a client-generated msg id, so a retry is idempotent');

  // Two sends are two admissions, never one idempotent replay.
  const again = JSON.parse((await tool.execute({ session: 'ses_a', text: 'again' }, CALLER)).content);
  assert.equal(again.delivered, true);
  const bodies = calls.filter((a) => a[0] === 'post' && String(a[1]).endsWith('/synthetic')).map((a) => JSON.parse(a[3]));
  assert.notEqual(bodies[0].id, bodies[1].id);
});

test('the envelope is byte-exact and delivery uses the synthetic route, never prompt', async () => {
  const { tool, calls } = await toolWith('talk_send');
  await tool.execute({ session: 'ses_a', text: 'ship it' }, CALLER);
  const posts = calls.filter((a) => a[0] === 'post');
  assert.equal(posts.length, 1, 'one admission per send');
  assert.equal(posts[0][1], '/api/session/ses_a/synthetic', 'the stealth route, not the user prompt');
  assert.ok(!calls.some((a) => String(a[1]).endsWith('/prompt')), 'the prompt route is never touched');
  const body = JSON.parse(posts[0][3]);
  assert.equal(
    body.text,
    '[oc-talk] from ses_caller "active work"\nReply with talk_send(session="ses_caller", text="...").\n\nship it',
    'the envelope is byte-exact',
  );
  assert.equal(body.description, 'oc-talk from active work');
  assert.equal(body.delivery, 'steer');
  assert.match(body.id, /^msg_[0-9a-f]{32}$/);
  assert.equal(body.resume, undefined, 'the host schedules execution; no resume flag');
});

test('the synthetic metadata carries the ocTalk reply fields and the package version', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.equal(typeof pkg.version, 'string', 'the manifest carries a version');
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: 'hi' }, CALLER)).content);
  assert.deepEqual(syntheticBody(calls).metadata, {
    ocTalk: { from: 'ses_caller', replyTo: 'ses_caller', version: pkg.version },
  });
  assert.deepEqual(out.from, { sessionID: 'ses_caller', title: 'active work' });
  assert.equal(out.replyTo, 'ses_caller');
});

test('a caller with no session id keeps the bare text and reports from: null', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: 'bare handoff' }, {})).content);
  assert.equal(out.error, undefined, 'a missing caller must not break the send');
  assert.equal(out.from, null);
  assert.equal(out.replyTo, null);
  const body = syntheticBody(calls);
  assert.equal(body.text, 'bare handoff', 'compatibility: no envelope without a caller');
  assert.deepEqual(body.metadata.ocTalk, { from: null, replyTo: null, version: pkg.version });
  assert.equal(body.description, 'oc-talk');
  assert.equal(calls.filter((a) => a[0] === 'session.get').length, 1, 'only the target is looked up');
});

test('an incoming envelope is not wrapped a second time', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const text = envel('relayed body', 'ses_other', 'relay lane');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text }, CALLER)).content);
  assert.equal(out.error, undefined);
  assert.equal(syntheticBody(calls).text, text, 'a relayed envelope survives byte for byte');
  assert.equal(text.split('[oc-talk] from ').length - 1, 1, 'exactly one envelope on the wire');
});

// A wait backend that reads one fixed ascending history after a one-shot send.
// The baseline is `msg_before`; the newest row turns fresh and idle once posted.
async function replyTool(history) {
  const mod = await load();
  let posted = false;
  mod.setApiRunner(async (args) => {
    const [verb, target] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'active work' } } };
    if (verb === 'post' && String(target).endsWith('/synthetic')) {
      posted = true;
      return { ok: true, json: { data: { id: 'msg_own', sessionID: 'ses_a', type: 'synthetic' } } };
    }
    if (args.includes('limit=1')) {
      return { ok: true, json: { data: [{ id: posted ? 'msg_idle_new' : 'msg_before', type: 'idle' }] } };
    }
    return { ok: true, json: { data: history, cursor: {} } };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  return added.find((t) => t.name === 'talk_send');
}

test('wait returns only fresh messages, ascending, with role and text, never the sender', async () => {
  const tool = await replyTool([
    { id: 'msg_old', type: 'assistant', text: 'before' },
    { id: 'msg_before', type: 'idle' },
    { id: 'msg_own', type: 'synthetic', text: 'our own note' },
    { id: 'msg_r1', type: 'synthetic', text: 'reply one' },
    { id: 'msg_r2', type: 'assistant', text: 'reply two' },
  ]);
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: 'hello', wait: 30 }, CALLER)).content);
  assert.equal(out.timedOut, false);
  assert.deepEqual(out.messages, [
    { role: 'synthetic', text: 'reply one' },
    { role: 'assistant', text: 'reply two' },
  ]);
});

test('a wait reply read is capped at twenty newest, still ascending', async () => {
  const history = [{ id: 'msg_before', type: 'idle' }, { id: 'msg_own', type: 'synthetic', text: 'our note' }];
  for (let i = 0; i < 25; i++) history.push({ id: 'msg_r' + i, type: 'assistant', text: 'r' + i });
  const tool = await replyTool(history);
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: 'hello', wait: 30 }, CALLER)).content);
  assert.equal(out.messages.length, 20);
  assert.equal(out.messages[0].text, 'r5', 'the oldest of the twenty newest');
  assert.equal(out.messages[19].text, 'r24', 'the newest last: ascending');
});

test('talk_inbox reads synthetic peer mail with its envelope', async () => {
  const mod = await load();
  const envelope = envel('please review the parser', 'ses_peer', 'parser lane');
  mod.setApiRunner(async (args) => {
    const [verb] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_caller', title: 'dispatcher' } } };
    if (verb === 'session.message.list') {
      return { ok: true, json: { data: [{ id: 'msg_mail', type: 'synthetic', time: { created: 900 }, text: envelope }], cursor: {} } };
    }
    return { ok: true, json: { data: {} } };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const out = JSON.parse((await added.find((t) => t.name === 'talk_inbox').execute({}, CALLER)).content);
  assert.equal(out.error, undefined);
  assert.deepEqual(out.messages, [{ id: 'msg_mail', role: 'synthetic', text: envelope, tools: [], time: 900 }]);
  assert.match(out.messages[0].text, /^\[oc-talk\] from ses_peer "parser lane"/);
});

test('the send table steers on every row and reaches the wire byte for byte', async () => {
  const { classifyDelivery } = await load();
  assert.ok(SEND_TABLE.length >= 16, 'the table is the contract: ' + SEND_TABLE.length + ' rows');
  const { tool, calls } = await toolWith('talk_send');
  for (const text of SEND_TABLE) {
    const label = JSON.stringify(text.slice(0, 40));
    assert.deepEqual(classifyDelivery(text), { delivery: 'steer', reason: 'default', text }, 'routing for: ' + label);
    calls.length = 0;
    const out = JSON.parse((await tool.execute({ session: 'ses_a', text }, CALLER)).content);
    assert.equal(out.error, undefined, 'send failed for: ' + label + ' ' + JSON.stringify(out));
    assert.equal(out.delivery, 'steer', 'reply lane for: ' + label);
    assert.equal(out.deliveryReason, 'default', 'reply reason for: ' + label);
    const body = syntheticBody(calls);
    assert.equal(body.delivery, 'steer', 'posted lane for: ' + label);
    assert.equal(body.text, envel(text), 'delivered text for: ' + label);
  }
});

test('a [steer] marker is stripping, not routing: the text is what is delivered', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: '[steer] Stop the deploy.' }, CALLER)).content);
  assert.equal(out.error, undefined);
  assert.equal(out.delivery, 'steer');
  assert.equal(out.deliveryReason, 'marker');
  const body = syntheticBody(calls);
  assert.equal(body.delivery, 'steer');
  assert.equal(body.text, envel('Stop the deploy.'), 'the marker is routing, not content');
});

test('[queue] is ordinary text now and arrives intact', async () => {
  const { tool, calls } = await toolWith('talk_send');
  for (const text of ['[queue] stop, that\'s wrong', '[queue](https://example.com) is the doc', 'queue: STOP']) {
    calls.length = 0;
    const out = JSON.parse((await tool.execute({ session: 'ses_a', text }, CALLER)).content);
    assert.equal(out.error, undefined, 'send failed for: ' + JSON.stringify(text));
    assert.equal(out.delivery, 'steer', 'queue in the text changes nothing: ' + JSON.stringify(text));
    assert.equal(out.deliveryReason, 'default', 'it is not a marker: ' + JSON.stringify(text));
    const body = syntheticBody(calls);
    assert.equal(body.text, envel(text), 'the text survives byte for byte: ' + JSON.stringify(text));
    assert.equal(body.delivery, 'steer', 'the wire lane is unchanged: ' + JSON.stringify(text));
  }
});

test('an explicit delivery: "steer" is accepted and reported as explicit', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: LONG_HANDOFF, delivery: 'steer' }, CALLER)).content);
  assert.equal(out.error, undefined);
  assert.equal(out.delivery, 'steer');
  assert.equal(out.deliveryReason, 'explicit');
  const body = syntheticBody(calls);
  assert.equal(body.delivery, 'steer');
  assert.equal(body.text, envel(LONG_HANDOFF), 'a long body is delivered unclassified and unwritten');
});

test('delivery: "queue" is refused, never silently steered', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = await tool.execute({ session: 'ses_a', text: 'Run the suite.', delivery: 'queue' }, CALLER);
  const body = JSON.parse(out.content);
  assert.equal(body.error, 'bad_request');
  assert.match(body.reason, /queue removed; oc-talk is steer-only/);
  assert.equal(calls.length, 0, 'the refusal happens before any backend call');
});

test('the removed auto lane and an unknown delivery are typed refusals', async () => {
  const { tool, calls } = await toolWith('talk_send');
  for (const delivery of ['auto', 'now', 5, null]) {
    const out = await tool.execute({ session: 'ses_a', text: 'hi', delivery }, CALLER);
    const body = JSON.parse(out.content);
    assert.equal(body.error, 'bad_request', 'delivery ' + JSON.stringify(delivery) + ' must be refused');
    assert.match(body.reason, /delivery must be steer/, 'the reason names the only lane: ' + JSON.stringify(body));
  }
  assert.equal(calls.length, 0, 'the refusal happens before any backend call');
});

test('a message that is only a [steer] marker fails as bad_request and sends nothing', async () => {
  const { tool, calls } = await toolWith('talk_send');
  for (const text of ['[steer]', '  STEER:  ']) {
    const out = JSON.parse((await tool.execute({ session: 'ses_a', text }, CALLER)).content);
    assert.equal(out.error, 'bad_request', 'marker-only text must not be admitted: ' + JSON.stringify(text));
    assert.match(out.reason, /nothing to deliver/, 'the reason names the real problem: ' + JSON.stringify(out));
  }
  assert.equal(calls.length, 0, 'the refusal happens before any backend call');
});

// `wait` is a poll that runs after the send. It cannot choose a lane, because the
// message has already been admitted by the time it starts; what it can do is read
// the turn boundary that follows and hand back what the peer said.
test('wait polls after an explicit steer send and never changes the lane', async () => {
  const { tool, calls } = await waitingTool();
  const out = JSON.parse(
    (await tool.execute({ session: 'ses_a', text: 'Stop — that is the wrong branch.', delivery: 'steer', wait: 30 }, CALLER)).content,
  );
  assert.equal(out.error, undefined, 'the send itself still succeeds: ' + JSON.stringify(out));
  assert.equal(out.delivery, 'steer', 'a poll after the send is not a lane');
  assert.equal(out.deliveryReason, 'explicit');
  assert.equal(out.timedOut, false);
  assert.equal(syntheticBody(calls).delivery, 'steer', 'the wire lane is unchanged by the wait');
});

test('wait polls after a [steer] send and never changes the lane', async () => {
  const { tool, calls } = await waitingTool();
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: '[steer] Stop — that is the wrong branch.', wait: 30 }, CALLER)).content);
  assert.equal(out.error, undefined, 'the send itself still succeeds: ' + JSON.stringify(out));
  assert.equal(out.delivery, 'steer');
  assert.equal(out.deliveryReason, 'marker');
  assert.equal(syntheticBody(calls).delivery, 'steer');
  assert.equal(syntheticBody(calls).text, envel('Stop — that is the wrong branch.'), 'the marker is still stripped');
});

test('wait on a plain send steers first and polls the boundary that follows it', async () => {
  const { tool, calls } = await waitingTool();
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: 'do the thing', wait: 30 }, CALLER)).content);
  assert.equal(out.error, undefined, 'the send itself still succeeds: ' + JSON.stringify(out));
  assert.equal(out.delivery, 'steer');
  assert.equal(out.deliveryReason, 'default');
  assert.equal(syntheticBody(calls).delivery, 'steer');
  // A baseline read before the send, then at least one poll after it: the
  // boundary that counts is the one this send produced.
  const reads = calls.filter((a) => a[0] === 'session.message.list');
  assert.ok(reads.length >= 2, 'a bounded wait reads a baseline and then polls: ' + reads.length);
});

test('classifyDelivery is pure: it strips a [steer] marker and never picks a lane', async () => {
  const mod = await load();
  const { classifyDelivery } = mod;

  assert.deepEqual(classifyDelivery('  [STEER]   Stop it.'), { delivery: 'steer', reason: 'marker', text: 'Stop it.' });
  assert.deepEqual(classifyDelivery('STEER: stop it'), { delivery: 'steer', reason: 'marker', text: 'stop it' });
  assert.deepEqual(classifyDelivery('Stop it.', 'steer'), { delivery: 'steer', reason: 'explicit', text: 'Stop it.' });
  assert.deepEqual(classifyDelivery('run the tests'), { delivery: 'steer', reason: 'default', text: 'run the tests' });

  // A marker needs whitespace or the end of the text after it: a link is content.
  assert.deepEqual(classifyDelivery('[steer](https://example.com) go'), {
    delivery: 'steer',
    reason: 'default',
    text: '[steer](https://example.com) go',
  });
  // Queue is neither a marker nor a lane: the token is text, delivered as written.
  assert.deepEqual(classifyDelivery('[queue] go'), { delivery: 'steer', reason: 'default', text: '[queue] go' });

  // Nothing to read is still a lane, and never a throw.
  assert.deepEqual(classifyDelivery(undefined), { delivery: 'steer', reason: 'default', text: '' });

  // The scorer is gone, not dormant: no trigger or veto table is exported, so no
  // caller can read one back and nothing can route on it.
  assert.equal(mod.HALT_OPENERS, undefined);
  assert.equal(mod.CORRECTION_PHRASES, undefined);
  assert.equal(mod.DEFERRING_PHRASES, undefined);
  assert.equal(mod.STEER_MAX_CHARS, undefined);
});

test('talk_send is fire-and-forget by default and reports timedOut only when asked to wait', async () => {
  const { tool } = await toolWith('talk_send');
  const plain = JSON.parse((await tool.execute({ session: 'ses_a', text: 'hi' }, CALLER)).content);
  assert.equal(plain.timedOut, undefined, 'no wait, no polling');
  assert.equal(plain.messages, undefined);

  // A blocking send polls the newest message until the turn boundary marker that
  // follows the send: the marker already there before it must not count.
  const mod = await load();
  const calls = [];
  let posted = false;
  mod.setApiRunner(async (args) => {
    calls.push(args);
    const [verb] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'active work' } } };
    if (verb === 'post') {
      posted = true;
      return { ok: true, json: { data: { id: 'msg_sent', sessionID: 'ses_a' } } };
    }
    // Before the send the session already sits at a boundary; after it, a new one.
    return { ok: true, json: { data: [{ id: posted ? 'msg_new_idle' : 'msg_prev_idle', type: 'idle', time: { created: 6000 } }] } };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const waited = JSON.parse((await added.find((t) => t.name === 'talk_send').execute({ session: 'ses_a', text: 'hi', wait: 5 }, CALLER)).content);
  assert.equal(waited.delivered, true);
  assert.equal(waited.timedOut, false);
  assert.ok(typeof waited.waitedMs === 'number');
  assert.deepEqual(waited.messages.map((m) => m.role), ['idle']);
});

test('a turn boundary that predates the send never counts as completion', async () => {
  const mod = await load();
  mod.setApiRunner(async (args) => {
    const [verb, target] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'active work' } } };
    if (verb === 'post' && String(target).endsWith('/synthetic')) {
      return { ok: true, json: { data: { id: 'msg_sent', sessionID: 'ses_a' } } };
    }
    // The session's previous boundary marker, and nothing newer: the sent
    // message has not been acted on, so this is not completion.
    return { ok: true, json: { data: [{ id: 'msg_prev_idle', type: 'idle', time: { created: 1 } }] } };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const out = JSON.parse((await added.find((t) => t.name === 'talk_send').execute({ session: 'ses_a', text: 'hi', wait: 0.3 }, CALLER)).content);
  assert.equal(out.delivered, true);
  assert.equal(out.timedOut, true, 'an idle marker older than the send is not the turn ending');
  assert.ok(typeof out.waitedMs === 'number' && out.waitedMs >= 0);
});

test('a peer that never reaches a turn boundary reports timedOut:true, never success', async () => {
  const mod = await load();
  mod.setApiRunner(async (args) => {
    const [verb, target] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_busy', title: 'active busy' } } };
    if (verb === 'post' && String(target).endsWith('/synthetic')) {
      return { ok: true, json: { data: { id: 'msg_q', sessionID: 'ses_busy' } } };
    }
    // A newest message that is never the idle marker: the peer is mid-turn.
    return { ok: true, json: { data: [{ id: 'msg_q', type: 'user', time: { created: 1 }, text: 'q' }] } };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const out = JSON.parse((await added.find((t) => t.name === 'talk_inbox').execute({ session: 'ses_busy', wait: 0.3 }, CALLER)).content);
  assert.equal(out.error, undefined);
  assert.equal(out.sessionID, 'ses_busy');
  assert.equal(out.timedOut, true, 'a bounded block that gave up must say so');
});

test('a delivered send reports final reply-read failures without erasing delivery', async () => {
  const mod = await load();
  let posted = false;
  mod.setApiRunner(async (args) => {
    const [verb, target] = args;
    if (verb === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'active work' } } };
    if (verb === 'post' && String(target).endsWith('/synthetic')) {
      posted = true;
      return { ok: true, json: { data: { id: 'msg_sent', sessionID: 'ses_a' } } };
    }
    if (args.includes('limit=1')) return { ok: true, json: { data: [{ id: posted ? 'msg_new_idle' : 'msg_prev_idle', type: 'idle' }] } };
    return { ok: false, code: 'backend_error', detail: 'reply read unavailable' };
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const out = JSON.parse((await added.find((t) => t.name === 'talk_send').execute({ session: 'ses_a', text: 'hi', wait: 1 }, CALLER)).content);
  assert.equal(out.delivered, true);
  assert.equal(out.replyReadError.code, 'backend_error');
  assert.equal(out.messages, undefined);
});

test('waitForIdle honors an already-aborted signal', async () => {
  const mod = await load();
  let calls = 0;
  mod.setApiRunner(async () => { calls++; return { ok: true, json: { data: [{ id: 'busy', type: 'user' }] } }; });
  const controller = new AbortController();
  controller.abort();
  const out = await mod.waitForIdle('ses_a', 1000, 'old', { signal: controller.signal });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'cancelled');
  assert.equal(calls, 0);
});

test('waitForIdle cancellation interrupts the poll sleep', async () => {
  const mod = await load();
  mod.setApiRunner(async () => ({ ok: true, json: { data: [{ id: 'busy', type: 'user' }] } }));
  const controller = new AbortController();
  const started = Date.now();
  const waiting = mod.waitForIdle('ses_a', 1000, 'old', { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const out = await waiting;
  assert.equal(out.code, 'cancelled');
  assert.ok(Date.now() - started < 150, 'sleep must wake promptly on cancellation');
});

test('talk_send cancels target resolution before any message can be sent', async () => {
  const mod = await load();
  const calls = [];
  mod.setApiRunner(async (args, opts) => {
    calls.push(args);
    if (opts?.signal) {
      return new Promise((resolve) => {
        const abort = () => resolve({ ok: false, code: 'cancelled', detail: 'aborted' });
        if (opts.signal.aborted) abort();
        else opts.signal.addEventListener('abort', abort, { once: true });
      });
    }
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: { data: { id: 'ses_a', title: 'active work' } } }), 60));
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const controller = new AbortController();
  const request = added.find((t) => t.name === 'talk_send').execute(
    { session: 'ses_a', text: 'hi' },
    { ...CALLER, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 10);
  const out = JSON.parse((await request).content);
  assert.equal(out.error, 'cancelled');
  assert.equal(calls.some((args) => args[0] === 'post'), false, 'a cancelled resolution must never reach the send');
});

test('talk_send cancellation during the pre-send baseline prevents admission', async () => {
  const mod = await load();
  const calls = [];
  mod.setApiRunner(async (args, opts) => {
    calls.push(args);
    if (args[0] === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'active work' } } };
    return new Promise((resolve) => setTimeout(
      () => resolve({ ok: true, json: { data: [{ id: 'old', type: 'idle' }] } }),
      opts?.signal ? 60 : 0,
    ));
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const controller = new AbortController();
  const request = added.find((t) => t.name === 'talk_send').execute(
    { session: 'ses_a', text: 'hi', wait: 1 },
    { ...CALLER, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 10);
  const out = JSON.parse((await request).content);
  assert.equal(out.error, 'cancelled');
  assert.equal(calls.some((args) => args[0] === 'post'), false, 'a cancelled baseline must never reach the send');
});

test('talk_inbox cancellation covers target lookup and pre-wait baseline', async () => {
  const mod = await load();
  const calls = [];
  mod.setApiRunner(async (args, opts) => {
    calls.push(args);
    if (opts?.signal) {
      return new Promise((resolve) => {
        const abort = () => resolve({ ok: false, code: 'cancelled', detail: 'aborted' });
        if (opts.signal.aborted) abort();
        else opts.signal.addEventListener('abort', abort, { once: true });
      });
    }
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: { data: { id: 'ses_a', title: 'active work' } } }), 60));
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const controller = new AbortController();
  const request = added.find((t) => t.name === 'talk_inbox').execute(
    { session: 'ses_a', wait: 1 },
    { ...CALLER, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 10);
  const out = JSON.parse((await request).content);
  assert.equal(out.error, 'cancelled');
  assert.equal(calls.filter((args) => args[0] === 'session.message.list').length, 0);
});

test('talk_inbox passes cancellation through wait and bounds its final read by the deadline', async () => {
  const mod = await load();
  const calls = [];
  let reads = 0;
  mod.setApiRunner(async (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'active work' } } };
    if (args.includes('limit=1')) {
      reads++;
      return { ok: true, json: { data: [{ id: reads === 1 ? 'old' : 'busy', type: 'user' }] } };
    }
    return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ ok: false, code: 'timeout', detail: 'aborted' }), { once: true }));
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const controller = new AbortController();
  const started = Date.now();
  const request = added.find((t) => t.name === 'talk_inbox').execute(
    { session: 'ses_a', wait: 1 },
    { ...CALLER, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 30);
  const out = JSON.parse((await request).content);
  assert.equal(out.error, 'cancelled');
  assert.ok(Date.now() - started < 200, 'inbox wait must not run to its wait deadline');
  assert.ok(calls.filter((c) => c.args[0] === 'session.message.list').length < 3, 'no final read should run after cancellation');
});

test('talk_inbox final read cannot outlive the wait deadline', async () => {
  const mod = await load();
  let newestReads = 0;
  let finalSignal;
  mod.setApiRunner(async (args, opts) => {
    if (args[0] === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'active work' } } };
    if (args.includes('limit=1')) {
      newestReads++;
      return { ok: true, json: { data: [{ id: newestReads === 1 ? 'old' : 'fresh-idle', type: 'idle' }] } };
    }
    finalSignal = opts.signal;
    return new Promise((resolve) => {
      const finish = () => resolve({ ok: false, code: 'timeout', detail: 'aborted' });
      if (opts.signal.aborted) finish();
      else opts.signal.addEventListener('abort', finish, { once: true });
    });
  });
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const started = Date.now();
  const out = JSON.parse((await added.find((t) => t.name === 'talk_inbox').execute(
    { session: 'ses_a', wait: 0.05 },
    CALLER,
  )).content);
  assert.equal(out.error, 'timeout');
  assert.equal(finalSignal.aborted, true);
  assert.ok(Date.now() - started < 200, 'final read must be interrupted at the wait deadline');
});

test('waitForIdle bounds an in-flight read by its deadline', async () => {
  const mod = await load();
  mod.setApiRunner(async (_args, opts) => new Promise((resolve) => {
    opts.signal.addEventListener('abort', () => resolve({ ok: false, code: 'timeout', detail: 'aborted' }), { once: true });
  }));
  const started = Date.now();
  const out = await mod.waitForIdle('ses_a', 40, 'old');
  assert.equal(out.ok, true);
  assert.equal(out.timedOut, true);
  assert.ok(Date.now() - started < 250);
});

test('waitForIdle treats its deadline signal as timeout before the wall clock catches up', async () => {
  const mod = await load();
  mod.setApiRunner(async (_args, opts) => new Promise((resolve) => {
    opts.signal.addEventListener('abort', () => resolve({ ok: false, code: 'timeout', detail: 'aborted' }), { once: true });
  }));
  const actualNow = Date.now;
  const fixedNow = actualNow();
  Date.now = () => fixedNow;
  try {
    const out = await mod.waitForIdle('ses_a', 25, 'old');
    assert.equal(out.ok, true);
    assert.equal(out.timedOut, true);
  } finally {
    Date.now = actualNow;
  }
});

test('an invalid wait is a typed bad_request, never a silent default', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = await tool.execute({ session: 'ses_a', text: 'hi', wait: -1 }, CALLER);
  assert.deepEqual(JSON.parse(out.content), { error: 'bad_request', reason: 'wait must be a non-negative number of seconds' });
  assert.equal(calls.length, 0, 'the refusal happens before any backend call');
});

test('talk_inbox defaults to the calling session and extracts text, tools and role', async () => {
  const { tool, calls } = await toolWith('talk_inbox');
  const out = JSON.parse((await tool.execute({}, CALLER)).content);
  assert.equal(out.error, undefined, 'the calling session is enough: ' + JSON.stringify(out));
  assert.equal(out.sessionID, 'ses_caller');
  const first = out.messages[0];
  assert.deepEqual(first, {
    id: 'msg_reply',
    role: 'assistant',
    text: 'done',
    tools: [{ name: 'read', status: 'completed' }],
    time: 5000,
  });
  assert.deepEqual(out.messages[1], { id: 'msg_ours', role: 'user', text: 'hi', tools: [], time: 1000 });
  assert.deepEqual(out.cursor, { previous: null, next: 'next-page' });

  // The caller's id reached the direct getter, never a title search.
  assert.deepEqual(calls[0], ['session.get', '--param', 'sessionID=ses_caller']);
  // Newest first, one page, no order/cursor pair the server would 400.
  const read = calls.find((a) => a[0] === 'session.message.list');
  assert.ok(read.includes('limit=20'));
  assert.ok(!read.some((a) => String(a).startsWith('order=')));
});

test('talk_inbox requires a session when the host exposes no calling session', async () => {
  const { tool } = await toolWith('talk_inbox');
  const out = JSON.parse((await tool.execute({})).content);
  assert.deepEqual(out, { error: 'bad_request', reason: 'session must be a session id or title substring' });
});

test('talk_inbox filters with since, forwards type and pages with a cursor', async () => {
  const { tool, calls } = await toolWith('talk_inbox');
  const byId = JSON.parse((await tool.execute({ session: 'ses_a', since: 'msg_ours' }, CALLER)).content);
  assert.deepEqual(byId.messages.map((m) => m.id), ['msg_reply'], 'since keeps only what is newer');

  calls.length = 0;
  const typed = JSON.parse((await tool.execute({ session: 'ses_a', type: 'assistant', limit: 5 }, CALLER)).content);
  assert.equal(typed.messages.length, 2);
  const read = calls.find((a) => a[0] === 'session.message.list');
  assert.ok(read.includes('type=assistant'));
  assert.ok(read.includes('limit=5'));

  // An opaque cursor goes to the server verbatim, alone, with the same type filter.
  calls.length = 0;
  await tool.execute({ session: 'ses_a', since: 'opaque-token', type: 'assistant' }, CALLER);
  const paged = calls.filter((a) => a[0] === 'session.message.list').pop();
  assert.ok(paged.includes('cursor=opaque-token'));
  assert.ok(paged.includes('type=assistant'), 'the cursor page keeps the type filter');
  assert.ok(!paged.some((a) => String(a).startsWith('order=')));

  // A message id is a message id: if it is not on the page, that is a typed
  // failure, never a silent reinterpretation as a cursor.
  calls.length = 0;
  const missing = JSON.parse((await tool.execute({ session: 'ses_a', since: 'msg_not_here' }, CALLER)).content);
  assert.equal(missing.error, 'since_not_on_page');
  assert.match(missing.reason, /msg_not_here is not in this page/);
  assert.match(missing.hint, /cursor/);
  assert.equal(calls.filter((a) => a[0] === 'session.message.list').length, 1, 'a message id never triggers a cursor page');
});

test('descriptions stay at three sentences or fewer', async () => {
  const { ctx, added } = host();
  await (await load()).default.setup(ctx);
  const sentences = (d) => d.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  for (const tool of added) {
    const n = sentences(tool.description);
    assert.ok(n <= 3, tool.name + ' description is ' + n + ' sentences: ' + tool.description);
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
    options: { boardFile: BOARD_FILE },
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
  assert.equal(await mod.default.setup(ctx), undefined);
  assert.equal(registrations.length, 1, 'setup must register');
  assert.deepEqual(registrations[0].added.map((t) => t.name), TOOLS);
  assert.equal(registrations[0].disposed, 0, 'the registration is live after setup');
});

// The live service boots the plugin once per location - the workspace directory
// and the config directory under it - and each boot owns its own tool domain.
// One module-level registration made the second boot dispose the first boot's
// transform, so that location's sessions saw zero oc-talk tools while the plugin
// still reported active. Registrations are per location, and a reload of one
// location must not touch another's.
test('two host locations each keep their own live registration', async () => {
  const mod = await load();
  const first = reloadHost({ workspaceID: 'ws', directory: 'C:\\proj' });
  const second = reloadHost({ workspaceID: 'ws', directory: 'C:\\proj\\.config\\opencode' });

  await mod.ensureTools(first.ctx);
  await mod.ensureTools(second.ctx);

  assert.equal(first.registrations.length, 1, 'the first location must register');
  assert.equal(second.registrations.length, 1, 'the second location must register');
  assert.equal(first.registrations[0].disposed, 0, 'the second location must not dispose the first location\'s tools');
  assert.equal(second.registrations[0].disposed, 0, 'the second location\'s own registration is live');
  assert.deepEqual(first.registrations[0].added.map((t) => t.name), TOOLS);
  assert.deepEqual(second.registrations[0].added.map((t) => t.name), TOOLS);

  await mod.ensureTools(first.ctx);
  assert.equal(first.registrations.length, 2, 'a reload must re-register that location');
  assert.equal(first.registrations[0].disposed, 1, 'a reload disposes its own previous registration');
  assert.equal(first.registrations[1].disposed, 0, 'the re-registered transform is live');
  assert.equal(second.registrations.length, 1, 'the other location must not re-register');
  assert.equal(second.registrations[0].disposed, 0, 'the other location must be untouched');
});

// The board tools go through the same host registration as the two messaging
// tools. Only the board path is swapped: the module's own seam points them at a
// temp file, so the real read/write code runs with no harness service.
const BOARD = [
  '# nstack board',
  'rows:',
  "  - session: 'ses_a'",
  "    state: 'active'",
  "    ticket: 'T-parser'",
  "    seam: 'parser'",
  "    since: '2026-11-26T00:00:00.000Z'",
  "  - session: 'ses_b'",
  "    state: 'parked'",
  "    ticket: 'T-docs'",
  "    seam: 'docs'",
  "    since: '2026-11-26T01:00:00.000Z'",
  '',
].join('\n');

async function boardTools(t, contents) {
  const mod = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-talk-board-'));
  const file = path.join(dir, 'board.yaml');
  if (contents !== undefined) fs.writeFileSync(file, contents, 'utf8');
  mod.setBoardFile(file);
  const { ctx, added } = host({ boardFile: file });
  await mod.default.setup(ctx);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { file, added, byName: (name) => added.find((tool) => tool.name === name) };
}

test('boardFile opts in to all four tools and talk_claim keeps its gates', async (t) => {
  const { added, byName } = await boardTools(t, BOARD);
  assert.deepEqual(added.map((tool) => tool.name), TOOLS);
  const refused = JSON.parse((await byName('talk_claim').execute(
    { seam: 'parser', ticket: 'T-no' }, { ...CALLER, sessionID: 'ses_intruder' },
  )).content);
  assert.equal(refused.error, 'seam_taken', 'a held seam is still refused: ' + JSON.stringify(refused));
  assert.match(refused.reason, /ses_a/, 'the holder is still named');
});

test('talk_board returns an empty list and a clear message when the board file is missing', async (t) => {
  const { byName, file } = await boardTools(t);
  const out = JSON.parse((await byName('talk_board').execute({}, CALLER)).content);
  assert.equal(out.error, undefined, 'a missing board is not an error: ' + JSON.stringify(out));
  assert.equal(out.file, file);
  assert.equal(out.version, 1);
  assert.deepEqual(out.rows, []);
  assert.match(out.message, /no board.*board\.yaml.*empty/);
});

test('talk_board returns every existing row with the five contract fields', async (t) => {
  const { byName, file } = await boardTools(t, BOARD);
  const out = JSON.parse((await byName('talk_board').execute({}, CALLER)).content);
  assert.equal(out.error, undefined);
  assert.equal(out.file, file);
  assert.equal(out.version, 1);
  assert.equal(out.message, undefined);
  assert.deepEqual(out.rows, [
    { session: 'ses_a', state: 'active', ticket: 'T-parser', seam: 'parser', since: '2026-11-26T00:00:00.000Z' },
    { session: 'ses_b', state: 'parked', ticket: 'T-docs', seam: 'docs', since: '2026-11-26T01:00:00.000Z' },
  ]);
});

test('talk_claim on a free seam writes a plain-YAML row with an ISO-8601 since', async (t) => {
  const { byName, file } = await boardTools(t);
  const row = JSON.parse((await byName('talk_claim').execute({ seam: 'parser', ticket: 'T-7' }, { ...CALLER, sessionID: 'ses_me' })).content);
  assert.equal(row.error, undefined, JSON.stringify(row));
  assert.deepEqual(Object.keys(row).sort(), ['seam', 'session', 'since', 'state', 'ticket']);
  assert.equal(row.session, 'ses_me');
  assert.equal(row.state, 'active', 'state defaults to active');
  assert.equal(row.ticket, 'T-7');
  assert.equal(row.seam, 'parser');
  assert.match(row.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'ISO-8601 since');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^rows:/m, 'plain YAML, readable without the plugin');
  assert.match(text, /session: 'ses_me'/);
  assert.match(text, /seam: 'parser'/);
  // The other tool on the same registration reads back exactly that row.
  const board = JSON.parse((await byName('talk_board').execute({}, CALLER)).content);
  assert.deepEqual(board.rows, [row]);
});

test('talk_claim on a taken seam is refused with the holder named and writes nothing', async (t) => {
  const { byName, file } = await boardTools(t, BOARD);
  const out = JSON.parse(
    (await byName('talk_claim').execute({ seam: 'parser', ticket: 'T-x' }, { ...CALLER, sessionID: 'ses_intruder' })).content,
  );
  assert.equal(out.error, 'seam_taken');
  assert.match(out.reason, /ses_a/, 'the holder is named');
  assert.match(out.reason, /active/, 'the holder\'s state is named');
  assert.equal(fs.readFileSync(file, 'utf8'), BOARD, 'the authoritative file is untouched');
});

test('a parked row on the seam is not silently stolen by another session', async (t) => {
  const { byName, file } = await boardTools(t, BOARD);
  const out = JSON.parse((await byName('talk_claim').execute({ seam: 'docs' }, { ...CALLER, sessionID: 'ses_other' })).content);
  assert.equal(out.error, 'seam_taken');
  assert.match(out.reason, /ses_b/);
  assert.match(out.reason, /parked/);
  assert.equal(fs.readFileSync(file, 'utf8'), BOARD, 'a stale row is refused, not overwritten');
});

test('re-claiming your own seam updates its row instead of adding a duplicate', async (t) => {
  const { byName, file } = await boardTools(t, BOARD);
  const context = { ...CALLER, sessionID: 'ses_a' };
  const first = JSON.parse((await byName('talk_claim').execute({ seam: 'parser', ticket: 'T-9' }, context)).content);
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.equal(first.ticket, 'T-9');
  const second = JSON.parse((await byName('talk_claim').execute({ seam: 'parser', state: 'parked' }, context)).content);
  assert.equal(second.error, undefined);
  assert.equal(second.ticket, 'T-9', 'an omitted ticket keeps the existing one');
  assert.equal(second.state, 'parked');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.split('session:').length - 1, 2, 'still two rows, not three');
  const board = JSON.parse((await byName('talk_board').execute({}, CALLER)).content);
  assert.equal(board.rows.length, 2);
  assert.deepEqual(board.rows.find((row) => row.session === 'ses_a'), second);
  assert.equal(board.rows.find((row) => row.session === 'ses_b').seam, 'docs', 'the other row is untouched');
});
