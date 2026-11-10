// The close ceremony. Opened tickets first, then one ordered run that can fail,
// and a GO receipt only when every step of it is green. The receipt is bound to
// the HEAD it was written at, so an earlier GO cannot be inherited by a tree
// that has moved.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkRecordReasons, configuredChecks, executeChecks } from './checks.js';
import { commandAsync } from './exec.js';
import { branch, git, head, isRepo, snapshot } from './git.js';
import {
  PATHS,
  config,
  junkPaths,
  ledgerEntries,
  log,
  renderDigest,
  sweepStack,
  tryReadJson,
  writeJson,
} from './state.js';
import { stamps, table } from './text.js';

export const CLOSE_PATH = '.stack/state/close.json';

/** A lesson shorter than this is a shrug, not a memory. */
const MIN_LESSON = 8;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

const shortSha = (sha) => (sha ? String(sha).slice(0, 7) : 'no-head');

/** The stack's own state never makes the tree dirty: it churns on every call. */
const isStackPath = (file) => {
  const p = file.replace(/\\/g, '/');
  return p === '.stack' || p.startsWith('.stack/');
};

/** The receipt, or `{ value: null, error }`. A corrupt receipt is named, never read as absent. */
export function readClose(dir) {
  return tryReadJson(dir, CLOSE_PATH, null);
}

/**
 * Why `[done]` cannot be claimed right now. An empty array is the only green:
 * a receipt exists, it says GO, it was not invalidated, and in a repository it
 * was written at the HEAD that is checked out now.
 */
export function closeReasons(dir) {
  const read = readClose(dir);
  if (read.error) {
    return [`\`${CLOSE_PATH}\` is unreadable (${read.error.message}). Run \`close\` op=run to replace it.`];
  }
  const receipt = read.value;
  if (!receipt) return [`no close receipt at \`${CLOSE_PATH}\`. Sealing needs \`close\` op=run with a lesson.`];

  const reasons = [];
  if (receipt.go !== true) reasons.push(`the recorded close is not a GO (go: ${JSON.stringify(receipt.go)}).`);
  if (isRepo(dir)) {
    const now = head(dir);
    if (!receipt.head) reasons.push('the receipt records no HEAD, so it cannot be bound to this tree.');
    else if (now && receipt.head !== now) reasons.push(`the receipt is for ${shortSha(receipt.head)} but HEAD is ${shortSha(now)}.`);
  }
  if (receipt.invalidated) reasons.push(`the receipt was invalidated: ${receipt.invalidated}.`);
  return reasons;
}

/**
 * Mark a live GO stale. The receipt keeps its evidence and gains the reason, so
 * the next reader sees why `[done]` went away instead of finding nothing.
 * Returns the new receipt, or null when there was nothing to invalidate.
 */
export function invalidateClose(dir, reason) {
  const read = readClose(dir);
  if (read.error || !read.value || read.value.invalidated) return null;
  const next = { ...read.value, invalidated: str(reason) || 'invalidated', invalidatedAt: stamps().iso };
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
  const blockers = [];
  const notes = [];
  const rows = [];

  // 1. An unanswered ASK is the owner's decision, and the close cannot make it.
  for (const ask of openAsks(dir)) {
    blockers.push(`open ticket: ASK from ${ask.at || '?'} has no later ANSWER — ${ask.text}`);
    rows.push(['ASK', `${ask.at || '?'} — ${ask.text}`, 'answer it, or record an ASK and park']);
  }

  // 2 and 3. Seams still in flight, and seams that landed without a verdict.
  const index = tryReadJson(dir, PATHS.briefsIndex, []);
  if (index.error) {
    blockers.push(`\`${PATHS.briefsIndex}\` is unreadable (${index.error.message}), so no seam can be checked.`);
  } else if (!Array.isArray(index.value)) {
    blockers.push(`\`${PATHS.briefsIndex}\` is not a list of briefs, so no seam can be checked.`);
  } else {
    const briefs = index.value;
    const audited = new Set();
    for (const entry of ledgerEntries(dir, Number.MAX_SAFE_INTEGER)) {
      if (entry.kind === 'AUDIT') for (const id of idsNamed(entry.text)) audited.add(id);
    }
    for (const brief of briefs) {
      if (brief.status !== 'landed' && brief.status !== 'killed') {
        blockers.push(`seam ${brief.id} is ${brief.status || 'briefed'}, not landed or killed.`);
        rows.push(['seam', `${brief.id} — ${brief.status || 'briefed'}`, 'land it behind a GO, or kill it']);
      } else if (brief.status === 'landed' && !audited.has(String(brief.id).toLowerCase())) {
        blockers.push(`seam ${brief.id} landed with no AUDIT line naming it.`);
        rows.push(['seam', `${brief.id} — landed, unaudited`, 'record an AUDIT line naming it']);
      }
    }
  }

  // 4. A check at HEAD does not cover work that was never committed.
  const dirty = isRepo(dir)
    ? snapshot(dir)
        .files.map((f) => f.file.replace(/\\/g, '/'))
        .filter((f) => !isStackPath(f))
    : [];
  for (const file of dirty) {
    blockers.push(`uncommitted work outside the stack: \`${file}\`. A check at HEAD does not cover it.`);
    rows.push(['dirty', `\`${file}\``, 'commit it']);
  }

  // 5. Nothing to prove is not a green.
  const { corrupt, all } = configuredChecks(dir);
  if (corrupt) {
    blockers.push(`${PATHS.config} is not valid JSON, so no check can be trusted. Fix it, then close again.`);
    rows.push(['checks', `${PATHS.config} unreadable`, 'fix the JSON']);
  } else if (!all.length) {
    blockers.push(`no proving check is configured in ${PATHS.config}. A close with nothing to prove is not green.`);
    rows.push(['checks', 'none configured', 'configure the command that proves this repo']);
  }

  // 6. The atlas is the memory the next session reads; a red one is a blocker.
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
  const ahead = isRepo(dir) ? unpushed(dir) : { count: null, text: 'not a git repository, so a push cannot be counted' };
  notes.push(ahead.text);
  const junk = junkPaths(dir);
  if (junk.length) notes.push(`${junk.length} junk path(s) found and never deleted: ${junk.join(', ')}`);
  if (cfg && cfg.atlas === undefined) notes.push(`atlas — not configured; no memory check ran`);

  const verdict = blockers.length ? 'BLOCKED' : 'GO';
  const text = [
    `## ${verdict} — preflight${blockers.length ? ` on ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}` : ''} at ${shortSha(head(dir))} (${branch(dir) || 'detached'})`,
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

  return { blockers, notes, text, atlas, dirty, junk };
}

/** A refusal made before any work: no receipt is written and none is deleted. */
const refused = (text) => ({ ok: false, text, receipt: null });

/**
 * Seal the session, in one order that cannot be skipped: the checks, the sweep,
 * the junk report, the lesson, the digest, the atlas. Any red deletes a previous
 * receipt and logs RED, so an old GO can never survive a failed close.
 */
export async function runClose(dir, { lesson } = {}) {
  const said = str(lesson);
  if (!said) {
    return refused(
      `## NO-GO — close\n\nRefused before any work: a close needs \`lesson\`, one sentence the next session must not lose.\n\nNothing was written, and any receipt already on disk was left alone.`,
    );
  }
  if (said.length < MIN_LESSON) {
    return refused(
      `## NO-GO — close\n\nRefused before any work: the lesson is ${said.length} character${said.length === 1 ? '' : 's'} and a close needs at least ${MIN_LESSON}. Write the fact the next session cannot rediscover.\n\nNothing was written, and any receipt already on disk was left alone.`,
    );
  }

  const red = (reasons, done) => {
    let leftover = '';
    try {
      fs.rmSync(path.join(dir, CLOSE_PATH), { force: true });
    } catch (err) {
      leftover = `the previous receipt could not be deleted (${err.message})`;
    }
    if (fs.existsSync(path.join(dir, CLOSE_PATH))) leftover = leftover || 'the previous receipt is still on disk';
    log(dir, 'RED', `close NO-GO: ${reasons.join('; ')}`);
    const text = [
      '## NO-GO — close',
      '',
      ...reasons.map((r) => `- **fail** · ${r}`),
      ...(done.length ? ['', ...done.map((d) => `- done · ${d}`)] : []),
      '',
      'Nothing was sealed. Any earlier receipt was deleted, so an old GO cannot survive this failure.',
      'Fix the reasons, not the wording, then run the close again.',
      ...(leftover ? ['', `**Warning:** ${leftover}; it may still read as GO. Delete it by hand.`] : []),
    ].join('\n');
    return { ok: false, text, receipt: null };
  };

  // The owner's order: open tickets first, and no ceremony over one of them.
  const pre = await preflight(dir, { lesson: said, atlas: true });
  if (pre.blockers.length) {
    return { ...red(pre.blockers, []), preflight: pre };
  }

  const done = [];
  const reasons = [];

  // 2. Every configured check, at this tree.
  const { all } = configuredChecks(dir);
  const record = await executeChecks(dir, all);
  const proven = checkRecordReasons(record, all);
  if (proven.length) {
    reasons.push(...proven);
  } else if (record.head !== head(dir)) {
    reasons.push(`checks ran at ${shortSha(record.head)} but HEAD is ${shortSha(head(dir))}. Re-run the close at the head you want to seal.`);
  } else {
    done.push(`checks green at ${shortSha(record.head)}: ${record.results.map((r) => r.name).join(', ')}`);
  }

  // 3. The sweep, which only ever removes what this plugin wrote under .stack/.
  const swept = sweepStack(dir, { apply: true });
  const sweep = { removed: swept.removed, kept: swept.kept };
  done.push(`sweep removed ${swept.removed.length} item(s), kept ${swept.kept.length}`);

  // 4. Junk is reported, never touched.
  const junk = junkPaths(dir);
  done.push(junk.length ? `junk found and left alone: ${junk.join(', ')}` : 'junk: none');

  // 5. The lesson, which is the one fact a compaction must not lose.
  log(dir, 'LESSON', said);
  done.push('lesson recorded in the ledger');

  // 6. The digest, rewritten from the ledger and the brief index.
  renderDigest(dir);
  done.push(`digest rewritten at ${PATHS.digest}`);

  // 7. The atlas, already run by the preflight above so the memory check is
  // paid for once per close. Its failure is a blocker the preflight named.
  done.push(`atlas: ${pre.atlas.status}`);

  if (reasons.length) return { ...red(reasons, done), preflight: pre };

  // 8. Every step green: the receipt that makes [done] possible.
  const receiptHead = head(dir);
  const receipt = {
    go: true,
    receipt_id: crypto.randomUUID(),
    sealed: shortSha(receiptHead),
    at: stamps().iso,
    head: receiptHead,
    branch: branch(dir),
    // The tested tree. The preflight refuses while anything outside .stack is
    // dirty, so this is the empty snapshot the checks above actually covered.
    tree: pre.dirty,
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
    dirty: pre.dirty,
  };
  writeJson(dir, CLOSE_PATH, receipt);
  log(dir, 'CLOSE', `GO at ${shortSha(receipt.head)} on ${receipt.branch || 'detached'}: ${record.results.length} check(s) green, atlas ${pre.atlas.status}`);

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
        ['tree', pre.dirty.length ? pre.dirty.join(', ') : 'clean outside .stack'],
        ['receipt', `${CLOSE_PATH} (${receipt.receipt_id})`],
      ],
    ),
    '',
    'Sealed. `[done]` is legitimate at this head until a new turn starts.',
    `SEALED ${receipt.sealed}`,
  ].join('\n');
  return { ok: true, text, receipt };
}
