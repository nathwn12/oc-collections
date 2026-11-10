// The close ceremony. Opened tickets first, then one ordered run that can fail,
// and a GO receipt only when every step of it is green. The receipt is bound to
// the HEAD it was written at, so an earlier GO cannot be inherited by a tree
// that has moved.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRecordReasons, configuredChecks, executeChecks } from './checks.js';
import { commandAsync } from './exec.js';
import { branch, git, head, isRepo, snapshot } from './git.js';
import {
  PATHS,
  config,
  ledgerEntries,
  log,
  renderDigest,
  sweepStack,
  tryReadJson,
  withLock,
  writeJson,
} from './state.js';
import { stamps, table } from './text.js';

export const CLOSE_PATH = '.stack/state/close.json';

/**
 * The one-shot arming record. It is written only by a close that sealed, after
 * the receipt, so the arming side can tell a receipt this run produced from one
 * that was already on disk. A refusal never writes it and never deletes it.
 */
export const ARMED_PATH = '.stack/state/close-armed.json';

/** A directory is a project when it is a repository or carries a build manifest. */
const PROJECT_MARKERS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'composer.json'];

/**
 * The lightest structural question the close gate asks: is this a clear
 * project or repository with a HEAD and a proving check? A bare directory, a
 * repository before its first commit, and a repository with no configured
 * check all answer false; none of them may auto-latch a close.
 */
export function closeable(dir) {
  const repo = isRepo(dir);
  const project = repo || PROJECT_MARKERS.some((name) => fs.existsSync(path.join(dir, name)));
  const headAt = repo ? head(dir) : null;
  const { corrupt, all } = configuredChecks(dir);
  const checks = !corrupt && all.length > 0;
  const bare = !project && !repo;
  const why = bare
    ? 'not a project or repository'
    : !repo
      ? 'not a git repository'
      : !headAt
        ? 'the repository has no HEAD'
        : !checks
          ? 'no proving check is configured'
          : null;
  return { repo, project, head: headAt, checks, bare, ok: why === null, why };
}

/** The one-shot marker a compact-only close leaves for the idle gate. */
export const COMPACT_PATH = '.stack/state/compact.json';

export function writeCompactMarker(dir) {
  withLock(dir, () => writeJson(dir, COMPACT_PATH, { at: stamps().iso }));
}

export function takeCompactMarker(dir) {
  const file = path.join(dir, ...COMPACT_PATH.split('/'));
  if (!fs.existsSync(file)) return false;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* the next idle retries */
  }
  return true;
}

/** A lesson shorter than this is a shrug, not a memory. */
const MIN_LESSON = 8;

/** The receipt's key: outside the repository, never printed, never logged, never in the digest. */
const SECRET_FILE = path.join(os.homedir(), '.config', 'opencode', 'oc-stacked.secret');
const SECRET_BYTES = 32;
/** A full sha, the uuid a close writes, and an HMAC-SHA256 digest. */
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG = /^[0-9a-f]{64}$/i;
/** A receipt dated this far ahead is not evidence of anything that happened. */
const FUTURE_SLACK_MS = 5 * 60 * 1000;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

const shortSha = (sha) => (sha ? String(sha).slice(0, 7) : 'no-head');

/**
 * Stable JSON for the signature: keys sorted, no whitespace. Two serialisations
 * of the same body sign the same, so a re-serialised receipt still verifies.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return String(JSON.stringify(value));
}

/** The signed part of a receipt: every field except the signature itself. */
function bodyOf(receipt) {
  const body = {};
  for (const [key, value] of Object.entries(receipt || {})) if (key !== 'sig') body[key] = value;
  return body;
}

/** The signature of a receipt body. Exported so a fixture signs exactly what the writer signs. */
export function signReceipt(receipt) {
  return crypto.createHmac('sha256', secretForWrite()).update(canonical(bodyOf(receipt))).digest('hex');
}

/** The machine-local secret, read only. A missing one is never created to validate a receipt. */
function readSecret() {
  let hex;
  try {
    hex = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch (err) {
    const why = err.code === 'ENOENT' ? `there is no secret at \`${SECRET_FILE}\`` : `\`${SECRET_FILE}\` could not be read (${err.message})`;
    return { secret: null, error: why };
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) return { secret: null, error: `\`${SECRET_FILE}\` is not 32 hex-encoded bytes` };
  return { secret: Buffer.from(hex, 'hex'), error: null };
}

/** The same secret, created once on a machine that has never closed. A write path only. */
function secretForWrite() {
  const read = readSecret();
  if (read.secret) return read.secret;
  const hex = crypto.randomBytes(SECRET_BYTES).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SECRET_FILE, `${hex}\n`, { mode: 0o600, flag: 'wx' });
    return Buffer.from(hex, 'hex');
  } catch (err) {
    if (err.code !== 'EEXIST') throw new Error(`the close secret could not be written to \`${SECRET_FILE}\`: ${err.message}`);
    const racing = readSecret();
    if (!racing.secret) throw new Error(racing.error);
    return racing.secret;
  }
}

/**
 * Why a receipt's signature does not stand: a missing `sig`, a body that no
 * longer matches it, and a secret that cannot be read are one verdict. The
 * reason never contains the secret.
 */
function signatureReasons(receipt) {
  const read = readSecret();
  if (!read.secret) return [`the receipt has no valid signature: ${read.error}.`];
  if (typeof receipt.sig !== 'string' || !SIG.test(receipt.sig)) {
    const said = receipt.sig === undefined ? '`sig` is missing' : '`sig` is not a sha256 digest';
    return [`the receipt has no valid signature: ${said}.`];
  }
  const expected = crypto.createHmac('sha256', read.secret).update(canonical(bodyOf(receipt))).digest();
  const given = Buffer.from(receipt.sig, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return ['the receipt has no valid signature: the body does not match `sig`.'];
  }
  return [];
}

/** The commit time of `sha` in ms, or null when git cannot name it. */
function committedAt(dir, sha) {
  if (!SHA.test(String(sha))) return null;
  const r = git(dir, ['show', '-s', '--format=%ct', String(sha)]);
  if (!r.ok) return null;
  const seconds = Number(String(r.out).trim());
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * True when a receipt on disk is dated after this run started, so it was written
 * by a later ceremony and this run's news is stale. Two closes can overlap; the
 * later fact wins, and an older run must not overwrite it.
 */
function newerThan(receipt, startedAt) {
  const at = Date.parse(receipt && receipt.at);
  return Number.isFinite(at) && at > Date.parse(startedAt);
}

/** The stack's own state never makes the tree dirty: it churns on every call. */
const isStackPath = (file) => {
  const p = file.replace(/\\/g, '/');
  return p === '.stack' || p.startsWith('.stack/');
};

/** Every path the working tree has touched outside `.stack`: what a check did not cover. */
const dirtyOutside = (dir) => {
  const snap = snapshot(dir);
  if (!snap.ok) return [];
  return snap.files.map((f) => f.file.replace(/\\/g, '/')).filter((f) => !isStackPath(f));
};

/** The receipt, or `{ value: null, error }`. A corrupt receipt is named, never read as absent. */
export function readClose(dir) {
  return tryReadJson(dir, CLOSE_PATH, null);
}

/**
 * Every way a receipt can fail to be evidence: its own fields, its binding to
 * this tree, and its signature. Each failure is named, so one run repairs all
 * of them. An empty array is the only green.
 */
function evidenceReasons(receipt, dir) {
  const said = [];
  const head = typeof receipt.head === 'string' ? receipt.head : '';

  if (receipt.sealed !== head.slice(0, 7)) {
    said.push(`the receipt's \`sealed\` is not the first 7 characters of its head (${JSON.stringify(receipt.sealed)}).`);
  }
  if (typeof receipt.receipt_id !== 'string' || !UUID.test(receipt.receipt_id)) {
    said.push(`the receipt's \`receipt_id\` is not the uuid a close writes (${JSON.stringify(receipt.receipt_id)}).`);
  }

  const checks = receipt.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    said.push('the receipt records no check run, so nothing was proved.');
  } else {
    if (checks.head !== head) {
      said.push(`the check run is bound to ${shortSha(checks.head)}, not the receipt's head (${shortSha(head)}).`);
    }
    if (!Array.isArray(checks.results) || !checks.results.length) {
      said.push('the receipt records no check results, so nothing was proved.');
    } else {
      checks.results.forEach((result, i) => {
        const name = result && typeof result.name === 'string' ? result.name : `#${i + 1}`;
        if (!result || result.ok !== true) said.push(`check \`${name}\` is not green (ok: ${JSON.stringify(result && result.ok)}).`);
        if (!result || typeof result.code !== 'number' || result.code !== 0) {
          said.push(`check \`${name}\` exited ${JSON.stringify(result && result.code)}, not 0.`);
        }
      });
    }
  }

  const criteria = Array.isArray(receipt.criteria) && receipt.criteria.length ? receipt.criteria : null;
  if (!criteria) said.push('the receipt records no criteria, so no step was shown to hold.');
  else if (!criteria.some((c) => c && c.id === 'preflight' && c.status === 'pass')) {
    said.push("the receipt's criteria do not include a passing `preflight`.");
  }

  const at = Date.parse(receipt.at);
  if (typeof receipt.at !== 'string' || Number.isNaN(at)) {
    said.push(`the receipt's \`at\` is not a date (${JSON.stringify(receipt.at)}).`);
  } else {
    if (at - Date.now() > FUTURE_SLACK_MS) said.push("the receipt's `at` is more than 5 minutes in the future.");
    const committed = committedAt(dir, head);
    if (committed !== null && at < committed) said.push("the receipt's `at` is earlier than the commit it seals.");
  }

  const lesson = str(receipt.lesson);
  if (!lesson) said.push('the receipt records no lesson.');
  else if (lesson.length < MIN_LESSON) {
    said.push(`the receipt's lesson is ${lesson.length} character${lesson.length === 1 ? '' : 's'}; a close needs at least ${MIN_LESSON}.`);
  }

  said.push(...signatureReasons(receipt));
  return said;
}

/**
 * Why `[done]` cannot be claimed right now. An empty array is the only green:
 * a git repository holds a signed receipt, it says GO, it was not invalidated,
 * it was written at the HEAD that is checked out now, its own evidence holds,
 * and nothing outside `.stack` has been touched since. A non-git directory can
 * never be green: no HEAD, no binding. A tombstone is a refusal and nothing
 * else: it is reported as one reason and never read as evidence.
 */
export function closeReasons(dir) {
  const read = readClose(dir);
  if (read.error) {
    return [`\`${CLOSE_PATH}\` is unreadable (${read.error.message}). Run \`close\` op=run to replace it.`];
  }
  const receipt = read.value;
  if (!receipt) return [`no close receipt at \`${CLOSE_PATH}\`. Sealing needs \`close\` op=run with a lesson.`];
  if (typeof receipt !== 'object' || Array.isArray(receipt)) {
    return [`\`${CLOSE_PATH}\` is not a receipt object. Run \`close\` op=run to replace it.`];
  }

  // A tombstone is a NO-GO that happened. It is not evidence, and no field of it
  // is checked: a refusal record carrying a signature must still never validate.
  if (receipt.go !== true) {
    const why = Array.isArray(receipt.reasons) && receipt.reasons.length ? String(receipt.reasons[0]) : null;
    return [
      why
        ? `the last close was refused: ${why}`
        : `the recorded close is not a GO (go: ${JSON.stringify(receipt.go)}).`,
    ];
  }

  const reasons = [];
  const repo = isRepo(dir);
  const now = repo ? head(dir) : null;
  if (!repo) {
    reasons.push('not a git repository: a close needs a HEAD to bind the receipt.');
  } else if (!receipt.head) {
    reasons.push('the receipt records no HEAD, so it cannot be bound to this tree.');
  } else if (!SHA.test(String(receipt.head))) {
    reasons.push(`the receipt's \`head\` is not a full 40-character lowercase sha (${JSON.stringify(receipt.head)}).`);
  } else if (now && receipt.head !== now) {
    reasons.push(`the receipt is for ${shortSha(receipt.head)} but HEAD is ${shortSha(now)}.`);
  }
  // The tested tree was clean outside .stack. An edit since then is not covered.
  if (dirtyOutside(dir).length) {
    reasons.push('the working tree has uncommitted work outside .stack; the receipt covers a clean tree.');
  }
  if (receipt.invalidated) reasons.push(`the receipt was invalidated: ${receipt.invalidated}.`);

  reasons.push(...evidenceReasons(receipt, dir));
  return reasons;
}

/**
 * Mark a live GO stale. The receipt keeps its evidence and gains the reason, so
 * the next reader sees why `[done]` went away instead of finding nothing.
 * Returns the new receipt, or null when there was nothing to invalidate. A
 * tombstone is already a refusal and is left alone; what this writes, it signs,
 * so the only reason an invalidated receipt carries is that it was invalidated.
 */
export function invalidateClose(dir, reason) {
  const read = readClose(dir);
  if (read.error || !read.value || read.value.invalidated || read.value.go !== true) return null;
  const next = { ...read.value, invalidated: str(reason) || 'invalidated', invalidatedAt: stamps().iso };
  try {
    next.sig = signReceipt(next);
  } catch {
    /* the secret is gone: an unsigned invalidated receipt is refused anyway */
  }
  writeJson(dir, CLOSE_PATH, next);
  return next;
}

/** Every open ledger ASK with no later ANSWER, oldest first. */
function openAsks(dir) {
  const entries = ledgerEntries(dir, Number.MAX_SAFE_INTEGER);
  const asks = [];
  entries.forEach((entry, i) => {
    if (entry.kind !== 'ASK') return;
    if (!entries.slice(i + 1).some((later) => later.kind === 'ANSWER')) asks.push(entry);
  });
  return asks;
}

/** Commits on this branch that no remote has: a note, never a blocker. */
function unpushed(dir) {
  const r = git(dir, ['rev-list', '--count', '@{u}..HEAD']);
  if (!r.ok) return { count: null, text: 'no upstream branch to compare against; a push is owner-gated, never the agent\'s' };
  const count = Number(r.out);
  if (!Number.isFinite(count)) return { count: null, text: 'unpushed commits could not be counted' };
  return { count, text: `${count} unpushed commit${count === 1 ? '' : 's'}; a push is owner-gated, never the agent's` };
}

/**
 * The ids a ledger line actually names: whole tokens, split on anything that
 * cannot appear in a seam id. An AUDIT for `close` must not satisfy
 * `close-ceremony`, and a substring match would let it.
 */
const idsNamed = (text) =>
  String(text)
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter(Boolean);

const PASS = /\bPASS\b/i;
const FAIL = /\bFAIL\b/i;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The audit text with every seam id taken out, whole and attached to a `@sha`.
 * An id is a name, not a verdict: `fail-gate: PASS` says pass, and reading the
 * `fail` inside the id read it as both. Longest first, so an id that ends
 * another id's prefix cannot leave a fragment behind.
 */
const withoutIds = (text, ids) => {
  const named = (Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim())
    .sort((a, b) => b.length - a.length);
  if (!named.length) return String(text);
  const pattern = named.map(escapeRe).join('|');
  return String(text).replace(new RegExp(`(?:${pattern})(?:@[A-Za-z0-9]+)?`, 'gi'), ' ');
};

/**
 * What one AUDIT line says, as a word and not as a substring. `bypass:
 * inconclusive, needs work` mentions neither verdict, and a `/pass/i` test read
 * it as a pass. The ids the line names are removed first, so a verdict word
 * inside an id cannot outvote the verdict. A line with both words, or with
 * neither, is not a verdict and blocks: only a standalone FAIL blocks, only a
 * standalone PASS clears.
 */
const verdictOf = (text, ids = []) => {
  const said = withoutIds(text, ids);
  const pass = PASS.test(said);
  const fail = FAIL.test(said);
  if (pass && fail) return 'both';
  if (pass) return 'pass';
  if (fail) return 'fail';
  return 'none';
};

/**
 * The open tickets, read without changing anything. The close refuses on a
 * blocker and never on a note: an unpushed commit, a junk file and a missing
 * lesson are all said out loud, and none of them stops the ceremony the owner
 * asked for.
 *
 * `atlas: false` skips the atlas command entirely. The idle gate calls this on
 * every pause, and the atlas is a maintain run measured in minutes, so a
 * preflight that reads only files is the one the loop can afford. The ceremony
 * itself pays for the atlas exactly once.
 */
export async function preflight(dir, { lesson = '', atlas: runAtlas = true } = {}) {
  const can = closeable(dir);
  const repo = can.repo;
  const headAt = can.head;
  const blockers = [];
  const notes = [];
  const rows = [];

  // 1. A receipt is bound to a HEAD. Without a repository, or before its first
  //    commit, there is nothing to bind.
  if (!repo) {
    blockers.push('not a git repository: a close needs a HEAD to bind the receipt.');
    rows.push(['repo', 'not a git repository', 'run the close from the repository that holds the work']);
  } else if (!headAt) {
    blockers.push('the repository has no HEAD: a close needs a commit to bind the receipt.');
    rows.push(['repo', 'no HEAD', 'make the first commit, then close again']);
  }

  // 2. An unanswered ASK is the owner's decision, and the close cannot make it.
  for (const ask of openAsks(dir)) {
    blockers.push(`open ticket: ASK from ${ask.at || '?'} has no later ANSWER — ${ask.text}`);
    rows.push(['ASK', `${ask.at || '?'} — ${ask.text}`, 'answer it, or record an ASK and park']);
  }

  // 3 and 4. Seams still in flight, and seams that landed without a passing verdict.
  const index = tryReadJson(dir, PATHS.briefsIndex, []);
  if (index.error) {
    blockers.push(`\`${PATHS.briefsIndex}\` is unreadable (${index.error.message}), so no seam can be checked.`);
  } else if (!Array.isArray(index.value)) {
    blockers.push(`\`${PATHS.briefsIndex}\` is not a list of briefs, so no seam can be checked.`);
  } else {
    const briefs = index.value;
    // The ids are names, never verdicts: the classifier strips them before it
    // reads PASS or FAIL, so `fail-gate: PASS` is a pass.
    const ids = briefs.map((brief) => brief && brief.id);
    // The latest AUDIT text per named id: an old verdict cannot outvote a new one,
    // and a FAIL stands until a later line says PASS.
    const audits = new Map();
    for (const entry of ledgerEntries(dir, Number.MAX_SAFE_INTEGER)) {
      if (entry.kind !== 'AUDIT') continue;
      for (const id of idsNamed(entry.text)) audits.set(id, entry.text);
    }
    for (const brief of briefs) {
      if (brief.status !== 'landed' && brief.status !== 'killed') {
        blockers.push(`seam ${brief.id} is ${brief.status || 'briefed'}, not landed or killed.`);
        rows.push(['seam', `${brief.id} — ${brief.status || 'briefed'}`, 'land it behind a GO, or kill it']);
      } else if (brief.status === 'landed') {
        const audit = audits.get(String(brief.id).toLowerCase());
        if (audit === undefined) {
          blockers.push(`seam ${brief.id} landed with no AUDIT line naming it.`);
          rows.push(['seam', `${brief.id} — landed, unaudited`, 'record an AUDIT line naming it']);
          continue;
        }
        const verdictOfAudit = verdictOf(audit, ids);
        if (verdictOfAudit === 'fail') {
          blockers.push(`the latest AUDIT for ${brief.id} is FAIL.`);
          rows.push(['seam', `${brief.id} — latest AUDIT is FAIL`, 'fix what the audit found, then audit it again']);
        } else if (verdictOfAudit !== 'pass') {
          const said = verdictOfAudit === 'both' ? 'it says both PASS and FAIL' : 'it says neither PASS nor FAIL';
          blockers.push(`the latest AUDIT for ${brief.id} is ambiguous: ${said}.`);
          rows.push(['seam', `${brief.id} — latest AUDIT is ambiguous`, 'record an AUDIT that ends in one verdict']);
        }
      }
    }
  }

  // 5. A check at HEAD does not cover work that was never committed.
  const dirty = dirtyOutside(dir);
  for (const file of dirty) {
    blockers.push(`uncommitted work outside the stack: \`${file}\`. A check at HEAD does not cover it.`);
    rows.push(['dirty', `\`${file}\``, 'commit it']);
  }

  // 6. Nothing to prove is not a green.
  const { corrupt, all } = configuredChecks(dir);
  if (corrupt) {
    blockers.push(`${PATHS.config} is not valid JSON, so no check can be trusted. Fix it, then close again.`);
    rows.push(['checks', `${PATHS.config} unreadable`, 'fix the JSON']);
  } else if (!all.length) {
    blockers.push(`no proving check is configured in ${PATHS.config}. A close with nothing to prove is not green.`);
    rows.push(['checks', 'none configured', 'configure the command that proves this repo']);
  }

  // 7. The atlas is the memory the next session reads; a red one is a blocker.
  const cfg = config(dir);
  const atlasCfg = cfg && typeof cfg.atlas === 'object' ? cfg.atlas : null;
  let atlas = { status: 'not configured', code: null, ms: 0 };
  if (atlasCfg && str(atlasCfg.command)) {
    if (!runAtlas) {
      atlas = { status: 'not run', code: null, ms: 0 };
      notes.push(`atlas — not run in a preflight; the ceremony runs it once`);
    } else if (process.env.OC_STACKED_NO_EXEC === '1') {
      atlas = { status: 'not run', code: null, ms: 0 };
      blockers.push('execution is disabled by OC_STACKED_NO_EXEC=1, so neither the checks nor the atlas can prove anything.');
    } else {
      const r = await commandAsync(str(atlasCfg.command), {
        cwd: str(atlasCfg.cwd) ? path.join(dir, str(atlasCfg.cwd)) : dir,
        timeout: Number(atlasCfg.timeout) > 0 ? Number(atlasCfg.timeout) : 180000,
        env: { ...process.env, CI: process.env.CI ?? '1' },
      });
      atlas = { status: r.ok ? 'pass' : 'fail', code: r.code ?? null, ms: r.ms };
      if (!r.ok) {
        const detail = String(r.display || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || '';
        blockers.push(`atlas command failed: \`${str(atlasCfg.command)}\` — exit ${r.code}${detail ? ` — ${detail}` : ''}`);
        rows.push(['atlas', `exit ${r.code}`, 'fix the atlas command, then close again']);
      }
    }
  }

  // Notes: facts the owner should see, none of which stops the ceremony.
  notes.push(`lesson — ${str(lesson).length >= MIN_LESSON ? 'recorded' : `needs at least ${MIN_LESSON} characters`}`);
  const ahead = repo ? unpushed(dir) : { count: null, text: 'not a git repository, so a push cannot be counted' };
  notes.push(ahead.text);
  const junk = [];
  if (cfg && cfg.atlas === undefined) notes.push(`atlas — not configured; no memory check ran`);

  // The lightest true ending, chosen after every fact is read: a session with
  // nothing to land and only a structural blocker (no HEAD, no check) compacts
  // instead of demanding a seal. A bare directory is declined, never refused.
  const structural = (reason) =>
    /^not a git repository:/.test(reason) ||
    /^the repository has no HEAD:/.test(reason) ||
    /^no proving check is configured/.test(reason) ||
    /is not valid JSON, so no check can be trusted/.test(reason) ||
    /execution is disabled by OC_STACKED_NO_EXEC=1/.test(reason);
  const work = blockers.filter((reason) => !structural(reason));
  const compactOnly = work.length === 0 && (blockers.length > 0 || can.bare);
  const branchAt = repo ? branch(dir) : null;

  if (can.bare) {
    return {
      decline: true,
      compactOnly: work.length === 0,
      blockers,
      notes,
      text: 'not a project or repository',
      atlas,
      dirty,
      junk,
      head: headAt,
      branch: branchAt,
    };
  }

  const verdict = blockers.length ? 'BLOCKED' : 'GO';
  const text = [
    `## ${verdict} — preflight${blockers.length ? ` on ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}` : ''} at ${shortSha(headAt)} (${branchAt || 'detached'})`,
    '',
    ...(blockers.length ? ['Why:', '', ...blockers.map((b) => `- ${b}`), ''] : []),
    rows.length
      ? table(['Ticket', 'State', 'What it needs'], rows)
      : 'No open ticket. Every ask is answered and every seam is closed.',
    '',
    'Notes (never blockers):',
    ...notes.map((n) => `- ${n}`),
    '',
    blockers.length
      ? 'The close refuses while a blocker stands. Sort it out, then run the ceremony.'
      : 'Nothing stands in the way. The ceremony is `close` op=run with one lesson.',
  ].join('\n');

  return { blockers, notes, text, atlas, dirty, junk, head: headAt, branch: branchAt, compactOnly };
}

/**
 * A refusal leaves a tombstone, never a deletion. Windows refuses to unlink a
 * file another process holds, and a call that "tried" is not a gate: the atomic
 * overwrite is the operation the platform actually permits. The write happens
 * under the state lock and only over an older receipt, so a later ceremony's GO
 * is never destroyed by a refusal that arrived late. A tombstone that cannot be
 * written throws, because a NO-GO that leaves a readable GO is not a NO-GO, and
 * the arming side must find no record to act on.
 */
function refuse(dir, reasons, { done = [], before = false, startedAt } = {}) {
  const tombstone = {
    go: false,
    receipt_id: crypto.randomUUID(),
    at: stamps().iso,
    startedAt,
    head: head(dir),
    reasons: reasons.map(String),
  };

  let kept = null;
  let failure = null;
  try {
    withLock(dir, () => {
      const current = tryReadJson(dir, CLOSE_PATH, null).value;
      if (current && typeof current === 'object' && current.go === true && newerThan(current, startedAt)) {
        kept = current;
        return;
      }
      writeJson(dir, CLOSE_PATH, tombstone);
    });
  } catch (err) {
    failure = err;
  }

  const tail = failure
    ? `**The refused close could not replace \`${CLOSE_PATH}\` (${failure.message}). Delete it by hand: until it is gone the old receipt may still read as GO.**`
    : kept
      ? `A later close is already sealed at ${shortSha(kept.head)} (${kept.receipt_id}); its receipt was kept, so this refusal did not overwrite it.`
      : `\`${CLOSE_PATH}\` now holds a refusal record (\`go: false\`), so an earlier GO cannot survive this failure.`;

  const text = [
    '## NO-GO — close',
    '',
    ...(before ? ['Refused before any work.', ''] : []),
    ...reasons.map((r) => `- **fail** · ${r}`),
    ...(done.length ? ['', ...done.map((d) => `- done · ${d}`)] : []),
    '',
    tail,
    'Fix the reasons, not the wording, then run the close again.',
  ].join('\n');

  if (failure) {
    // The old receipt is still readable, so nothing about this state may look
    // like a NO-GO. Take the arming record away and throw instead of returning.
    try {
      fs.rmSync(path.join(dir, ARMED_PATH), { force: true });
    } catch {
      /* best effort: the throw below is the gate */
    }
    log(dir, 'RED', `close NO-GO: ${reasons.join('; ')}; the refusal record could not replace ${CLOSE_PATH} (${failure.message})`);
    throw new Error(text);
  }
  log(dir, 'RED', `close NO-GO: ${reasons.join('; ')}`);
  return { ok: false, text, receipt: null };
}

/**
 * Seal the session, in one order that cannot be skipped: the checks, the sweep,
 * the lesson, the digest, the atlas. Any red replaces a previous
 * receipt with a tombstone and logs RED, so an old GO can never survive a failed
 * close, and a GO also leaves the one-shot arming record for the title gate.
 * Both writes carry this run's `startedAt` and happen under the state lock, so
 * two overlapping ceremonies order themselves instead of overwriting each other.
 *
 * Adaptive: a bare directory declines with no refusal record; a session with
 * nothing to land and only a structural blocker compacts instead of sealing.
 */
export async function runClose(dir, { lesson } = {}) {
  // Before the first await: the instant this ceremony began, which is what the
  // receipt ordering compares against, never a clock read after the work.
  const startedAt = stamps().iso;
  const said = str(lesson);
  const can = closeable(dir);
  if (can.bare) {
    const barePre = await preflight(dir, { lesson: said, atlas: false });
    if (barePre.compactOnly) {
      writeCompactMarker(dir);
      return {
        text: 'not a project or repository; nothing to land - compaction is the only remaining act',
        compactOnly: true,
        preflight: barePre,
      };
    }
    return { text: 'not a project or repository', decline: true, preflight: barePre };
  }
  if (!said) {
    return refuse(dir, ['a close needs `lesson`, one sentence the next session must not lose.'], { before: true, startedAt });
  }
  if (said.length < MIN_LESSON) {
    const size = `${said.length} character${said.length === 1 ? '' : 's'}`;
    return refuse(dir, [`the lesson is ${size} and a close needs at least ${MIN_LESSON}.`], { before: true, startedAt });
  }

  // The lightest true ending first: a session with nothing to land and only a
  // structural blocker compacts; it never writes a refusal record.
  const quick = await preflight(dir, { lesson: said, atlas: false });
  if (quick.compactOnly) {
    writeCompactMarker(dir);
    return { text: 'nothing to land - compaction is the only remaining act', compactOnly: true, preflight: quick };
  }

  // The owner's order: open tickets first, and no ceremony over one of them.
  const pre = await preflight(dir, { lesson: said, atlas: true });
  if (pre.decline) return { text: pre.text, decline: true, preflight: pre };
  if (pre.blockers.length) {
    return { ...refuse(dir, pre.blockers, { startedAt }), preflight: pre };
  }

  const done = [];
  const reasons = [];

  // 2. Every configured check, at this tree.
  const { all } = configuredChecks(dir);
  const record = await executeChecks(dir, all);
  const proven = checkRecordReasons(record, all);
  if (proven.length) {
    reasons.push(...proven);
  } else if (pre.head !== record.head) {
    reasons.push(`the preflight read ${shortSha(pre.head)} but the checks ran at ${shortSha(record.head)}: HEAD moved between them. Re-run the close at the head you want to seal.`);
  } else {
    done.push(`checks green at ${shortSha(record.head)}: ${record.results.map((r) => r.name).join(', ')}`);
  }

  // 3. The sweep only ever removes what this plugin wrote under .stack/. A
  //    clean sweep says nothing: there is no junk report to read.
  const swept = sweepStack(dir, { apply: true });
  const sweep = { removed: swept.removed, kept: swept.kept };
  if (swept.removed.length) done.push(`sweep removed ${swept.removed.length} item(s)`);

  // 4. Junk is only what the stack itself would remove. Unrelated paths are
  //    never scanned, named, or reported.
  const junk = [];

  // 5. The lesson, which is the one fact a compaction must not lose.
  log(dir, 'LESSON', said);
  done.push('lesson recorded in the ledger');

  // 6. The digest, rewritten from the ledger and the brief index.
  renderDigest(dir);
  done.push(`digest rewritten at ${PATHS.digest}`);

  // Preserve the produced order: the report names everything the run did.
  done.push(`atlas: ${pre.atlas.status}`);

  // 8. The tree the checks proved must still be the tree on disk: a check that
  // writes a file, or an edit during the ceremony, is not covered by its green.
  const post = await preflight(dir, { lesson: said, atlas: false });
  if (post.blockers.length) reasons.push(...post.blockers);
  const nowHead = head(dir);
  if (nowHead !== record.head || post.head !== record.head || post.dirty.length) {
    reasons.push(
      `the tree or HEAD changed after the checks ran: checks at ${shortSha(record.head)}, HEAD ${shortSha(nowHead)}${post.dirty.length ? `, ${post.dirty.length} path(s) dirty` : ''}.`,
    );
  }

  if (reasons.length) return { ...refuse(dir, reasons, { done, startedAt }), preflight: pre };

  // 9. Every step green: the receipt that makes [done] possible. The head is the
  // one the checks started at, never a fresh read: a check that moved HEAD has
  // already refused above, and reading again here would hide it.
  const receiptHead = record.head;
  const body = {
    go: true,
    receipt_id: crypto.randomUUID(),
    sealed: shortSha(receiptHead),
    at: stamps().iso,
    startedAt,
    head: receiptHead,
    branch: branch(dir),
    // The tested tree. The preflight refuses while anything outside .stack is
    // dirty, so this is the empty snapshot the checks above actually covered.
    tree: post.dirty,
    criteria: [{ id: 'preflight', status: 'pass', evidence: [] }],
    lesson: said,
    checks: {
      at: record.at,
      head: record.head,
      results: record.results.map(({ name, ok, code, ms }) => ({ name, ok, code, ms })),
    },
    sweep,
    junk,
    atlas: pre.atlas,
    dirty: post.dirty,
  };

  // The signature is what makes a receipt evidence instead of a shape anyone can
  // type: the body is signed with a key that lives outside the repository, and
  // the signature is written beside it so what is on disk is what was signed.
  let receipt;
  try {
    receipt = { ...body, sig: signReceipt(body) };
  } catch (err) {
    return { ...refuse(dir, [`the receipt could not be signed: ${err.message}. Fix \`${SECRET_FILE}\` and close again.`], { done, startedAt }), preflight: pre };
  }

  // The ordering rule: a GO replaces anything older and nothing newer. A later
  // ceremony's receipt is the later fact, so this one keeps it.
  let kept = null;
  let armed = 'written';
  withLock(dir, () => {
    const current = tryReadJson(dir, CLOSE_PATH, null).value;
    if (current && typeof current === 'object' && newerThan(current, startedAt)) {
      kept = current;
      return;
    }
    writeJson(dir, CLOSE_PATH, receipt);
    // The one-shot arming record, written after the receipt and never before: a
    // refused run must leave an earlier record alone for the consumer to consume.
    try {
      writeJson(dir, ARMED_PATH, { receipt_id: receipt.receipt_id, head: receipt.head, at: stamps().iso });
    } catch (err) {
      armed = `not written (${err.message}); the seal stands, the title stays active`;
    }
  });
  if (kept) armed = `not written: a later close is sealed at ${shortSha(kept.head)}`;
  log(dir, 'CLOSE', `GO at ${shortSha(receipt.head)} on ${receipt.branch || 'detached'}: ${record.results.length} check(s) green, atlas ${pre.atlas.status}, armed ${armed}`);

  const text = [
    `## GO — close at ${shortSha(receipt.head)} (${receipt.branch || 'detached'})`,
    '',
    table(
      ['Step', 'Result'],
      [
        ['checks', `${record.results.filter((r) => r.ok).length}/${record.results.length} green at ${shortSha(record.head)}`],
        ['sweep', `removed ${swept.removed.length}, kept ${swept.kept.length}`],
        ['junk', junk.length ? `${junk.length} path(s) named, none touched` : 'none'],
        ['lesson', said],
        ['digest', `rewritten at ${PATHS.digest}`],
        ['atlas', `${pre.atlas.status}${pre.atlas.code === null ? '' : ` (exit ${pre.atlas.code})`}`],
        ['tree', post.dirty.length ? post.dirty.join(', ') : 'clean outside .stack'],
        ['receipt', kept ? `${CLOSE_PATH} kept from a later close (${kept.receipt_id})` : `${CLOSE_PATH} (${receipt.receipt_id}, signed)`],
        ['armed', armed],
      ],
    ),
    '',
    kept
      ? `A later close is already sealed at ${shortSha(kept.head)}; its receipt was kept.`
      : 'Sealed. `[done]` is legitimate at this head until a new turn starts.',
    `SEALED ${shortSha(kept ? kept.head : receipt.sealed)}`,
  ].join('\n');
  return { ok: true, text, receipt };
}
