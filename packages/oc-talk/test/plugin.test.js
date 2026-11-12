// Offline contract tests for the two-tool surface.
//
// These prove what a host can break without any peer running: exactly two tools
// register with their exact routing descriptions, title resolution answers with
// candidates or near-misses instead of a guess, a capped resolution refuses
// instead of authorizing a single match, the send chooses its delivery lane by
// urgency (by default, not as a constant) and carries a client id, the inbox
// defaults to the calling session, and the transport file
// is the only place a credential or a loopback address appears.
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
    'Deliver one text message into another session by id (ses_...) or unambiguous title substring; it is admitted in milliseconds rather than answered, and `delivery` defaults to `auto`: a short correction or stop steers into the target\'s current turn, a work handoff queues to its next turn, and an explicit steer or queue overrides. ' +
    'Fire to hand work or a correction to a peer, put a leading [steer] or [queue] in the text to choose without the argument, or pass `wait` seconds to block until that session reaches a turn boundary and return what it said. ' +
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

// A long, neutral brief: far past the length guard, and carrying `red` and `now`
// inside real instructions, where they are context and not a stop signal.
const LONG_HANDOFF =
  'Take the parser lane from red to green: read the failure output, find the input that breaks it, fix the smallest thing that explains it, add a regression case, and run the full suite before reporting. '.repeat(
    4,
  ) + 'Do that now.';

test('talk_send queues a handoff by default, carries a client id, and returns the admission', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: 'do the thing' }, CALLER)).content);
  assert.deepEqual(out, {
    id: 'msg_sent',
    sessionID: 'ses_a',
    title: 'active work',
    delivered: true,
    delivery: 'queue',
    deliveryReason: 'handoff',
  });

  const body = promptBody(calls);
  assert.equal(body.text, 'do the thing');
  assert.equal(body.delivery, 'queue', 'a neutral short task is a handoff: it waits for the next turn');
  assert.equal(body.resume, undefined, 'the admission shape carries no resume flag');
  assert.match(body.id, /^msg_[0-9a-f]{32}$/, 'the id is a client-generated msg id, so a retry is idempotent');

  // Two sends are two admissions, never one idempotent replay.
  const again = JSON.parse((await tool.execute({ session: 'ses_a', text: 'again' }, CALLER)).content);
  assert.equal(again.delivered, true);
  const bodies = calls.filter((a) => a[0] === 'post' && String(a[1]).endsWith('/prompt')).map((a) => JSON.parse(a[3]));
  assert.notEqual(bodies[0].id, bodies[1].id);
});

test('a short stop or correction steers into the target\'s current turn', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: 'Stop — that migration is wrong, revert it.' }, CALLER)).content);
  assert.equal(out.error, undefined);
  assert.equal(out.delivery, 'steer', 'a correction must not wait a whole turn to be read');
  assert.equal(out.deliveryReason, 'urgent');
  assert.equal(promptBody(calls).delivery, 'steer');
});

test('a [steer] marker chooses the current turn and is stripped from the delivered text', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: '[steer] Stop the deploy.' }, CALLER)).content);
  assert.equal(out.error, undefined);
  assert.equal(out.delivery, 'steer');
  assert.equal(out.deliveryReason, 'marker');
  const body = promptBody(calls);
  assert.equal(body.delivery, 'steer');
  assert.equal(body.text, 'Stop the deploy.', 'the marker is routing, not content');
});

test('a [queue] marker beats the urgent phrase it wraps', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: '[queue] stop, that\'s wrong' }, CALLER)).content);
  assert.equal(out.delivery, 'queue');
  assert.equal(out.deliveryReason, 'marker');
  const body = promptBody(calls);
  assert.equal(body.delivery, 'queue');
  assert.equal(body.text, 'stop, that\'s wrong');
});

// The anti-false-positive case: a task brief that mentions `red` and `now` is
// still a handoff. Removing the length guard must turn this red.
test('an 817-character handoff containing red and now still queues', async () => {
  assert.ok(LONG_HANDOFF.length > 800, 'the fixture must be far past the guard: ' + LONG_HANDOFF.length);
  const { tool, calls } = await toolWith('talk_send');
  const out = JSON.parse((await tool.execute({ session: 'ses_a', text: LONG_HANDOFF }, CALLER)).content);
  assert.equal(out.delivery, 'queue', 'a long brief is never steered');
  assert.equal(out.deliveryReason, 'handoff');
  assert.equal(promptBody(calls).delivery, 'queue');
});

test('an explicit delivery wins over the scorer, in both directions', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const steered = JSON.parse((await tool.execute({ session: 'ses_a', text: LONG_HANDOFF, delivery: 'steer' }, CALLER)).content);
  assert.equal(steered.delivery, 'steer');
  assert.equal(steered.deliveryReason, 'explicit');
  assert.equal(promptBody(calls).delivery, 'steer');

  const queued = JSON.parse((await tool.execute({ session: 'ses_a', text: 'Stop, that is wrong.', delivery: 'queue' }, CALLER)).content);
  assert.equal(queued.delivery, 'queue', 'an explicit queue overrides the urgent scorer');
  assert.equal(queued.deliveryReason, 'explicit');
});

test('wait implies a handoff: an urgent line under auto still queues when the caller waits', async () => {
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
  const out = JSON.parse(
    (await added.find((t) => t.name === 'talk_send').execute({ session: 'ses_a', text: 'Stop, that is the wrong file.', wait: 30 }, CALLER)).content,
  );
  assert.equal(out.delivery, 'queue', 'waiting for the answer makes it a new turn by definition');
  assert.equal(out.deliveryReason, 'wait');
  const posts = calls.filter((a) => a[0] === 'post');
  assert.equal(JSON.parse(posts.at(-1)[3]).delivery, 'queue');
});

test('an invalid delivery is a typed bad_request and sends nothing', async () => {
  const { tool, calls } = await toolWith('talk_send');
  const out = await tool.execute({ session: 'ses_a', text: 'hi', delivery: 'now' }, CALLER);
  assert.equal(JSON.parse(out.content).error, 'bad_request');
  assert.equal(JSON.parse(out.content).reason, 'delivery must be auto, steer, or queue');

  const notString = await tool.execute({ session: 'ses_a', text: 'hi', delivery: 5 }, CALLER);
  assert.equal(JSON.parse(notString.content).error, 'bad_request');
  assert.equal(calls.length, 0, 'the refusal happens before any backend call');
});

test('classifyDelivery is pure: marker strip, precedence, and the length boundary', async () => {
  const { classifyDelivery, STEER_SIGNALS, STEER_MAX_CHARS } = await load();
  assert.ok(Array.isArray(STEER_SIGNALS) && STEER_SIGNALS.includes('stop'), 'the signals are quotable data');
  assert.equal(STEER_MAX_CHARS, 400);

  assert.deepEqual(classifyDelivery('  [STEER]   Stop it.', 0, 'auto'), { delivery: 'steer', reason: 'marker', text: 'Stop it.' });
  assert.deepEqual(classifyDelivery('queue: STOP', 0, 'auto'), { delivery: 'queue', reason: 'marker', text: 'STOP' });
  assert.equal(classifyDelivery('Stop it.', 0, 'queue').reason, 'explicit');
  assert.equal(classifyDelivery('Stop it.', 30, 'auto').reason, 'wait');
  assert.equal(classifyDelivery('run the tests', 0, 'auto').reason, 'handoff');

  // The guard is a length rule, exactly at its boundary.
  const atLimit = 'stop ' + 'x'.repeat(STEER_MAX_CHARS - 5);
  assert.equal(atLimit.length, STEER_MAX_CHARS);
  assert.equal(classifyDelivery(atLimit, 0, 'auto').delivery, 'steer');
  assert.equal(classifyDelivery(atLimit + 'x', 0, 'auto').delivery, 'queue');
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
    // The session's previous boundary marker, and nothing newer: the queued
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
