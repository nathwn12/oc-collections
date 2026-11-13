// Offline contract tests for the two-tool surface.
//
// These prove what a host can break without any peer running: exactly two tools
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
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ENTRY = path.join(import.meta.dirname, '..', 'src', 'index.js');
const TRANSPORT = path.join(import.meta.dirname, '..', 'src', 'transport.mjs');

let loads = 0;
// Fresh module instance per test: the live registration handle is per-instance
// state, and a cached module would carry one test's registration into the next.
const load = () => import(pathToFileURL(ENTRY).href + '?n=' + ++loads);

const TOOLS = ['talk_send', 'talk_inbox'];

const DESCRIPTIONS = {
  talk_send:
    'Deliver one text message into another session by id (ses_...) or unambiguous title substring; every send steers into the target\'s current turn at its next step boundary, and a leading `[steer]` or `STEER:` marker is stripped before delivery. ' +
    'Fire to hand work or correct a peer mid-turn: the call is admitted in milliseconds rather than answered, and an optional `wait` seconds only polls afterwards for the target\'s next turn boundary and returns what it said. ' +
    'Never guesses: an unknown or ambiguous title returns the candidate list as data.',
  talk_inbox:
    'Read one session\'s messages as id, role, text, tools and time, newest first, default 20; `session` defaults to the session that called this tool, `since` keeps only what is newer, and `cursor` pages. ' +
    'Fire to see what a peer said or what your own conversation has produced; with `wait` seconds it blocks until the session reaches a turn boundary first. ' +
    'Reads only: it never sends, wakes, or steers the other session, and an unknown title returns candidates instead of a guess.',
};

const SESSIONS = [
  { id: 'ses_a', title: 'build lane', directory: '/work/a', updated: 10 },
  { id: 'ses_b', title: 'build lane two', directory: '/work/b', updated: 20 },
  { id: 'ses_solo', title: 'smoke tests', directory: '/work/c', updated: 30 },
];

// The scan seam the resolver takes in place of the real search backend.
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

test('the V2 definition registers exactly talk_send and talk_inbox through setup', async () => {
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

// The eleven lifecycle and conversation verbs are gone, not hidden behind a flag:
// an absent tool must fail here before a host can offer it again.
test('the deleted verbs are absent from the surface and from the source', async () => {
  const mod = await load();
  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const names = added.map((t) => t.name);
  assert.equal(names.length, 2, 'the surface is exactly two tools');

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
    if (verb === 'post' && String(target).endsWith('/prompt')) {
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

// The prompt body the backend actually received, parsed: the payload, not the
// intent, is what these cases assert on.
function promptBody(calls) {
  const call = calls.find((a) => a[0] === 'post' && String(a[1]).endsWith('/prompt'));
  return call ? JSON.parse(call[3]) : null;
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
    if (verb === 'post' && String(target).endsWith('/prompt')) {
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
    delivered: true,
    delivery: 'steer',
    deliveryReason: 'default',
  });

  const body = promptBody(calls);
  assert.equal(body.text, 'do the thing');
  assert.equal(body.delivery, 'steer', 'there is one lane, and it is on the wire');
  assert.equal(body.resume, undefined, 'the admission shape carries no resume flag');
  assert.match(body.id, /^msg_[0-9a-f]{32}$/, 'the id is a client-generated msg id, so a retry is idempotent');

  // Two sends are two admissions, never one idempotent replay.
  const again = JSON.parse((await tool.execute({ session: 'ses_a', text: 'again' }, CALLER)).content);
  assert.equal(again.delivered, true);
  const bodies = calls.filter((a) => a[0] === 'post' && String(a[1]).endsWith('/prompt')).map((a) => JSON.parse(a[3]));
  assert.notEqual(bodies[0].id, bodies[1].id);
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
    const body = promptBody(calls);
    assert.equal(body.delivery, 'steer', 'posted lane for: ' + label);
    assert.equal(body.text, text, 'delivered text for: ' + label);
  }
});

test('a [steer] marker is stripping, not routing: the text is what is delivered', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: '[steer] Stop the deploy.' }, CALLER)).content);
  assert.equal(out.error, undefined);
  assert.equal(out.delivery, 'steer');
  assert.equal(out.deliveryReason, 'marker');
  const body = promptBody(calls);
  assert.equal(body.delivery, 'steer');
  assert.equal(body.text, 'Stop the deploy.', 'the marker is routing, not content');
});

test('[queue] is ordinary text now and arrives intact', async () => {
  const { tool, calls } = await toolWith('talk_send');
  for (const text of ['[queue] stop, that\'s wrong', '[queue](https://example.com) is the doc', 'queue: STOP']) {
    calls.length = 0;
    const out = JSON.parse((await tool.execute({ session: 'ses_a', text }, CALLER)).content);
    assert.equal(out.error, undefined, 'send failed for: ' + JSON.stringify(text));
    assert.equal(out.delivery, 'steer', 'queue in the text changes nothing: ' + JSON.stringify(text));
    assert.equal(out.deliveryReason, 'default', 'it is not a marker: ' + JSON.stringify(text));
    const body = promptBody(calls);
    assert.equal(body.text, text, 'the text survives byte for byte: ' + JSON.stringify(text));
    assert.equal(body.delivery, 'steer', 'the wire lane is unchanged: ' + JSON.stringify(text));
  }
});

test('an explicit delivery: "steer" is accepted and reported as explicit', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: LONG_HANDOFF, delivery: 'steer' }, CALLER)).content);
  assert.equal(out.error, undefined);
  assert.equal(out.delivery, 'steer');
  assert.equal(out.deliveryReason, 'explicit');
  const body = promptBody(calls);
  assert.equal(body.delivery, 'steer');
  assert.equal(body.text, LONG_HANDOFF, 'a long body is delivered unclassified and unwritten');
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
  assert.equal(promptBody(calls).delivery, 'steer', 'the wire lane is unchanged by the wait');
});

test('wait polls after a [steer] send and never changes the lane', async () => {
  const { tool, calls } = await waitingTool();
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: '[steer] Stop — that is the wrong branch.', wait: 30 }, CALLER)).content);
  assert.equal(out.error, undefined, 'the send itself still succeeds: ' + JSON.stringify(out));
  assert.equal(out.delivery, 'steer');
  assert.equal(out.deliveryReason, 'marker');
  assert.equal(promptBody(calls).delivery, 'steer');
  assert.equal(promptBody(calls).text, 'Stop — that is the wrong branch.', 'the marker is still stripped');
});

test('wait on a plain send steers first and polls the boundary that follows it', async () => {
  const { tool, calls } = await waitingTool();
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: 'do the thing', wait: 30 }, CALLER)).content);
  assert.equal(out.error, undefined, 'the send itself still succeeds: ' + JSON.stringify(out));
  assert.equal(out.delivery, 'steer');
  assert.equal(out.deliveryReason, 'default');
  assert.equal(promptBody(calls).delivery, 'steer');
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
    if (verb === 'post' && String(target).endsWith('/prompt')) {
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
    if (verb === 'post' && String(target).endsWith('/prompt')) {
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
