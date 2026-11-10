// The session title is the live status: one prefix, four transitions, no advice.
// Pure decisions only - the writer lives in index.js, so this file is testable
// without a host, a session, or a git tree.
//
//   [active]  a turn is running, or none has ended yet
//   [parked]  the turn is over and nothing is sealed
//   [done]    a GO receipt exists for this HEAD

export const STATUS = { active: '[active]', parked: '[parked]', done: '[done]' };

const PREFIX = /^\s*\[(?:active|parked|done)\] ?/i;
const CLAIM = /^\s*\[(active|parked|done)\]/i;

/** Remove one leading status prefix and the single space that follows it. */
export function stripStatus(title) {
  if (typeof title !== 'string') return '';
  return title.replace(PREFIX, '');
}

/** The title with exactly one status prefix, the old one replaced. */
export function withStatus(title, status) {
  const prefix = STATUS[status];
  if (!prefix) throw new Error(`unknown status: ${JSON.stringify(status)}`);
  const rest = stripStatus(title);
  return rest ? `${prefix} ${rest}` : prefix;
}

/** The claimed status, or null when the title carries no prefix. */
export function statusOf(title) {
  if (typeof title !== 'string') return null;
  const claim = CLAIM.exec(title);
  return claim ? claim[1].toLowerCase() : null;
}

export function isDone(title) {
  return statusOf(title) === 'done';
}

/** The close phrases an owner actually types. Case-insensitive, whole words. */
const CLOSE_PATTERNS = [
  /\bclose (?:the )?session\b/gi,
  /\bclose (?:it|this|out)\b/gi,
  /\bwrap (?:it|this) up\b/gi,
  /\bfinish (?:up|this)\b/gi,
  /\bseal (?:it|this)\b/gi,
  /\bcall it done\b/gi,
  /\bwe'?re done\b/gi,
  /\bend (?:the )?session\b/gi,
  /\bshut it down\b/gi,
  /\bclosing ceremony\b/gi,
];

/** The park phrases: the session is held, not finished. */
const PARK_PATTERNS = [
  /^\s*(?:please[\s,]+)?(?:stop|halt|freeze|pause|park)\b/gi,
  /\b(?:park|halt|freeze|pause) (?:it|this|the session)\b/gi,
  /\bstand down\b/gi,
  /\bhold (?:it|this)\b/gi,
];

/**
 * A match is negated when the words just before it say so: "don't", "do not",
 * "not yet". Three words of slack covers "don't think we should wrap it up"
 * without letting a "don't" at the top of a paragraph cancel every later verb.
 * The clause ends at the sentence, so "don't touch it. close the session" is
 * still a close.
 */
function negated(text, index) {
  const clause = (text.slice(0, index).split(/[.!?;\n]/).pop() || '').replace(/[\s,:\-\u2013\u2014"'()]+$/, '');
  return /(?:don(?:'|\u2019)t|do not|not yet)(?:\s+\S+){0,3}$/i.test(clause);
}

function matched(text, patterns) {
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!negated(text, match.index)) return true;
    }
  }
  return false;
}

/**
 * What the owner asked for in plain English: sealing, holding, or working on.
 * One decision, so the prompt hook and its test cannot drift apart.
 */
export function intentOf(text) {
  if (typeof text !== 'string' || !text.trim()) return 'resume';
  if (matched(text, CLOSE_PATTERNS)) return 'close';
  if (matched(text, PARK_PATTERNS)) return 'park';
  return 'resume';
}
