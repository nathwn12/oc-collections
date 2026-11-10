/**
 * Self-routing: the prompt is scored locally against the seat cards, and the
 * ask is classified, before the model acts.
 *
 * The numbers here are the contract: the held-out accuracy floor, the 5 ms
 * routing target, one directory read per session, microseconds for the ask,
 * and the instruction entries the prompt hook writes. Every case runs against
 * the shipped `roles/` directory unless the case is about a fixture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import plugin from '../../index.js';
import { cacheStats, classifyAsk, loadCards, route } from '../../lib/router.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROLE_DIR = path.resolve(here, '..', '..', 'roles');

// The plugin reads this at call time; a fixture repo must not be seeded.
process.env.OC_STACKED_NO_SEED = '1';

/** Twenty prompts written against the tasks, not the card text. */
const HELD_OUT = [
  ['Add a POST /orders endpoint, idempotent on the client key, and return 409 when the same key is replayed', 'backend', 'engineering'],
  ['The users list still renders stale rows after I delete one - fix the component state', 'frontend', 'engineering'],
  ['Write the regression that fails on a null token before we fix it', 'tester', 'engineering'],
  ['Our orders table has duplicate rows from the backfill; write the query that proves zero duplicates', 'data-engineer', 'engineering'],
  ['What was the average order value last quarter, and which table did that number come from?', 'data-analyst', 'knowledge'],
  ['Draft the changelog entry and update the README for the new flag', 'docs', 'knowledge'],
  ['Turn the deployment runbook into numbered steps a stranger can follow from a clean box', 'technical-writer', 'knowledge'],
  ['The linux runner fails at the release stage; reproduce it locally before CI sees it', 'devops', 'platform'],
  ['p99 latency doubled under load: where is the timeout and what fires when it trips?', 'sre', 'platform'],
  ['Tag v2.4.0 and confirm every seam has a GO at that commit, with a rollback plan', 'release-manager', 'platform'],
  ['Someone can read another tenant file by guessing the id - probe it and give me severity', 'security', 'quality'],
  ['Review this diff against the brief, then rerun the check with the fix reverted', 'reviewer', 'quality'],
  ['Try three inputs the author would not think of against the built artifact', 'qa', 'quality'],
  ['Verify the claim about the retry limit against the pinned source, and quote the line that settles it', 'fact-checker', 'research'],
  ['Find the upstream API that changed in 4.2 and cite the line at the pinned version', 'researcher', 'research'],
  ['Write the product spec for the new onboarding flow, with acceptance checks', 'product-manager', 'product'],
  ['Sequence these five tickets across two weeks and tell me what slips first', 'project-manager', 'product'],
  ['Design the empty state and the longest-string layout for the list screen', 'ui-designer', 'design'],
  ['Record what users actually do when search returns nothing, before we interpret it', 'ux-researcher', 'design'],
  ['Render the built settings screen and flag every spacing deviation', 'design-reviewer', 'design'],
];

/** Fifteen sentences: three per kind, written as an owner would type them. */
const ASKS = [
  ['command', 'Fix the flaky upload test before you touch anything else.'],
  ['command', 'Rename the column and ship it tonight.'],
  ['command', 'Delete the dead flag now.'],
  ['objective', 'Do not stop until the suite is green and the report is written.'],
  ['objective', 'The final is the sealed receipt at the head you hand back.'],
  ['objective', 'No more probing; by the end of the day I want the answer.'],
  ['goal', 'Cut the bundle so that it lands under 200 kB.'],
  ['goal', 'Reach 30 ms p95 by Friday.'],
  ['goal', 'Keep the retry budget under 5 s per request.'],
  ['intent', 'I want the router to stop guessing on short prompts.'],
  ['intent', 'I need a way to see which seat would handle this.'],
  ['intent', "I'd like the check to fail loudly when a card is malformed."],
  ['idea', 'What if the router scored departments instead of cards?'],
  ['idea', 'Maybe the seats should be able to hand work back to the lead?'],
  ['idea', 'How about we cache the index in the plugin storage?'],
];

const CARD = (name, department, seat, owns) =>
  `---\nname: ${name}\ndepartment: ${department}\nseat: ${seat}\nproof: the ${name.toLowerCase()} proof, run at the head handed back\n---\n\n## Owns\n\n${owns}\n\n## Must not\n\n- Skip the proof.\n`;

function fixtureDir(cards) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-routing-'));
  for (const [id, body] of Object.entries(cards)) fs.writeFileSync(path.join(dir, `${id}.md`), body);
  return dir;
}

const median = (times) => times[Math.floor(times.length / 2)];
const percentile = (times, at) => times[Math.min(times.length - 1, Math.floor(times.length * at))];
const ASK_COMMAND =
  'Restate this in one sharpened line (scope, proof, out of scope) and then do it. Do not restate the plan.';

export async function register(ctx) {
  const { check, checkAsync, assert } = ctx;

  // ------------------------------------------------------------------ cards

  check('the shipped cards load: 22 of them, none skipped', () => {
    const cards = loadCards(ROLE_DIR);
    assert(cards.length >= 20, `only ${cards.length} cards loaded from ${ROLE_DIR}`);
    assert(cards.skipped.length === 0, `skipped: ${cards.skipped.map((c) => `${c.id} (${c.reason})`).join(', ')}`);
    for (const card of cards) {
      for (const key of ['id', 'name', 'department', 'seat', 'proof', 'text']) {
        assert(typeof card[key] === 'string' && card[key].length, `${card.id} is missing ${key}`);
      }
    }
    return `${cards.length} cards, ${cards.skipped.length} skipped`;
  });

  check('card routing: at least 16/20 held-out prompts, and none in the wrong department', () => {
    const cards = loadCards(ROLE_DIR);
    let correct = 0;
    let unrouted = 0;
    const wrong = [];
    for (const [prompt, seat, department] of HELD_OUT) {
      const routed = route(prompt, cards);
      if (!routed) {
        unrouted += 1;
        continue;
      }
      if (routed.cards[0] === seat) correct += 1;
      if (routed.department !== department) wrong.push(`${routed.cards[0]} for "${prompt.slice(0, 40)}" (want ${department})`);
    }
    assert(correct >= 16, `only ${correct}/20 correct`);
    assert(wrong.length === 0, `wrong department: ${wrong.join('; ')}`);
    return `${correct}/20 correct, ${unrouted} stated misses, 0 wrong department`;
  });

  check('route() finishes in well under 5 ms for 22 cards', () => {
    const cards = loadCards(ROLE_DIR);
    const prompt = 'The orders endpoint returns 500 when the client retries with the same key; reproduce and fix';
    const times = [];
    for (let i = 0; i < 2050; i += 1) {
      const started = process.hrtime.bigint();
      route(prompt, cards);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (i >= 50) times.push(ms); // the first calls carry the JIT, not the work
    }
    times.sort((a, b) => a - b);
    assert(percentile(times, 0.95) < 5, `p95 ${percentile(times, 0.95).toFixed(3)} ms is not under 5 ms`);
    assert(times[times.length - 1] < 5, `worst ${times[times.length - 1].toFixed(3)} ms is not under 5 ms`);
    return `p50 ${median(times).toFixed(3)} ms, p95 ${percentile(times, 0.95).toFixed(3)} ms, max ${times[times.length - 1].toFixed(3)} ms over ${times.length} calls`;
  });

  check('loadCards reads the directory once across 100 calls', () => {
    const first = loadCards(ROLE_DIR);
    const before = cacheStats();
    for (let i = 0; i < 100; i += 1) {
      assert(loadCards(ROLE_DIR) === first, `call ${i} returned a different array`);
    }
    const after = cacheStats();
    assert(after.reads === before.reads, `${after.reads - before.reads} extra directory read(s) across 100 calls`);
    assert(after.hits - before.hits === 100, `expected 100 hits, got ${after.hits - before.hits}`);
    return `${after.reads} read total, ${after.hits - before.hits} hits, same array`;
  });

  check('a card written at runtime is routable with no code change', () => {
    const dir = fixtureDir({
      backend: CARD('Backend Engineer', 'engineering', 'employee', '- The endpoint, its status codes and its auth.'),
      docs: CARD('Docs', 'knowledge', 'employee', '- The changelog entry written for the person upgrading.'),
    });
    try {
      const before = loadCards(dir);
      assert(before.length === 2, `fixture loaded ${before.length} cards`);
      fs.writeFileSync(
        path.join(dir, 'migration-auditor.md'),
        CARD('Migration Auditor', 'data', 'auditor', '- The reverse migration, run by a tired person; the backfill replayed twice.'),
      );
      const after = loadCards(dir);
      assert(after.length === 3, `the new card was not picked up (${after.length} cards)`);
      const routed = route('Write the reverse migration and replay the backfill twice', after);
      assert(routed && routed.cards[0] === 'migration-auditor', `routed to ${routed ? routed.cards[0] : 'null'}`);
      assert(routed.department === 'data', `department ${routed.department}`);
      return 'new card routable on the next load, mtime invalidation included';
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  check('a malformed card is skipped and reported, never thrown', () => {
    const dir = fixtureDir({
      good: CARD('Good Seat', 'quality', 'auditor', '- The check run again with the fix reverted.'),
      bad: '---\nname: Half A Card\nseat: employee\n---\n\nNo department, no proof.\n',
    });
    try {
      const cards = loadCards(dir);
      assert(cards.length === 1 && cards[0].id === 'good', `loaded ${cards.map((c) => c.id).join(',')}`);
      assert(cards.skipped.length === 1 && cards.skipped[0].id === 'bad', 'the bad card was not reported');
      assert(/department/.test(cards.skipped[0].reason), `reason did not name the field: ${cards.skipped[0].reason}`);
      return cards.skipped[0].reason;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  check('an unroutable prompt returns null, not a wrong card', () => {
    const cards = loadCards(ROLE_DIR);
    for (const prompt of ['what do you think about all of this then', 'hmm', 'gibberish words that mean nothing at all here']) {
      const routed = route(prompt, cards);
      assert(routed === null, `"${prompt}" routed to ${routed?.cards?.[0]} at ${routed?.score}`);
    }
    return 'three stated misses, no guessed seat';
  });

  // ------------------------------------------------------------------- asks

  check('classifyAsk: at least 13/15 held-out sentences, with the kind and its tell', () => {
    let correct = 0;
    const missed = [];
    for (const [want, text] of ASKS) {
      const got = classifyAsk(text);
      assert(['idea', 'intent', 'goal', 'objective', 'command'].includes(got.kind), `unknown kind ${got.kind}`);
      assert(typeof got.score === 'number' && typeof got.tell === 'string' && got.tell.length, 'score and tell are required');
      if (got.kind === want) correct += 1;
      else missed.push(`${got.kind} for "${text}"`);
    }
    assert(correct >= 13, `only ${correct}/15 correct: ${missed.join('; ')}`);

    // Precedence, asserted rather than assumed: an objective outranks the wish
    // inside it, and a bare `go` never turns a thought into an order.
    assert(classifyAsk('No more probing; by the end of the day I want the answer.').kind === 'objective', 'a wish outranked an objective');
    assert(classifyAsk('What if we go with the second option?').kind === 'idea', '`go` inside an idea became a command');
    assert(classifyAsk('Refactor the parser.').kind === 'command', 'a bare imperative was not a command');
    return `${correct}/15 correct, precedence held`;
  });

  check('classifyAsk stays under 1 ms at p95', () => {
    const text = 'Fix the flaky upload test before you touch anything else, and do not stop until it is green.';
    const times = [];
    for (let i = 0; i < 20050; i += 1) {
      const started = process.hrtime.bigint();
      classifyAsk(text);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (i >= 50) times.push(ms);
    }
    times.sort((a, b) => a - b);
    assert(percentile(times, 0.95) < 1, `p95 ${percentile(times, 0.95).toFixed(4)} ms is not under 1 ms`);
    // The p95 is the budget. The single worst sample also carries GC and
    // scheduler noise on a loaded host (2.45 ms was seen with --jobs), so it
    // gets a hard 5 ms cap: a real millisecond-scale regression still fails,
    // one outlier does not.
    assert(
      times[times.length - 1] < 5,
      `worst ${times[times.length - 1].toFixed(4)} ms is not under 5 ms (p95 is the budget)`,
    );
    return `p50 ${median(times).toFixed(4)} ms, p95 ${percentile(times, 0.95).toFixed(4)} ms, max ${times[times.length - 1].toFixed(4)} ms over ${times.length} calls`;
  });

  // ------------------------------------------------------------------- hook

  /** A host with exactly the surfaces onPrompt uses, recording every entry. */
  const host = () => {
    const dir = ctx.tmpRepo();
    fs.mkdirSync(path.join(dir, '.stack'), { recursive: true });
    const hooks = new Map();
    const entries = [];
    const records = new Map([['ses_a', { id: 'ses_a', title: 'work', directory: dir }]]);
    const surfaces = {
      location: { directory: dir },
      app: { version: 'test' },
      skill: { transform: async (fn) => fn({ add() {} }) },
      session: {
        hook: async (name, handler) => hooks.set(`session.${name}`, handler),
        get: async ({ sessionID }) => (records.has(sessionID) ? { ...records.get(sessionID) } : null),
        update: async ({ sessionID, title }) => {
          const record = records.get(sessionID);
          if (record) record.title = title;
          return true;
        },
        synthetic: async () => true,
        compact: async () => ({ queued: true }),
        context: async () => ({ data: [] }),
        instructions: {
          entry: {
            put: async (input) => {
              entries.push(input);
            },
            list: async () => entries,
            remove: async () => {},
          },
        },
      },
    };
    return {
      dir,
      setup: () => plugin.setup(surfaces),
      prompt: (text) => hooks.get('session.prompt')({ sessionID: 'ses_a', prompt: { text } }),      entries,
      shut: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  };

  await checkAsync('the prompt hook writes ask, route and proof without a new turn', async () => {
    const f = host();
    try {
      await f.setup();
      await f.prompt('Fix the flaky upload test before you touch anything else.');
      const keys = f.entries.map((entry) => entry.key);
      for (const key of ['ask', 'route', 'proof']) assert(keys.includes(key), `no ${key} entry: wrote ${keys.join(',')}`);

      const ask = f.entries.find((entry) => entry.key === 'ask').value;
      const [kind, ...line] = ask.replace('[oc-stacked] ', '').split(': ');
      assert(kind === 'command', `prompt classified as ${kind}`);
      assert(line.join(': ') === ASK_COMMAND, `instruction line drifted: ${line.join(': ')}`);
      assert(ask.split('\n').length <= 2, 'the ask entry is more than two lines');

      const routed = f.entries.find((entry) => entry.key === 'route').value;
      const named = /Routed: ([a-z0-9-]+) \(([a-z]+), ([a-z]+)\)/.exec(routed);
      assert(named, `the route does not name a card and department: ${routed.slice(0, 90)}`);
      assert(routed.includes(`roles/${named[1]}.md`), 'the route does not name its card');
      assert(/route yourself/.test(routed), 'the route carries no room to disagree');
      const proof = f.entries.find((entry) => entry.key === 'proof').value;
      assert(proof.length && !proof.includes('Routed:'), `the proof entry carries more than the proof: ${proof.slice(0, 60)}`);
      return `ask=${kind}, route + proof written, ${f.entries.length} entries`;
    } finally {
      f.shut();
    }
  });

  await checkAsync('a short prompt and a close intent write no routing entry', async () => {
    const f = host();
    try {
      await f.setup();
      await f.prompt('yes');
      assert(f.entries.length === 0, `a 3-character prompt wrote ${f.entries.length} entries`);
      await f.prompt('please close the session now, we are done');
      assert(f.entries.length === 0, `a close intent wrote ${f.entries.length} entries`);
      return 'short input and close intent both stayed silent';
    } finally {
      f.shut();
    }
  });
}
