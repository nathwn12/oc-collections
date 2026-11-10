// Self-routing: the first prompt is scored against the seat cards, locally.
//
// No model call, no network, no host: the cards are text on disk and overlap is
// arithmetic, so the cost of a takeover is microseconds instead of a round-trip.
// Accuracy lives in the cards - a term's weight is how rare it is across the
// loaded set - so a card added tomorrow routes with no code change, and a card
// reworded today routes differently an hour later.
//
//   loadCards(dir)          the cards, parsed and cached by directory mtime
//   route(prompt, cards)    the best card or null; pure, deterministic, fast
//   classifyAsk(text)       idea | intent | goal | objective | command, with the tell
//   cacheStats()            reads vs hits, so the cache can be proven, not assumed
//
// Ties never break randomly: the department order below, then the card id. The
// same prompt routes the same way on every machine, every run.
import fs from 'node:fs';
import path from 'node:path';
import { splitFrontmatter } from './text.js';

/** How much a term is worth by where it appears in a card. */
const WEIGHT = { name: 3, department: 2, body: 1 };
/** A named card, or a named department, is intent rather than resemblance. */
const EXPLICIT = { card: 10, department: 4 };
/** A prefix hit ("deploy" for "deployment") is worth less than the word itself. */
const PREFIX = 0.8;
/** Below this fraction of the possible evidence, the honest answer is "no
 *  route", not the least-bad card. Scaled by the card count so a two-card
 *  corpus is not silently unroutable. */
const FLOOR = 5;
const FLOOR_SCALE = Math.log(1 + 22);
/** The runner-up is named only when it is a real alternative, not a distant echo. */
const RUNNER_UP = 0.7;
/**
 * Ties break by department, in this order: the discipline that writes the code,
 * then the one that proves it, then the surfaces it runs on, then the record.
 * A department this list does not name sorts last, alphabetically, so a new one
 * is still deterministic.
 */
const DEPARTMENTS = ['engineering', 'quality', 'platform', 'research', 'knowledge', 'design', 'product'];

/** Words that carry no discipline: every card would match them. */
const STOPWORDS = new Set(
  (
    'a an the and or but if then than that this these those it its is are was were be been being am ' +
    'do does did doing done have has had having will would shall should can could may might must ' +
    'i we you he she they them me us him her my our your their there here what which who whom whose ' +
    'when where why how all any some each every few more most much many other another same own such ' +
    'no not only just also very too so as at by for from in into of off on out over under up with ' +
    'about across after against before between during through to toward via per again further once ' +
    'let lets make makes made take takes took get gets got give gives gave put puts say says said ' +
    'see sees saw know knows think thinks want wants need needs use uses used using work works ' +
    'thing things way ways one two three first last new old well good better best still even'
  ).split(/\s+/),
);

/** Light stemming: `ing`, `ed`, `es`, `s`, and nothing cleverer. */
function stem(word) {
  if (word.length > 6 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Lower-case terms, stopwords dropped, stems kept. Set semantics by the caller. */
function tokens(text) {
  const out = [];
  for (const raw of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const term = stem(raw);
    if (term.length < 2 || STOPWORDS.has(term)) continue;
    out.push(term);
  }
  return out;
}

/** The text under one `## Heading`, up to the next heading. */
function section(body, heading) {
  const at = body.search(new RegExp(`^##\\s*${heading}\\s*$`, 'im'));
  if (at === -1) return '';
  const rest = body.slice(at).replace(/^##[^\n]*\n/, '');
  const next = rest.search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The prompt as ` word word ` so a phrase is matched whole, never inside a word. */
const normalise = (text) => ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '').replace(/ +/g, ' ')} `;

// ------------------------------------------------------------------- loading
//
// One parse per directory per process. The key is the directory's mtime: a card
// added, removed or renamed changes it, and the next prompt sees the new set.
// A card edited in place does not change the directory mtime, so that edit is
// picked up on the next process start - the routing corpus is a package file,
// not hot state, and re-reading 22 files on every prompt is the cost this cache
// exists to avoid.

const cache = new Map();
const stats = { reads: 0, hits: 0 };

/** The counters the check reads; `reads` is full directory passes, not stats. */
export function cacheStats() {
  return { reads: stats.reads, hits: stats.hits };
}

/**
 * Every `roles/*.md` under `dir` (or `dir/roles` when that is where they live),
 * as `{ id, name, department, seat, proof, text }`. A card missing frontmatter
 * or a required field is skipped and named on the returned array's `skipped`
 * list; nothing here throws on a bad card.
 */
export function loadCards(dir) {
  const roles = path.resolve(dir);
  const rolesDir = fs.existsSync(path.join(roles, 'roles')) ? path.join(roles, 'roles') : roles;
  let mtime;
  try {
    mtime = fs.statSync(rolesDir).mtimeMs;
  } catch (err) {
    throw new Error(`no card directory at ${rolesDir}: ${err?.message || err}`);
  }
  const hit = cache.get(rolesDir);
  if (hit && hit.mtime === mtime) {
    stats.hits += 1;
    return hit.cards;
  }

  stats.reads += 1;
  const skipped = [];
  const files = fs
    .readdirSync(rolesDir)
    .filter((file) => file.toLowerCase().endsWith('.md'))
    .sort();

  const cards = [];
  for (const file of files) {
    const id = file.slice(0, -'.md'.length);
    let source;
    try {
      source = fs.readFileSync(path.join(rolesDir, file), 'utf8');
    } catch (err) {
      skipped.push({ id, reason: `unreadable: ${err?.message || err}` });
      continue;
    }
    const { data, body } = splitFrontmatter(source);
    const missing = ['name', 'department', 'seat', 'proof'].filter((key) => !data[key]);
    if (missing.length) {
      skipped.push({ id, reason: `missing ${missing.join(', ')}` });
      continue;
    }
    cards.push({
      id,
      name: data.name,
      department: data.department.toLowerCase(),
      seat: data.seat.toLowerCase(),
      proof: data.proof,
      text: body,
    });
  }

  Object.defineProperty(cards, 'skipped', { value: skipped, enumerable: false });
  Object.freeze(cards);
  // The index is built with the cards, never inside a prompt: the first prompt
  // of a session must not pay for indexing 22 cards.
  indexFor(cards);
  cache.set(rolesDir, { mtime, cards });
  return cards;
}

// ------------------------------------------------------------------- scoring
//
// The index is built once per card array (identity), so the second prompt in a
// session pays a map lookup per word. `idf` is the rarity of a term across the
// loaded cards: "testing" is worth little because several cards own it, while
// "migration" is worth a lot because one does. That is the whole reason a new
// card needs no code: it earns its own weights from its own text.
const indices = new WeakMap();

function indexFor(cards) {
  const cached = indices.get(cards);
  if (cached) return cached;

  const fields = cards.map((card) => {
    const terms = new Map();
    const add = (text, weight) => {
      for (const term of tokens(text)) {
        const prior = terms.get(term) || 0;
        if (weight > prior) terms.set(term, weight);
      }
    };
    add(card.name, WEIGHT.name);
    add(card.department, WEIGHT.department);
    add(section(card.text, 'Owns'), WEIGHT.body);
    add(section(card.text, 'Must not'), WEIGHT.body);
    return terms;
  });

  const frequency = new Map();
  for (const terms of fields) {
    for (const term of terms.keys()) frequency.set(term, (frequency.get(term) || 0) + 1);
  }

  const terms = new Map();
  const prefix = new Map();
  fields.forEach((card, i) => {
    for (const [term, weight] of card) {
      // Rarity is the whole weight: "testing" is worth little because several
      // cards own it; "migration" is worth a lot because one does. That is why
      // a card added tomorrow earns its own weights from its own text.
      const worth = Math.log(1 + cards.length / frequency.get(term));
      const entry = terms.get(term) || { cards: [] };
      entry.cards.push([i, weight, worth]);
      terms.set(term, entry);
      const key = term.slice(0, 4);
      const bucket = prefix.get(key);
      if (bucket) bucket.push(term);
      else prefix.set(key, [term]);
    }
  });

  const index = {
    terms,
    prefix,
    // The phrases an owner could type to name this card outright: the card's
    // name, and its id spelled with a space instead of a hyphen. A one-word id
    // is a phrase too - "backend", "tester", "docs".
    names: cards.map((card) => [...new Set([normalise(card.name), normalise(card.id.replace(/-/g, ' '))])]),
    departments: cards.map((card) => tokens(card.department)),
  };
  indices.set(cards, index);
  return index;
}

/** Card terms a prompt term is a prefix of, or the other way round. */
function kin(index, term) {
  const bucket = index.prefix.get(term.slice(0, 4));
  if (!bucket) return null;
  let found = null;
  for (const other of bucket) {
    if (other === term) continue;
    if (Math.abs(other.length - term.length) > 4) continue;
    if (other.startsWith(term) || term.startsWith(other)) (found || (found = [])).push(other);
  }
  return found;
}

function departmentRank(department) {
  const at = DEPARTMENTS.indexOf(department);
  return at === -1 ? DEPARTMENTS.length : at;
}

const round = (n) => Math.round(n * 100) / 100;

/** Every card's score for one prompt, best first, ties broken deterministically. */
function rank(prompt, cards) {
  const index = indexFor(cards);
  const scores = new Array(cards.length).fill(0);

  const seen = new Set();
  for (const term of tokens(prompt)) {
    if (seen.has(term)) continue;
    seen.add(term);
    const entry = index.terms.get(term);
    if (entry) {
      for (const [at, weight, worth] of entry.cards) scores[at] += weight * worth;
      continue;
    }
    for (const other of kin(index, term) || []) {
      for (const [at, weight, worth] of index.terms.get(other).cards) scores[at] += weight * worth * PREFIX;
    }
  }

  // An owner who names the card or the department has already routed: no
  // resemblance is allowed to outvote a name.
  const said = normalise(prompt);
  const words = new Set(tokens(prompt));
  cards.forEach((card, at) => {
    if (index.names[at].some((name) => said.includes(name))) {
      scores[at] += EXPLICIT.card;
      return;
    }
    if (index.departments[at].length && index.departments[at].every((word) => words.has(word))) {
      scores[at] += EXPLICIT.department;
    }
  });

  const order = cards
    .map((card, at) => at)
    .sort(
      (a, b) =>
        scores[b] - scores[a] ||
        departmentRank(cards[a].department) - departmentRank(cards[b].department) ||
        cards[a].id.localeCompare(cards[b].id),
    );
  return { order, scores };
}

/**
 * The seat this prompt is asking for, or null when nothing fits well enough to
 * claim it. Pure: the same prompt and the same cards always give the same
 * answer, and `took` is the wall time this call spent.
 */
export function route(prompt, cards) {
  const started = process.hrtime.bigint();
  if (typeof prompt !== 'string' || !Array.isArray(cards) || !cards.length) return null;

  const { order, scores } = rank(prompt, cards);

  const best = order[0];
  const top = scores[best];
  // The floor is a fraction of the most a name could earn from this corpus, so
  // the same rule holds for 22 cards and for a fixture with three.
  const floor = (FLOOR * Math.log(1 + cards.length)) / FLOOR_SCALE;
  if (!(top >= floor)) return null;

  const ids = [cards[best].id];
  const second = order[1];
  if (second !== undefined && scores[second] >= top * RUNNER_UP && scores[second] > 0) ids.push(cards[second].id);

  return {
    seat: cards[best].seat,
    department: cards[best].department,
    cards: ids,
    proof: cards[best].proof,
    score: round(top),
    took: round(Number(process.hrtime.bigint() - started) / 1e6),
  };
}

// ---------------------------------------------------------------- the ask
//
// What kind of thing was the owner handed the harness: a thought, a wish, an
// outcome, a stop condition, or an order. Signals only - the same words an
// operator would underline - so the answer is arithmetic over one sentence,
// microseconds, and identical on every run. The default is `intent`, because a
// misread that still asks for a falsifiable outcome costs a sentence while a
// misread that calls an order an idea costs the turn.

/** Precedence, strongest first. The order below is the tie-break. */
const ASK_KINDS = ['objective', 'goal', 'command', 'intent', 'idea'];

const IMPERATIVES = new Set([
  'fix', 'add', 'remove', 'make', 'run', 'ship', 'close', 'push', 'delete', 'rename',
  'install', 'test', 'review', 'write', 'build', 'refactor', 'split', 'wire', 'harden',
]);

const OBJECTIVE = [/\bdo not stop\b/i, /\bfinal is\b/i, /\buntil\b/i, /\bno more\b/i, /\bby the end\b/i];

const GOAL = [
  /\bso that\b/i,
  /\bby\s+(?:(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|quarter|year|tomorrow|tonight|eod|eow)\b|the\s+(?:end\s+of\s+the\s+)?(?:day|week|month|quarter|year)\b|(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\d{1,2}(?:st|nd|rd|th)\b)/i,
  /\b(?:reach|hit|target|budget)\b/i,
];

const INTENT = [/\bi want\b/i, /\bi need\b/i, /\bi'?d like\b/i];
const MAKE_IT_SO = /\bmake it so\b/i;
const IDEA = [/\bwhat if\b/i, /\bmaybe\b/i, /\bcould we\b/i, /\bwould it\b/i, /\bhow about\b/i, /\bi'?m thinking\b/i];
const STRONG_COMMAND = [/\bnow\b/i, /\basap\b/i, /\bdo it\b/i, /\bjust do\b/i];
const WEAK_COMMAND = /\bgo\b/i;

/** The text of the first pattern that matches, or null. */
function tell(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

/**
 * `{ kind, score, tell }` for one prompt: `idea`, `intent`, `goal`, `objective`
 * or `command`. Deterministic, no I/O, and it never throws on a bad value.
 */
export function classifyAsk(text) {
  const said = typeof text === 'string' ? text.trim() : '';
  if (!said) return { kind: 'intent', score: 0, tell: 'empty; assumed intent' };

  const words = said.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  const startsImperative = IMPERATIVES.has(words[0] || '');
  const namesImperative = words.some((word) => IMPERATIVES.has(word));

  const objective = tell(said, OBJECTIVE);
  if (objective) return { kind: 'objective', score: 3, tell: objective };

  const goal = tell(said, GOAL);
  if (goal) return { kind: 'goal', score: 3, tell: goal };

  // "make it so" is an order's phrasing inside an intent's clothes: the verb
  // would make it a command, and the owner means the outcome.
  if (MAKE_IT_SO.test(said)) return { kind: 'intent', score: 2, tell: 'make it so' };

  const strong = tell(said, STRONG_COMMAND);
  if (startsImperative) return { kind: 'command', score: 2, tell: words[0] };
  if (strong) return { kind: 'command', score: 2, tell: strong };

  const intent = tell(said, INTENT);
  if (intent) return { kind: 'intent', score: 2, tell: intent };

  const idea = tell(said, IDEA) || (said.endsWith('?') && !namesImperative ? '?' : null);
  const weak = WEAK_COMMAND.exec(said);
  // "What if we go with the second option?" carries a `go`; the thought is the
  // message, so a bare `go` never outranks an idea it sits inside.
  if (weak && !idea) return { kind: 'command', score: 1, tell: weak[0] };
  if (idea) return { kind: 'idea', score: 2, tell: idea };

  // Nothing fired: say so, and ask for an outcome rather than treat it as a
  // thought. ASK_KINDS documents the precedence this fallback sits below.
  return { kind: 'intent', score: 0, tell: `no signal in "${said.slice(0, 40)}"; assumed ${ASK_KINDS[3]}` };
}
