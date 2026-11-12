// The live judge. Skipped unless OC_TALK_LIVE=1.
//
// It is the only test that speaks to the real service: it creates a probe
// session, calls the plugin's own `talk_send` into it, then `talk_inbox` and
// asserts the text came back through the transport. If the HTTP route, the
// credential resolution or the message shape regresses, this goes red — the
// offline suite cannot see any of that.
//
// Probe sessions are titled `oc-talk-live-probe <stamp>`: unique per run, so a
// title lookup can never be answered by an older probe.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const LIVE = process.env.OC_TALK_LIVE === '1';
const SKIP = LIVE ? false : 'set OC_TALK_LIVE=1 to run against the local service';

const ENTRY = path.join(import.meta.dirname, '..', 'src', 'index.js');
const TRANSPORT = path.join(import.meta.dirname, '..', 'src', 'transport.mjs');

function host() {
  const added = [];
  const ctx = { tool: { transform: async (fn) => fn({ add: (tool) => added.push(tool) }) } };
  return { ctx, added };
}

test('live: talk_send delivers into a real session and talk_inbox reads it back', { skip: SKIP }, async () => {
  const transport = await import(pathToFileURL(TRANSPORT).href);
  const mod = await import(pathToFileURL(ENTRY).href);

  const created = await transport.createSession({ title: 'oc-talk-live-probe ' + Date.now() });
  assert.equal(created.ok, true, 'probe session creation failed: ' + JSON.stringify(created));
  const sessionID = created.json.data.id;
  assert.match(sessionID, /^ses_/, 'the service must return a real session id');

  const { ctx, added } = host();
  await mod.default.setup(ctx);
  assert.deepEqual(added.map((t) => t.name), ['talk_send', 'talk_inbox'], 'live install must register exactly two tools');

  const context = { sessionID, signal: undefined };
  const text = 'oc-talk live probe ' + Date.now() + ' — reply with the single word OK.';
  const sent = JSON.parse((await added.find((t) => t.name === 'talk_send').execute({ session: sessionID, text }, context)).content);
  assert.equal(sent.error, undefined, 'send failed: ' + JSON.stringify(sent));
  assert.equal(sent.delivered, true);
  assert.equal(sent.sessionID, sessionID);
  assert.ok(sent.id, 'the admission must carry a message id');

  // Read it back through the tool: the user echo is in the target's messages.
  const inbox = JSON.parse((await added.find((t) => t.name === 'talk_inbox').execute({ session: sessionID, limit: 20 }, context)).content);
  assert.equal(inbox.error, undefined, 'inbox failed: ' + JSON.stringify(inbox));
  assert.equal(inbox.sessionID, sessionID);
  assert.ok(Array.isArray(inbox.messages) && inbox.messages.length > 0, 'the inbox must return the echo');
  const found = inbox.messages.find((m) => typeof m.text === 'string' && m.text.includes(text));
  assert.ok(found, 'the sent text must be present: ' + JSON.stringify(inbox.messages));
  assert.equal(found.role, 'user');
  assert.ok(Array.isArray(found.tools), 'every row carries a tools array');
  assert.ok(typeof found.time === 'number');
});

test('live: talk_inbox resolves a title through search, and the default session is the caller', { skip: SKIP }, async () => {
  const transport = await import(pathToFileURL(TRANSPORT).href);
  const mod = await import(pathToFileURL(ENTRY).href);

  const title = 'oc-talk-live-probe ' + Date.now();
  const created = await transport.createSession({ title });
  assert.equal(created.ok, true, 'probe session creation failed: ' + JSON.stringify(created));
  const sessionID = created.json.data.id;

  const { ctx, added } = host();
  await mod.default.setup(ctx);
  const inbox = added.find((t) => t.name === 'talk_inbox');
  const context = { sessionID, signal: undefined };

  const text = 'title-resolved probe ' + Date.now();
  const sent = JSON.parse((await added.find((t) => t.name === 'talk_send').execute({ session: title, text }, context)).content);
  assert.equal(sent.error, undefined, 'title send failed: ' + JSON.stringify(sent));
  assert.equal(sent.sessionID, sessionID, 'the title must resolve to the probe session id');
  assert.equal(sent.title, title, 'the resolved title is reported back');

  // No `session` argument: the calling session id from the execute context wins.
  const own = JSON.parse((await inbox.execute({ limit: 20 }, context)).content);
  assert.equal(own.error, undefined, 'own-inbox failed: ' + JSON.stringify(own));
  assert.equal(own.sessionID, sessionID);
  assert.ok(own.messages.some((m) => typeof m.text === 'string' && m.text.includes(text)));
});
