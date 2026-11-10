/**
 * The session title as live status, and the close loop that ends a turn.
 *
 * Two halves: the pure decisions in lib/title.js, and the hooks index.js wires
 * into a fake host. The fake ctx is deliberately thin - it records every session
 * call and offers exactly the four surfaces a real host does - so an assertion
 * here fails when the plugin stops asking, not when the host changes.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import plugin from '../../index.js';
import { signReceipt } from '../../lib/close.js';
import { STATUS, intentOf, isDone, statusOf, stripStatus, withStatus } from '../../lib/title.js';
import { head } from '../../lib/git.js';

export async function register(ctx) {
  const { check, checkAsync, assert, configuredRepo, runIn } = ctx;

  const INTENT = path.join('.stack', 'state', 'close-intent.json');
  const RECEIPT = path.join('.stack', 'state', 'close.json');
  const ARMED = path.join('.stack', 'state', 'close-armed.json');
  const LEDGER = path.join('.stack', 'ledger.md');
  const intentFile = (d) => path.join(d, INTENT);
  const ledgerOf = (d) => (fs.existsSync(path.join(d, LEDGER)) ? fs.readFileSync(path.join(d, LEDGER), 'utf8') : '');

  /**
   * A receipt the close code accepts: a real uuid, this HEAD, the same HEAD on
   * the check run, a passing preflight criterion, a fresh `at`, and the HMAC the
   * writer signs. A hand-written shape is not evidence without it.
   */
  const writeReceipt = (d, patch = {}) => {
    const sha = head(d);
    const at = new Date().toISOString();
    const body = {
      go: true,
      receipt_id: crypto.randomUUID(),
      sealed: sha.slice(0, 7),
      at,
      head: sha,
      branch: 'main',
      tree: [],
      criteria: [{ id: 'preflight', status: 'pass', evidence: [] }],
      checks: { at, head: sha, results: [{ name: 'ok', ok: true, code: 0, ms: 1 }] },
      sweep: { removed: [], kept: [] },
      junk: [],
      atlas: { status: 'not configured', code: null, ms: 0 },
      lesson: 'a fixture receipt, written by the check itself',
      ...patch,
    };
    fs.mkdirSync(path.join(d, '.stack', 'state'), { recursive: true });
    fs.writeFileSync(path.join(d, RECEIPT), JSON.stringify({ ...body, sig: signReceipt(body) }, null, 2));
  };

  const writeIntent = (d, sessionID, attempts = 0) => {
    fs.mkdirSync(path.join(d, '.stack', 'state'), { recursive: true });
    fs.writeFileSync(
      intentFile(d),
      JSON.stringify({ [sessionID]: { attempts, at: new Date().toISOString(), head: head(d) } }, null, 2),
    );
  };
  const intentsOf = (d) => (fs.existsSync(intentFile(d)) ? JSON.parse(fs.readFileSync(intentFile(d), 'utf8')) : {});

  /**
   * A host with the surfaces setup() registers against. `titles` seeds the
   * sessions; every call the plugin makes is recorded in `calls`. `compactError`
   * makes the one host call that can fail on its own fail, because a compaction
   * that throws must not take the seal with it.
   */
  const fixture = ({ titles = { ses_a: 'retry budget' }, messages = [], compactError = null } = {}) => {
    const d = configuredRepo();
    const hooks = new Map();
    const calls = { get: 0, update: [], synthetic: [], context: 0, subscribe: 0, compact: [], log: [] };
    const records = new Map(Object.entries(titles).map(([id, title]) => [id, { id, title, directory: d }]));
    // The event loop is driven by this queue, so a check can deliver the host
    // events a real session sends (a rename echo, a new turn) and then wait for
    // the one effect it can see. Nothing is replayed: an event emitted before
    // setup subscribes is still delivered, because the generator reads the queue.
    const queue = [];
    const emitted = [];
    let wake = null;

    const host = {
      location: { directory: d },
      app: { version: 'test' },
      skill: { transform: async (fn) => fn({ add() {} }) },
      tool: {
        transform: async (fn) => fn({ add() {}, namespace() {} }),
        hook: async (name, handler) => {
          hooks.set(`tool.${name}`, handler);
        },
      },
      session: {
        hook: async (name, handler) => {
          hooks.set(`session.${name}`, handler);
        },
        get: async ({ sessionID }) => {
          calls.get += 1;
          const record = records.get(sessionID);
          return record ? { ...record } : null;
        },
        update: async (input) => {
          calls.update.push(input);
          calls.log.push('update');
          const record = records.get(input.sessionID);
          if (record && typeof input.title === 'string') record.title = input.title;
          return true;
        },
        // The real compaction is a host call that returns an inbox item, not a
        // summary: recording it is the whole evidence that the seal asked.
        compact: async (input) => {
          calls.compact.push(input);
          calls.log.push('compact');
          if (compactError) throw compactError;
          return { queued: true };
        },
        context: async () => {
          calls.context += 1;
          return { data: messages };
        },
        synthetic: async (input) => {
          calls.synthetic.push(input);
          return true;
        },
      },
      event: {
        // Yields queued events and returns nothing on its own: setup must
        // subscribe, and the check must not wait on a host that never sends one.
        subscribe: async function* () {
          calls.subscribe += 1;
          for (;;) {
            if (!queue.length) {
              await new Promise((resolve) => {
                wake = resolve;
              });
              continue;
            }
            yield queue.shift();
          }
        },
      },
    };

    return {
      ctx: host,
      dir: d,
      records,
      calls,
      messages,
      /** Deliver one host event to the plugin's subscription. */
      emit: (event) => {
        emitted.push(event);
        queue.push(event);
        if (wake) {
          const resume = wake;
          wake = null;
          resume();
        }
      },
      /** Wait (bounded) for a visible effect of the plugin's event handling. */
      until: async (predicate, what) => {
        for (let i = 0; i < 400; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`${what} (events: ${emitted.map((e) => e.type).join(', ') || 'none'})`);
      },
      hook: (name) => {
        const handler = hooks.get(name);
        assert(handler, `setup did not register ${name}`);
        return handler;
      },
      titleOf: (id) => records.get(id).title,
      shut: () => fs.rmSync(d, { recursive: true, force: true }),
    };
  };

  const throws = async (fn, pattern, what) => {
    let caught = null;
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
    assert(caught, `${what}: nothing was thrown`);
    assert(pattern.test(caught.message), `${what}: ${caught.message}`);
    return caught.message;
  };

  // ---------------------------------------------------------------- pure decisions
  check('one status prefix, replaced and never stacked', () => {
    assert(STATUS.active === '[active]' && STATUS.parked === '[parked]' && STATUS.done === '[done]', 'the status vocabulary moved');
    assert(stripStatus('[done] retry budget') === 'retry budget', `stripStatus left the prefix: ${stripStatus('[done] retry budget')}`);
    assert(stripStatus('[active]') === '', 'a bare prefix did not strip to nothing');
    assert(stripStatus('retry budget') === 'retry budget', 'a prefixless title was altered');
    assert(withStatus('[parked] retry budget', 'done') === '[done] retry budget', 'the old prefix was stacked, not replaced');
    assert(withStatus('retry budget', 'active') === '[active] retry budget', 'the prefix was not added');
    assert(withStatus('', 'active') === '[active]', 'the empty title did not take the bare prefix');
    assert(statusOf('[DONE] x') === 'done', 'a status claim is case-blind');
    assert(statusOf('x') === null, 'a prefixless title claimed a status');
    assert(isDone('[done] x') && !isDone('[parked] x'), 'isDone disagrees with statusOf');
    return 'four transitions, no stacking';
  });

  check('the close phrases are recognised and a negation is not one', () => {
    for (const said of ['close the session', 'ok, wrap it up', 'call it done', "we're done here", 'shut it down', 'closing ceremony']) {
      assert(intentOf(said) === 'close', `"${said}" was read as ${intentOf(said)}`);
    }
    for (const said of ['park it', 'please stop here', 'stand down for now']) {
      assert(intentOf(said) === 'park', `"${said}" was read as ${intentOf(said)}`);
    }
    for (const said of ["don't close yet", 'do not wrap it up yet', 'carry on with the retry budget', '']) {
      assert(intentOf(said) === 'resume', `"${said}" was read as ${intentOf(said)}`);
    }
    // The clause is the sentence: a negation in an earlier one does not cancel it.
    assert(intentOf("don't touch the config. close the session") === 'close', 'a negation leaked across a sentence boundary');
    return 'close, park, resume, negations';
  });

  // ---------------------------------------------------------------- the host surface
  await checkAsync('setup registers the prompt hook, both tool hooks, idle, and the event loop', async () => {
    const f = fixture();
    const cleanup = await plugin.setup(f.ctx);

    for (const name of ['session.prompt', 'session.experimental.idle', 'tool.execute.before', 'tool.execute.after']) {
      assert(f.hook(name), `${name} was not registered`);
    }
    assert(f.calls.subscribe === 1, `the event loop was subscribed ${f.calls.subscribe} time(s)`);
    assert(typeof cleanup === 'function', 'setup returned no cleanup');
    cleanup();
    f.shut();
    return 'four hooks, one subscription, one cleanup';
  });

  // ---------------------------------------------------------------- the prompt
  await checkAsync('a close prompt appends the intent block and records it per session', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    const prompt = f.hook('session.prompt');

    const event = { sessionID: 'ses_a', prompt: { text: 'ok, wrap it up' } };
    await prompt(event);
    assert(event.prompt.text.startsWith('ok, wrap it up'), 'the owner’s own words were rewritten');
    assert(/CLOSE INTENT/.test(event.prompt.text), `no close intent was appended:\n${event.prompt.text}`);
    assert(/stack_close op=run/.test(event.prompt.text), 'the intent block does not name the command');

    const intents = intentsOf(f.dir);
    assert(Object.keys(intents).length === 1, `the intent was not keyed per session: ${JSON.stringify(intents)}`);
    assert(intents.ses_a && intents.ses_a.attempts === 0, `the intent entry is wrong: ${JSON.stringify(intents)}`);

    // A second pass over the already-annotated text must not stack a second block.
    await prompt(event);
    assert((event.prompt.text.match(/CLOSE INTENT\./g) || []).length === 1, 'the intent block was appended twice');
    f.shut();
    return 'one block, one entry';
  });

  await checkAsync('two sessions in one project keep their own intent', async () => {
    const f = fixture({ titles: { ses_a: 'alpha', ses_b: 'beta' } });
    await plugin.setup(f.ctx);
    const prompt = f.hook('session.prompt');

    await prompt({ sessionID: 'ses_a', prompt: { text: 'close the session' } });
    await prompt({ sessionID: 'ses_b', prompt: { text: 'carry on with the store' } });
    assert(fs.existsSync(intentFile(f.dir)), 'a normal prompt in another session erased the open intent');
    assert(intentsOf(f.dir).ses_a, 'the first session lost its close intent');
    assert(!intentsOf(f.dir).ses_b, 'a resume recorded an intent for the second session');

    await prompt({ sessionID: 'ses_b', prompt: { text: 'wrap this up' } });
    const both = intentsOf(f.dir);
    assert(Object.keys(both).sort().join(',') === 'ses_a,ses_b', `both sessions are not recorded: ${JSON.stringify(both)}`);

    // The loop advances only the session it was called for.
    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    const after = intentsOf(f.dir);
    assert(after.ses_a.attempts === 1, `the idle gate did not advance ses_a: ${JSON.stringify(after.ses_a)}`);
    assert(after.ses_b.attempts === 0, `the idle gate advanced the other session: ${JSON.stringify(after.ses_b)}`);
    f.shut();
    return 'two intents, two counters';
  });

  // ---------------------------------------------------------------- the rename gate
  await checkAsync('[done] is refused with or without a receipt, and a receipt never promotes a rename', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    const before = f.hook('tool.execute.before');
    const REFUSED = /\[done\]/;

    await throws(
      () => before({ tool: 'session_rename', sessionID: 'ses_a', input: { title: '[done] retry budget' } }),
      REFUSED,
      'a [done] rename with no receipt was allowed',
    );

    // The receipt is half the seal and the sealed report is the other half, so a
    // valid GO does not license the type: only the idle gate writes [done].
    writeReceipt(f.dir);
    const typed = { title: '[done] retry budget' };
    const message = await throws(
      () => before({ tool: 'session_rename', sessionID: 'ses_a', input: typed }),
      REFUSED,
      'a [done] rename with a valid receipt was allowed',
    );
    assert(typed.title === '[done] retry budget', `a refused rename was rewritten to ${typed.title}`);
    assert(!isDone(f.titleOf('ses_a')), `a refused rename wrote the host title: ${f.titleOf('ses_a')}`);

    // Every other rename under a GO is normalised to active, never to done.
    const parked = { title: '[parked] retry budget' };
    await before({ tool: 'session_rename', sessionID: 'ses_a', input: parked });
    assert(parked.title === '[active] retry budget', `a GO receipt outranked a non-done rename: ${parked.title}`);
    assert(!isDone(parked.title), `a rename was normalised to done: ${parked.title}`);
    assert(!f.calls.update.length, `the gate wrote a title instead of rewriting the input: ${JSON.stringify(f.calls.update)}`);
    f.shut();
    return message;
  });

  await checkAsync('a foreign [done] rename event is parked, and the plugin own done write survives its echo', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    writeReceipt(f.dir);

    // Any other surface can rename: the event carries a claim, never an author.
    // With a valid receipt the old code promoted it to [done] - it must be parked.
    f.emit({ type: 'session.renamed', data: { sessionID: 'ses_a', title: '[done] retry budget' } });
    await f.until(() => f.titleOf('ses_a') === '[parked] retry budget', 'a foreign [done] event stood with a valid receipt');

    // The idle path is the one writer: [done] after the sealed report. The host
    // echoes that exact title back, and the plugin must not undo its own write.
    writeIntent(f.dir, 'ses_a', 1);
    f.messages.push(
      { type: 'user', content: [{ type: 'text', text: 'close the session' }] },
      {
        type: 'assistant',
        content: [
          {
            type: 'text',
            text: `## Outcome\nThe close is sealed.\n\n## Evidence\nnode -e "process.exit(0)" exited 0.\n\nSEALED ${head(f.dir).slice(0, 7)}`,
          },
        ],
      },
    );
    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.titleOf('ses_a') === '[done] retry budget', `the sealed report did not write [done]: ${f.titleOf('ses_a')}`);

    const written = f.titleOf('ses_a');
    f.emit({ type: 'session.renamed', data: { sessionID: 'ses_a', title: written } });
    // A new turn follows the echo, so the check can prove the echo produced no
    // rewrite of its own: exactly three writes - the foreign event's parked,
    // the seal's [done], then the turn's [active] - and never a parked between.
    f.emit({ type: 'session.execution.started', data: { sessionID: 'ses_a' } });
    await f.until(() => f.titleOf('ses_a') === '[active] retry budget', 'the turn after the echo did not run');

    const titles = f.calls.update.map((u) => u.title);
    assert(
      titles.length === 3 && titles[1] === '[done] retry budget' && titles[2] === '[active] retry budget',
      `the plugin's own [done] echo was rewritten: ${JSON.stringify(titles)}`,
    );
    f.shut();
    return 'foreign parked, own echo kept';
  });

  // ---------------------------------------------------------------- the idle loop
  await checkAsync('idle with an open intent and no receipt names the blockers and counts the attempt', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    // Dirty outside .stack: one ticket the close cannot settle by itself.
    fs.writeFileSync(path.join(f.dir, 'loose.ts'), 'export const loose = 1;\n');
    writeIntent(f.dir, 'ses_a');

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.calls.synthetic.length === 1, `the gate injected ${f.calls.synthetic.length} message(s)`);
    const text = f.calls.synthetic[0].text;
    assert(/Close is blocked on \d+ ticket\(s\)/.test(text), `the blockers were not restated:\n${text}`);
    assert(/loose\.ts/.test(text), `the blocking path was not named:\n${text}`);
    assert(/Do not reply done/.test(text), `the nudge does not forbid the word done:\n${text}`);
    assert(intentsOf(f.dir).ses_a.attempts === 1, `the attempt was not counted: ${JSON.stringify(intentsOf(f.dir))}`);
    assert(!/\[done\]/.test(f.titleOf('ses_a')), 'the gate set [done] without a receipt');
    f.shut();
    return 'blockers restated, attempt 1';
  });

  await checkAsync('idle with a clear preflight tells the session to run the close', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    writeIntent(f.dir, 'ses_a');

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.calls.synthetic.length === 1, `the gate injected ${f.calls.synthetic.length} message(s)`);
    const text = f.calls.synthetic[0].text;
    assert(/Preflight is clear/.test(text), `the clear preflight was not stated:\n${text}`);
    assert(/stack_close op=run/.test(text), `the next command was not named:\n${text}`);
    assert(intentsOf(f.dir).ses_a.attempts === 1, 'the attempt was not counted');
    f.shut();
    return 'the one command that seals';
  });

  await checkAsync('idle with a valid receipt but no close intent parks the session, never [done]', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    writeReceipt(f.dir);

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.titleOf('ses_a') === '[parked] retry budget', `a receipt with no intent ended ${f.titleOf('ses_a')}`);
    assert(!isDone(f.titleOf('ses_a')), 'an ordinary idle with a receipt wrote [done]');
    assert(!f.calls.synthetic.length, `the at-rest transition nudged the session (${f.calls.synthetic.length} message(s))`);
    const last = f.calls.update[f.calls.update.length - 1];
    assert(last && last.title === '[parked] retry budget', `the written title was ${JSON.stringify(f.calls.update)}`);
    f.shut();
    return 'parked, no nudge';
  });

  await checkAsync('a valid receipt, the seal token, and both report headings set [done] and clear the intent', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    writeReceipt(f.dir);
    writeIntent(f.dir, 'ses_a', 2);
    const token = `SEALED ${head(f.dir).slice(0, 7)}`;

    // The host projects messages as {type, content:[{type:'text',text}]}. A reader
    // that looks for `role` sees nothing here and nudges to the cap instead.
    // The seal is the token inside the brief report, so the fixture carries the
    // two mandatory headings rather than a bare line.
    f.messages.push(
      { type: 'user', content: [{ type: 'text', text: 'close the session' }] },
      {
        type: 'assistant',
        content: [
          {
            type: 'text',
            text: `## Outcome\nThe retry budget backs off on a 429.\n\n## Evidence\nnode -e "process.exit(0)" exited 0.\n\n${token}`,
          },
        ],
      },
    );

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.titleOf('ses_a') === '[done] retry budget', `the title is ${f.titleOf('ses_a')}, not [done]`);
    assert(!fs.existsSync(intentFile(f.dir)), 'the intent was not cleared after the seal');
    assert(!f.calls.synthetic.length, 'the gate nudged a session that already reported');
    f.shut();
    return token;
  });

  await checkAsync('the [done] seal survives the idle that follows the compaction', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    writeReceipt(f.dir);
    writeIntent(f.dir, 'ses_a', 1);
    const token = `SEALED ${head(f.dir).slice(0, 7)}`;

    f.messages.push(
      { type: 'user', content: [{ type: 'text', text: 'close the session' }] },
      {
        type: 'assistant',
        content: [
          {
            type: 'text',
            text: `## Outcome\nThe retry budget is sealed.\n\n## Evidence\nnode -e "process.exit(0)" exited 0.\n\n${token}`,
          },
        ],
      },
    );

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.titleOf('ses_a') === '[done] retry budget', `the sealed report did not write [done]: ${f.titleOf('ses_a')}`);
    // The digest is the compaction: the sealed report asks the host for one real
    // compaction, before the title says done, and exactly one - the report is the
    // last thing the session says, so a second pass would summarise nothing.
    assert(f.calls.compact.length === 1, `the seal fired ${f.calls.compact.length} compaction(s), not one`);
    assert(f.calls.compact[0].sessionID === 'ses_a', `the compaction was for ${JSON.stringify(f.calls.compact[0])}`);
    assert(
      f.calls.log.join(',') === 'compact,update',
      `the [done] write did not follow one compaction: ${f.calls.log.join(',')}`,
    );

    // The host then runs an idle of its own with no close intent left. The seal
    // therefore has to be durable: without a [done] override the at-rest
    // transition parks the session the plugin has just sealed.
    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(
      f.titleOf('ses_a') === '[done] retry budget',
      `the idle after the seal regressed the title to ${JSON.stringify(f.titleOf('ses_a'))}`,
    );
    assert(f.calls.compact.length === 1, `the idle after the seal fired ${f.calls.compact.length} compaction(s)`);
    assert(!f.calls.synthetic.length, 'the idle after the seal nudged the session');
    f.shut();
    return 'one compaction, then [done] held';
  });

  await checkAsync('a compaction that throws still seals the session', async () => {
    const f = fixture({ compactError: new Error('the host refused to compact') });
    await plugin.setup(f.ctx);
    writeReceipt(f.dir);
    writeIntent(f.dir, 'ses_a', 1);
    const token = `SEALED ${head(f.dir).slice(0, 7)}`;
    f.messages.push(
      { type: 'user', content: [{ type: 'text', text: 'close the session' }] },
      {
        type: 'assistant',
        content: [
          {
            type: 'text',
            text: `## Outcome\nThe retry budget is sealed.\n\n## Evidence\nnode -e "process.exit(0)" exited 0.\n\n${token}`,
          },
        ],
      },
    );

    let escaped = null;
    try {
      await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    } catch (err) {
      escaped = err;
    }
    // A closed session whose memory could not be summarised is still closed: the
    // seal is the receipt and the report, and the compaction is not a gate.
    assert(!escaped, `a failed compaction escaped the idle gate: ${escaped && escaped.message}`);
    assert(f.calls.compact.length === 1, `the seal fired ${f.calls.compact.length} compaction(s), not one`);
    assert(f.titleOf('ses_a') === '[done] retry budget', `a failed compaction left the title ${JSON.stringify(f.titleOf('ses_a'))}`);
    assert(!fs.existsSync(intentFile(f.dir)), 'a failed compaction left the close intent open');
    assert(!f.calls.synthetic.length, 'a failed compaction nudged the session');
    f.shut();
    return 'seal survives a compaction error';
  });

  await checkAsync('a bare seal token is not a report: the instruction is issued and [done] is withheld', async () => {
    const messages = [
      { type: 'assistant', content: [{ type: 'text', text: `Done.\n\nSEALED ${'0000000'}` }] },
    ];
    const f = fixture({ messages });
    await plugin.setup(f.ctx);
    writeReceipt(f.dir);
    writeIntent(f.dir, 'ses_a', 1);
    const token = `SEALED ${head(f.dir).slice(0, 7)}`;
    // Point the bare-token counter-case at the receipt's own token so only the
    // report shape can decide the outcome.
    messages[0].content[0].text = `Done.\n\n${token}`;

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.calls.synthetic.length === 1, `a bare token produced no report instruction (${f.calls.synthetic.length})`);
    assert(/The receipt is sealed at/.test(f.calls.synthetic[0].text), 'the instruction is not the report one');
    assert(!isDone(f.titleOf('ses_a')), `a bare token was treated as a report: ${f.titleOf('ses_a')}`);
    assert(fs.existsSync(intentFile(f.dir)), 'the intent was cleared without a report');
    f.shut();
    return 'one line is a claim, not a report';
  });

  await checkAsync('a valid receipt without the token injects the report instruction and holds [active]', async () => {
    const messages = [
      { type: 'assistant', content: [{ type: 'text', text: 'I think we are done, no report yet.' }] },
    ];
    const f = fixture({ messages });
    await plugin.setup(f.ctx);
    writeReceipt(f.dir);
    writeIntent(f.dir, 'ses_a', 1);
    const token = `SEALED ${head(f.dir).slice(0, 7)}`;

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.calls.synthetic.length === 1, 'the missing token produced no instruction');
    const text = f.calls.synthetic[0].text;
    assert(/The receipt is sealed at/.test(text), `the report instruction is not the seal one:\n${text}`);
    assert(text.includes(token), `the instruction does not carry the token:\n${text}`);
    assert(/No tools after/.test(text), `the instruction does not end the turn:\n${text}`);
    assert(!isDone(f.titleOf('ses_a')), `[done] was applied without the token: ${f.titleOf('ses_a')}`);
    assert(intentsOf(f.dir).ses_a.attempts === 2, `the attempt was not counted: ${JSON.stringify(intentsOf(f.dir))}`);
    f.shut();
    return 'report instruction, still active';
  });

  await checkAsync('six attempts park the session, record an ASK, and clear the intent', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    writeIntent(f.dir, 'ses_a', 6);

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.titleOf('ses_a') === '[parked] retry budget', `the cap did not park the session: ${f.titleOf('ses_a')}`);
    assert(!isDone(f.titleOf('ses_a')), 'the cap sealed the session [done]');
    assert(!fs.existsSync(intentFile(f.dir)), 'the exhausted intent was left open');
    const ledger = ledgerOf(f.dir);
    assert(/\u00b7 ASK \u00b7/.test(ledger), `no ASK was recorded:\n${ledger}`);
    assert(/close loop exhausted after 6 continuations/.test(ledger), `the ASK does not name the cap:\n${ledger}`);
    return 'parked, ASK, cleared';
  });

  await checkAsync('an empty title is not overwritten with a bare [active]', async () => {
    const f = fixture({ titles: { ses_a: '' } });
    await plugin.setup(f.ctx);
    await f.hook('session.prompt')({ sessionID: 'ses_a', prompt: { text: 'carry on with the retry budget' } });

    assert(!f.calls.update.length, `an empty title was written: ${JSON.stringify(f.calls.update)}`);
    assert(f.titleOf('ses_a') === '', `the host title was replaced with ${JSON.stringify(f.titleOf('ses_a'))}`);

    // The same gate does write once the host has named the session.
    f.records.get('ses_a').title = 'retry budget';
    await f.hook('session.prompt')({ sessionID: 'ses_a', prompt: { text: 'carry on with the retry budget' } });
    assert(f.titleOf('ses_a') === '[active] retry budget', `a named session was not prefixed: ${f.titleOf('ses_a')}`);
    f.shut();
    return 'deferred to the host title';
  });

  // ---------------------------------------------------------------- the close tool arms the loop
  //
  // The run that seals writes the receipt and a one-shot marker naming it; the
  // execute.after event for that same call consumes the marker and opens the
  // close intent, so the turn still owes its report and the idle gate seals it
  // with no typed phrase. Only a marker that names the receipt in hand and is
  // fresh can arm: a stale GO, and one that `show`, `preflight` or a refused
  // `run` never earned, must leave the session exactly as it was. The fixture
  // runs the real tool, because the arming gate reads what that run wrote.
  const seal = async (d, lesson = 'the close arms its own intent in the tool') => {
    const out = await runIn(d, 'close', { op: 'run', lesson });
    assert(/## GO/.test(out), `the fixture close did not seal:\n${out}`);
    return out;
  };
  const goReceipt = (d) => JSON.parse(fs.readFileSync(path.join(d, RECEIPT), 'utf8'));
  const armMarker = (d, patch = {}) => {
    const receipt = goReceipt(d);
    fs.mkdirSync(path.join(d, '.stack', 'state'), { recursive: true });
    const marker = { receipt_id: receipt.receipt_id, head: receipt.head, at: new Date().toISOString(), ...patch };
    fs.writeFileSync(path.join(d, ARMED), JSON.stringify(marker));
    return marker;
  };
  const reportMessage = (token) => ({
    type: 'assistant',
    content: [
      {
        type: 'text',
        text: `## Outcome\nThe retry budget is sealed.\n\n## Evidence\nnode -e "process.exit(0)" exited 0.\n\n${token}`,
      },
    ],
  });

  await checkAsync('a GO close arms its own intent, and the idle seals from that intent alone', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);
    assert(!fs.existsSync(intentFile(f.dir)), 'the close wrote an intent before the after event');
    assert(fs.existsSync(path.join(f.dir, ARMED)), 'the sealed close wrote no arming marker');
    const token = `SEALED ${head(f.dir).slice(0, 7)}`;
    f.messages.push(
      { type: 'user', content: [{ type: 'text', text: 'close the session' }] },
      reportMessage(token),
    );

    await f.hook('tool.execute.after')({ tool: 'stack_close', sessionID: 'ses_a', status: 'completed', result: {} });
    const armed = intentsOf(f.dir);
    assert(armed.ses_a, `a GO close armed no intent: ${JSON.stringify(armed)}`);
    assert(armed.ses_a.attempts === 0, `the armed intent did not start at zero: ${JSON.stringify(armed.ses_a)}`);
    assert(!fs.existsSync(path.join(f.dir, ARMED)), 'the arming marker was not consumed: a later show would arm on this GO');

    // No hand-written intent anywhere: the idle reads only what the tool wrote.
    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.titleOf('ses_a') === '[done] retry budget', `the armed intent did not seal: ${f.titleOf('ses_a')}`);
    assert(f.calls.compact.length === 1, `the armed seal fired ${f.calls.compact.length} compaction(s), not one`);
    assert(!fs.existsSync(intentFile(f.dir)), 'the sealed intent was left open');
    assert(!f.calls.synthetic.length, `the armed chain nudged the session ${f.calls.synthetic.length} time(s)`);
    f.shut();
    return 'GO close armed, one compaction, [done]';
  });

  // The fallback CLI is one invocation, not a tool call: `node bin/stack.js close
  // run` seals and no tool.execute.after ever follows it. The record is then the
  // whole proof, so the idle gate must consume it as the tool path would.
  await checkAsync('a CLI close arms the idle with no after hook, and the report closes it once', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);
    assert(fs.existsSync(path.join(f.dir, ARMED)), 'the sealed close wrote no arm record');
    assert(!fs.existsSync(intentFile(f.dir)), 'the close wrote an intent before any idle');
    f.messages.push(reportMessage(`SEALED ${head(f.dir).slice(0, 7)}`));

    // No after event: the CLI wrote the record and its process ended.
    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.titleOf('ses_a') === '[done] retry budget', `the record did not arm the seal: ${f.titleOf('ses_a')}`);
    assert(f.calls.compact.length === 1, `the CLI seal fired ${f.calls.compact.length} compaction(s), not one`);
    assert(!fs.existsSync(intentFile(f.dir)), 'the sealed intent was left open');
    assert(!fs.existsSync(path.join(f.dir, ARMED)), 'the one-shot record survived the idle: a later idle would arm again');
    assert(!f.calls.synthetic.length, `the CLI seal nudged the session ${f.calls.synthetic.length} time(s)`);

    // The record is gone, so the idle after the seal has nothing to arm and
    // nothing left to summarise.
    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(f.calls.compact.length === 1, `the idle after the seal fired ${f.calls.compact.length} compaction(s)`);
    assert(
      f.titleOf('ses_a') === '[done] retry budget',
      `the idle after the seal regressed the title to ${JSON.stringify(f.titleOf('ses_a'))}`,
    );
    f.shut();
    return 'one run, one idle, one compaction, [done]';
  });

  // A record is proof a run happened, not a licence: only one that names the
  // receipt in hand, at this HEAD, inside the window may arm. Each failure below
  // must leave the session exactly as an idle with only a receipt leaves it.
  await checkAsync('an arm record naming another receipt arms nothing at idle', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);
    armMarker(f.dir, { receipt_id: crypto.randomUUID() });
    f.messages.push(reportMessage(`SEALED ${head(f.dir).slice(0, 7)}`));

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(!fs.existsSync(intentFile(f.dir)), `a foreign record armed an intent: ${JSON.stringify(intentsOf(f.dir))}`);
    assert(!isDone(f.titleOf('ses_a')), `a foreign record sealed the session: ${f.titleOf('ses_a')}`);
    assert(!f.calls.compact.length, `a foreign record fired ${f.calls.compact.length} compaction(s)`);
    assert(
      f.titleOf('ses_a') === '[parked] retry budget',
      `the idle did not behave as before the change: ${JSON.stringify(f.titleOf('ses_a'))}`,
    );
    f.shut();
    return 'receipt_id mismatch, nothing armed';
  });

  await checkAsync('an arm record ten minutes old arms nothing at idle', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);
    armMarker(f.dir, { at: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    f.messages.push(reportMessage(`SEALED ${head(f.dir).slice(0, 7)}`));

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(!fs.existsSync(intentFile(f.dir)), `a stale record armed an intent: ${JSON.stringify(intentsOf(f.dir))}`);
    assert(!isDone(f.titleOf('ses_a')), `a stale record sealed the session: ${f.titleOf('ses_a')}`);
    assert(!f.calls.compact.length, `a stale record fired ${f.calls.compact.length} compaction(s)`);
    f.shut();
    return 'ten minutes old, nothing armed';
  });

  await checkAsync('an arm record with no receipt arms nothing at idle', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    // The shape a run writes, with nothing sealed behind it: no receipt on disk.
    fs.mkdirSync(path.join(f.dir, '.stack', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(f.dir, ARMED),
      JSON.stringify({ receipt_id: crypto.randomUUID(), head: head(f.dir), at: new Date().toISOString() }),
    );
    f.messages.push(reportMessage(`SEALED ${head(f.dir).slice(0, 7)}`));

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(!fs.existsSync(intentFile(f.dir)), `a record with no receipt armed an intent: ${JSON.stringify(intentsOf(f.dir))}`);
    assert(!isDone(f.titleOf('ses_a')), `a record with no receipt sealed the session: ${f.titleOf('ses_a')}`);
    assert(!f.calls.compact.length, `a record with no receipt fired ${f.calls.compact.length} compaction(s)`);
    f.shut();
    return 'no receipt, nothing armed';
  });

  await checkAsync('a signed receipt edited after signing is refused by its signature', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    writeReceipt(f.dir);
    // One byte in the body, after the signature was written: the lesson's last
    // character. The shape is untouched, so only the signature can catch it.
    const file = path.join(f.dir, RECEIPT);
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    const lesson = receipt.lesson;
    receipt.lesson = `${lesson.slice(0, -1)}${lesson.endsWith('x') ? 'y' : 'x'}`;
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2));

    const shown = await runIn(f.dir, 'close', { op: 'show' });
    assert(/## NO-GO/.test(shown), `a tampered receipt still read as a GO:\n${shown}`);
    assert(/no valid signature/.test(shown), `the refusal does not name the signature:\n${shown}`);
    assert(/does not match/.test(shown), `the refusal does not say why the signature fails:\n${shown}`);

    // And it cannot seal: an open intent plus a report is not enough when the
    // receipt the report names is no longer evidence.
    writeIntent(f.dir, 'ses_a', 1);
    f.messages.push(reportMessage(`SEALED ${head(f.dir).slice(0, 7)}`));
    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(!isDone(f.titleOf('ses_a')), `a tampered receipt sealed the session: ${f.titleOf('ses_a')}`);
    assert(fs.existsSync(intentFile(f.dir)), 'a tampered receipt cleared the close intent');
    f.shut();
    return 'one byte changed, the signature refuses';
  });

  await checkAsync('a NO-GO close arms nothing and the idle does not seal', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    // One path outside .stack: the ceremony refuses before it writes a receipt.
    fs.writeFileSync(path.join(f.dir, 'loose.ts'), 'export const loose = 1;\n');
    const out = await runIn(f.dir, 'close', { op: 'run', lesson: 'a refused close arms nothing at all' });
    assert(/## NO-GO/.test(out), `the fixture close did not refuse:\n${out}`);
    f.messages.push(reportMessage(`SEALED ${head(f.dir).slice(0, 7)}`));

    await f.hook('tool.execute.after')({ tool: 'stack_close', sessionID: 'ses_a', status: 'completed', result: {} });
    assert(!fs.existsSync(intentFile(f.dir)), `a NO-GO close armed an intent: ${JSON.stringify(intentsOf(f.dir))}`);

    await f.hook('session.experimental.idle')({ sessionID: 'ses_a' });
    assert(!isDone(f.titleOf('ses_a')), `a NO-GO close was sealed: ${f.titleOf('ses_a')}`);
    assert(f.titleOf('ses_a') === '[parked] retry budget', `the unarmed idle ended ${JSON.stringify(f.titleOf('ses_a'))}`);
    assert(!f.calls.compact.length, `a NO-GO close fired ${f.calls.compact.length} compaction(s)`);
    assert(!f.calls.synthetic.length, `a NO-GO close was chased: ${f.calls.synthetic.length} message(s)`);
    f.shut();
    return 'NO-GO close, no intent, no seal';
  });

  // The marker is the one-shot proof this turn ran the close. A GO receipt alone
  // is not: `op=show`, `op=preflight`, and a `run` refused before writing anything
  // can all stand beside a receipt an earlier run produced, and none of them owe
  // a report. So the cases below hold a genuine GO at HEAD and a marker that
  // cannot be honoured, and every one of them must arm nothing.

  await checkAsync('a GO receipt with no arming marker arms nothing', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);
    fs.rmSync(path.join(f.dir, ARMED), { force: true });
    const receipt = goReceipt(f.dir);
    assert(
      receipt.go === true && receipt.head === head(f.dir),
      `the fixture receipt is not a GO at HEAD: ${JSON.stringify(receipt)}`,
    );

    await f.hook('tool.execute.after')({ tool: 'stack_close', sessionID: 'ses_a', status: 'completed', result: {} });
    assert(!fs.existsSync(intentFile(f.dir)), `a GO with no marker armed an intent: ${JSON.stringify(intentsOf(f.dir))}`);
    f.shut();
    return 'GO without a marker, nothing armed';
  });

  await checkAsync('a marker naming another receipt arms nothing', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);
    armMarker(f.dir, { receipt_id: 'a-receipt-from-another-run' });

    await f.hook('tool.execute.after')({ tool: 'stack_close', sessionID: 'ses_a', status: 'completed', result: {} });
    assert(!fs.existsSync(intentFile(f.dir)), `a foreign marker armed an intent: ${JSON.stringify(intentsOf(f.dir))}`);
    f.shut();
    return 'receipt_id mismatch, nothing armed';
  });

  await checkAsync('a marker older than the window arms nothing', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);
    armMarker(f.dir, { at: new Date(Date.now() - 10 * 60 * 1000).toISOString() });

    await f.hook('tool.execute.after')({ tool: 'stack_close', sessionID: 'ses_a', status: 'completed', result: {} });
    assert(!fs.existsSync(intentFile(f.dir)), `a stale marker armed an intent: ${JSON.stringify(intentsOf(f.dir))}`);
    f.shut();
    return 'ten minutes old, nothing armed';
  });

  await checkAsync('a marker that is not JSON arms nothing and does not throw', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);
    fs.writeFileSync(path.join(f.dir, ARMED), '{not json');

    await f.hook('tool.execute.after')({ tool: 'stack_close', sessionID: 'ses_a', status: 'completed', result: {} });
    assert(!fs.existsSync(intentFile(f.dir)), `an unreadable marker armed an intent: ${JSON.stringify(intentsOf(f.dir))}`);
    assert(f.titleOf('ses_a') === '[active] retry budget', `the hook did not finish after a bad marker: ${f.titleOf('ses_a')}`);
    f.shut();
    return 'bad marker ignored, hook completed';
  });

  await checkAsync('a close never resets an intent that is already counting', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);
    writeIntent(f.dir, 'ses_a', 3);

    await f.hook('tool.execute.after')({ tool: 'stack_close', sessionID: 'ses_a', status: 'completed', result: {} });
    assert(intentsOf(f.dir).ses_a.attempts === 3, `the first close reset the loop: ${JSON.stringify(intentsOf(f.dir))}`);
    await f.hook('tool.execute.after')({ tool: 'stack_close', sessionID: 'ses_a', status: 'completed', result: {} });
    assert(intentsOf(f.dir).ses_a.attempts === 3, `a second close reset the loop: ${JSON.stringify(intentsOf(f.dir))}`);
    f.shut();
    return 'two closes, attempts held at 3';
  });

  // The host prefixes a tool with its namespace using whatever separator the
  // surface chose, so the same close arrives as `stack_close`, `stack.close`, or
  // `oc.stack.close`. All of them are this plugin's close and must arm; a foreign
  // `other.close` merely sharing the last segment must not.

  await checkAsync('the dot form of the close tool arms the intent', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);

    await f.hook('tool.execute.after')({ tool: 'stack.close', sessionID: 'ses_a', status: 'completed', result: {} });
    const armed = intentsOf(f.dir);
    assert(armed.ses_a, `the dot form armed no intent: ${JSON.stringify(armed)}`);
    assert(armed.ses_a.attempts === 0, `the armed intent did not start at zero: ${JSON.stringify(armed.ses_a)}`);
    f.shut();
    return 'stack.close armed';
  });

  await checkAsync('a namespaced close arms the intent', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);

    await f.hook('tool.execute.after')({ tool: 'oc.stack.close', sessionID: 'ses_a', status: 'completed', result: {} });
    const armed = intentsOf(f.dir);
    assert(armed.ses_a, `a namespaced close armed no intent: ${JSON.stringify(armed)}`);
    assert(armed.ses_a.attempts === 0, `the armed intent did not start at zero: ${JSON.stringify(armed.ses_a)}`);
    f.shut();
    return 'oc.stack.close armed';
  });

  await checkAsync('a foreign tool whose last segment matches arms nothing', async () => {
    const f = fixture();
    await plugin.setup(f.ctx);
    await seal(f.dir);

    for (const tool of ['other.close', 'foo.close', 'other_ready']) {
      await f.hook('tool.execute.after')({ tool, sessionID: 'ses_a', status: 'completed', result: {} });
      assert(!fs.existsSync(intentFile(f.dir)), `${tool} armed an intent: ${JSON.stringify(intentsOf(f.dir))}`);
    }
    assert(
      f.titleOf('ses_a') === 'retry budget' && !f.calls.update.length,
      `a foreign tool was handled as ours: ${JSON.stringify(f.calls.update)}`,
    );
    f.shut();
    return 'other.close, foo.close, other_ready ignored';
  });
}
