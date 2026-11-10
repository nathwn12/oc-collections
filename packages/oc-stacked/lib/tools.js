// The seven local tools. No network, no MCP, no daemons: files and git only.
import fs from 'node:fs';
import path from 'node:path';
import { matchesGlob, slug, stamps, table } from './text.js';
import { packageRoot } from './content.js';
import { head, branch, isRepo, snapshot, committedPaths, changedFiles } from './git.js';
import { commandAsync } from './exec.js';
import {
  PATHS,
  config,
  ensureStack,
  isCorruptConfig,
  log,
  ledgerEntries,
  readJson,
  renderDigest,
  seedStack,
  sweepStack,
  junkPaths,
  tryReadJson,
  withLock,
  writeAtomic,
  writeJson,
} from './state.js';

const ok = (text) => ({ content: text });
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) =>
  Array.isArray(v) ? v.map(str).filter(Boolean) : str(v).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * An id is a file name. Explicit ids are slugged so `Retry-Budget` and
 * `retry-budget` are one seam on every filesystem, then anything that could
 * resolve outside `.stack/briefs/` is refused rather than repaired.
 */
function seamId(raw) {
  const value = str(raw);
  if (!value) return { id: '', error: null };
  if (/[\\/]/.test(value) || value.includes('..')) {
    return { id: null, error: `\`${value}\` is not a seam id: ids are file names, so no path separators and no \`..\`.` };
  }
  const id = slug(value);
  if (!ID_RE.test(id)) {
    return { id: null, error: `\`${value}\` is not a seam id: use letters, digits, dot, dash, underscore.` };
  }
  return { id, error: null };
}

/** Resolve a validated id under `.stack/briefs/` and prove it stayed there. */
function briefFile(dir, id) {
  const root = path.resolve(dir, PATHS.briefs);
  const file = path.resolve(root, `${id}.md`);
  return file.startsWith(root + path.sep) ? file : null;
}

/** The brief index, or a named error instead of a silent empty list. */
function indexOf(dir) {
  const read = tryReadJson(dir, PATHS.briefsIndex, []);
  if (read.error) {
    return {
      index: null,
      error: `\`${PATHS.briefsIndex}\` is unreadable (${read.error.message}). Restore it; the brief index cannot be trusted.`,
    };
  }
  if (!Array.isArray(read.value)) {
    return { index: null, error: `\`${PATHS.briefsIndex}\` is not a list of briefs. Restore it; the brief index cannot be trusted.` };
  }
  return { index: read.value, error: null };
}

/** True for paths the stack ignores: its own state and the configured globs. */
function ignoredPaths(dir) {
  const globs = list(config(dir)?.ownership?.ignore);
  return (file) => {
    const p = file.replace(/\\/g, '/');
    return p === '.stack' || p.startsWith('.stack/') || globs.some((g) => matchesGlob(g, p));
  };
}

/** One line, no fence: markdown copied from a field can never inject a section. */
const oneLine = (v) => str(v).replace(/`{3,}/g, '``').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- ledger

function ledgerTool(dir) {
  return {
    name: 'ledger',
    description:
      'The stack memory. op=log appends one stamped line (never edits); op=tail reads the last lines; op=digest rewrites .stack/digest.md from the ledger and the brief index and returns it. Kinds: NOTE, ASK, ANSWER, BRIEF, READY, LANDED, RED, RULING, LESSON, INTAKE, AUDIT, SWARM, SEED.',
    input: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['log', 'tail', 'digest'], description: 'Operation. Default: tail.' },
        kind: { type: 'string', description: 'Ledger kind for op=log, e.g. NOTE, ASK, INTAKE, READY, LANDED, AUDIT.' },
        text: { type: 'string', description: 'One line of text for op=log.' },
        limit: { type: 'number', description: 'How many entries for op=tail. Default 20.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    execute: async (input) => {
      const op = str(input.op) || 'tail';
      if (op === 'log') {
        const text = str(input.text);
        if (!text) return ok('Nothing logged: `text` is required.');
        return ok(`Logged.\n${log(dir, str(input.kind) || 'NOTE', text)}`);
      }
      if (op === 'digest') return ok(renderDigest(dir));
      const limit = Number(input.limit) > 0 ? Number(input.limit) : 20;
      const entries = ledgerEntries(dir, limit);
      if (!entries.length) return ok('The ledger is empty. Start with op=log.');
      return ok(entries.map((e) => `- ${e.at || '?'} · ${e.kind} · ${e.text}`).join('\n'));
    },
  };
}

// ---------------------------------------------------------------- brief

const BRIEF_REQUIRED = [
  ['out', 'What leaves the room when this is done. One sentence a stranger understands.'],
  ['check', 'The command that proves it. It must be able to go red.'],
  ['owns', 'The files or directories this seam may touch, as globs.'],
];

const TIER_NOTE = {
  cheap: 'The plan text is complete; this is transcription plus a check.',
  standard: 'Multi-file coordination, ordinary care.',
  expert: 'Design judgement is the work. The lead keeps the design and hands you the decision, not the discovery.',
};

/** A seam that has not landed and has not been killed still owns its files. */
const isLive = (brief) => brief && brief.status !== 'landed' && brief.status !== 'killed';

/**
 * Two live seams collide when they claim the same exact file. That is the only
 * collision: same folder, same package, and overlapping globs are all fine,
 * because disjointness is proved on paths, not on intent. A glob says what a
 * seam may read or audit; `files` says what it may edit.
 */
function collisions(candidate, index) {
  const files = list(candidate.files).map((f) => f.replace(/\\/g, '/').toLowerCase());
  const hits = [];

  for (const other of index) {
    if (!isLive(other) || other.id === candidate.id) continue;
    const otherFiles = list(other.files).map((f) => f.replace(/\\/g, '/').toLowerCase());
    const shared = files.filter((f) => otherFiles.includes(f));
    if (shared.length) {
      hits.push({ id: other.id, files: [...new Set(shared)], why: 'both seams may edit the same file' });
    }
  }
  return hits;
}

/** Build the body and index record; writes nothing. */
function buildBrief(dir, spec) {
  const id = seamId(str(spec.id) || str(spec.title)).id;
  const file = id ? briefFile(dir, id) : null;
  if (!id || !file) throw new Error(`not a seam id: ${str(spec.id) || str(spec.title)}`);

  // Every field that lands in the markdown is one line and cannot close the
  // fence; a check containing a fence could otherwise inject sections.
  const title = oneLine(spec.title) || id;
  const why = oneLine(spec.why);
  const check = oneLine(spec.check);
  const out = str(spec.out);
  const owns = list(spec.owns);
  const files = list(spec.files).map((f) => f.replace(/\\/g, '/'));
  const avoid = list(spec.avoid);
  const read = list(spec.read);
  const tier = str(spec.tier) || 'standard';
  const agent = str(spec.agent);

  const body = [
    `# Seam ${id}: ${title}`,
    '',
    `**Owner of this seam:** one \`${agent || 'unassigned'}\` employee. **Written by:** the lead. **State:** briefed.`,
    '',
    '## Why now',
    '',
    why || '_Not stated. The employee must not invent it._',
    '',
    '## Out',
    '',
    out,
    '',
    '## Check',
    '',
    '```text',
    check,
    '```',
    '',
    'It passes only when the command exits 0 and the output shows the new behaviour.',
    'A check that cannot go red is not a check.',
    '',
    '## Owns',
    '',
    ...(owns.length ? owns.map((o) => `- \`${o}\``) : ['- Only the files listed below.']),
    '',
    ...(files.length
      ? ['## Files (exact, exclusive)', '', ...files.map((f) => `- \`${f}\``), '', 'No other seam may touch these. No other file is yours.', '']
      : []),
    '## Do not touch',
    '',
    ...(avoid.length ? avoid.map((o) => `- \`${o}\``) : ['- Anything outside Owns and Files.']),
    '',
    '## Read first',
    '',
    ...(read.length ? read.map((r) => `- \`${r}\``) : ['- The files in Owns, and nothing else until they are understood.']),
    '',
    '## Tier',
    '',
    `${tier}. ${TIER_NOTE[tier] || TIER_NOTE.standard}`,
    '',
    'The archetype names the seat, and `routing.json` pins its model at install. The tier says how much judgement the brief expects, not which model runs: an expert seam is designed by the lead before it reaches you.',
    '',
    '## Rules that bind this seam',
    '',
    '1. Name the unknown before writing code. If this brief is wrong, say so in one message and stop; do not reinterpret it.',
    '2. The smallest change that closes Out. No speculative flexibility.',
    '3. Every changed line traces to Out. Orphans you created, you delete. Pre-existing dead code, you report.',
    '4. Paste the command and its output in the report. A claim without a command is `Unverified`.',
    '5. Never merge, never push a shared branch, never dispatch another agent. Two failures of the same command: stop and report.',
    '',
    '## Report',
    '',
    `Write \`.stack/reports/${id}.md\` with these five headings, all mandatory:`,
    '',
    '```text',
    '## Outcome     what shipped, two or three sentences',
    '## Evidence    the command and the real output at the head you hand back',
    '## Unverified  every claim you did not check, and why; "none" is a claim',
    '## Scope       paths touched, each inside Owns, or why not',
    '## Lesson      one paragraph the next employee should know',
    '```',
    '',
    'Then return one paragraph: outcome, commits, check result, concerns.',
    '',
  ].join('\n');

  const record = {
    id,
    title,
    out,
    check,
    owns,
    files,
    tier,
    agent,
    status: 'briefed',
    head: head(dir),
    at: stamps().iso,
  };

  return { id, title, body, record, file };
}

/** One writer for brief bodies, so `brief` and `swarm` cannot drift apart. */
function writeBrief(dir, spec) {
  const built = buildBrief(dir, spec);
  return withLock(dir, () => {
    const existed = fs.existsSync(built.file);
    const previous = existed ? fs.readFileSync(built.file, 'utf8') : null;
    try {
      writeAtomic(built.file, built.body);
      const index = readJson(dir, PATHS.briefsIndex, []);
      writeJson(dir, PATHS.briefsIndex, [...index.filter((b) => b.id !== built.id), built.record]);
    } catch (err) {
      // Leave the directory as it was: a partial pair is worse than a refusal.
      try {
        if (previous === null) fs.unlinkSync(built.file);
        else writeAtomic(built.file, previous);
      } catch {
        /* best effort: the original error is the one worth reporting */
      }
      throw err;
    }
    log(dir, 'BRIEF', `${existed ? 'rewrote' : 'wrote'} ${built.id}: ${built.title}`);
    return { id: built.id, title: built.title, file: built.file, existed, record: built.record };
  });
}

/** routing.json is the single source of model routing; install.mjs injects it into copies. */
const routing = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'routing.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const isArchetype = (name) => Object.prototype.hasOwnProperty.call(routing, name);

const dispatchBlock = (id, tier, agent) => {
  const name = str(agent);
  const seat = !name ? 'unassigned' : `${name} (${routing[name] || 'inherit'})`;
  return `Seam: ${id}\nBrief: ${PATHS.briefs}/${id}.md\nAgent: ${seat}\nTier: ${tier || 'standard'}\nReport: ${PATHS.reports}/${id}.md\n\nRead the brief first; it is your requirements. Build nothing outside its Files. Return one paragraph: outcome, commits, check result, concerns.`;
};

function briefTool(dir) {
  return {
    name: 'brief',
    description:
      'The seam contract. op=new writes .stack/briefs/<id>.md and indexes it; op=list shows every seam; op=get prints one; op=status moves a seam (briefed, building, ready, landed, killed). A brief missing Out, Check or Owns is refused, and so is a dirty tree. Declaring `files` also refuses a collision with any live seam that already owns one of those exact files. Re-briefing a seam that has moved past briefed needs `force: true`.',
    input: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['new', 'list', 'get', 'status'], description: 'Operation.' },
        title: { type: 'string', description: 'Short seam title, e.g. "retry budget for webhook delivery".' },
        id: { type: 'string', description: 'Seam id. Derived from the title when omitted.' },
        out: { type: 'string', description: 'The deliverable, one sentence.' },
        check: { type: 'string', description: 'The proving command.' },
        owns: { type: 'array', items: { type: 'string' }, description: 'Owned paths or globs, for the scope audit.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Exact files this seam may edit. Two live seams may not share one.' },
        avoid: { type: 'array', items: { type: 'string' }, description: 'Paths this seam must not touch.' },
        read: { type: 'array', items: { type: 'string' }, description: 'Files the employee must read first.' },
        tier: { type: 'string', enum: ['cheap', 'standard', 'expert'], description: 'Model tier for the employee.' },
        agent: {
          type: 'string',
          description: 'Archetype id from routing.json, e.g. backend or reviewer. A seam with no archetype prints Agent: unassigned and ready refuses it.',
        },
        why: { type: 'string', description: 'Why this seam matters now. One line.' },
        status: { type: 'string', description: 'New status for op=status.' },
        force: {
          type: 'boolean',
          description:
            'Two overrides: mark landed without a recorded GO, or overwrite a seam already past briefed. The refusal is logged either way.',
        },
        limit: { type: 'number', description: 'Rows for op=list. Default 20.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    execute: async (input) => {
      ensureStack(dir);
      const op = str(input.op);

      if (op === 'new') {
        const missing = BRIEF_REQUIRED.filter(([key]) => {
          const value = input[key];
          return key === 'owns' ? !list(value).length : !str(value);
        }).map(([key, why]) => `- \`${key}\` — ${why}`);

        if (missing.length) {
          return ok(
            `Refused. A brief with a hole is a seam that will be guessed at.\n\n${missing.join('\n')}\n\nNothing was written.`,
          );
        }

        if (isRepo(dir)) {
          const ignored = ignoredPaths(dir);
          const dirty = snapshot(dir)
            .files.map((f) => f.file)
            .filter((f) => !ignored(f));
          if (dirty.length) {
            return ok(
              [
                'Refused. The working tree is dirty, so there is no base commit to brief against:',
                '',
                ...dirty.map((f) => `- \`${f}\``),
                '',
                'Commit or stash it, then brief. Nothing was written.',
              ].join('\n'),
            );
          }
        }

        const normalized = seamId(str(input.id) || slug(str(input.title)));
        if (normalized.error) return ok(`Refused. ${normalized.error}\n\nNothing was written.`);
        const id = normalized.id;

        if (str(input.agent) && !isArchetype(str(input.agent))) {
          return ok(
            `Refused. \`${str(input.agent)}\` is not an archetype in routing.json, so the dispatch block would name a seat that does not exist. Use one of the ids listed there, or omit it and the seam lands unassigned. Nothing was written.`,
          );
        }

        const read = indexOf(dir);
        if (read.error) return ok(`Refused. ${read.error}\n\nNothing was written.`);

        const existing = read.index.find((b) => b.id === id);
        if (existing && existing.status !== 'briefed' && input.force !== true) {
          return ok(
            [
              `Refused. \`${id}\` is already **${existing.status}**. Re-briefing it would reset the state to briefed and move its base to the current HEAD, which quietly erases the work and the gate history behind it.`,
              '',
              'Move it with op=status, brief a different seam, or pass `force: true` to overwrite it on purpose and say why in the ledger. Nothing was written.',
            ].join('\n'),
          );
        }

        const clashes = collisions({ id, files: input.files, owns: input.owns }, read.index);
        if (clashes.length) return ok(clashReport(clashes));

        let written;
        try {
          written = writeBrief(dir, { ...input, id });
        } catch (err) {
          return ok(`Refused. Writing the brief failed: ${err.message}\n\nNothing was indexed.`);
        }
        return ok(
          `Brief written: ${PATHS.briefs}/${id}.md\n\nDispatch one employee with:\n\`\`\`text\n${dispatchBlock(id, written.record.tier, written.record.agent)}\n\`\`\``,
        );
      }

      if (op === 'get') {
        const normalized = seamId(input.id);
        if (normalized.error) return ok(`Refused. ${normalized.error}`);
        const id = normalized.id;
        if (!id) return ok('No brief named `(empty)`. Try op=list.');
        const file = briefFile(dir, id);
        if (!file || !fs.existsSync(file)) return ok(`No brief named \`${id}\`. Try op=list.`);
        return ok(fs.readFileSync(file, 'utf8'));
      }

      if (op === 'status') {
        const normalized = seamId(input.id);
        if (normalized.error) return ok(`Refused. ${normalized.error}`);
        const id = normalized.id;
        const status = str(input.status);
        if (!id || !status) return ok('op=status needs `id` and `status`.');

        const pre = indexOf(dir);
        if (pre.error) return ok(`Refused. ${pre.error}\n\nNothing was written.`);

        let outcome;
        try {
          outcome = withLock(dir, () => {
            // Re-read inside the lock: another writer may have moved the index
            // between the check above and this commit.
            const index = readJson(dir, PATHS.briefsIndex, []);
            const found = index.find((b) => b.id === id);
            if (!found) return { text: `No brief named \`${id}\`.` };

            // A seam is landed only behind a recorded GO. Otherwise the digest
            // would quietly claim work the gate never approved, which is the
            // exact failure this system exists to prevent.
            if (status === 'landed' && !input.force) {
              const verdict = lastVerdict(dir, id);
              if (!verdict || verdict.kind !== 'READY') {
                const last = verdict ? `the last gate said **${verdict.kind}**: ${verdict.text}` : 'no gate has run for this seam';
                return {
                  text: `Refused. ${id} cannot be marked landed: ${last}.\n\nRun \`ready\` with the id and land only on GO. If the gate cannot see something it needs, pass \`force: true\` and say why in the ledger; the refusal is recorded either way.`,
                };
              }
              log(dir, 'LANDED', `${id} behind ${verdict.at}`);
            } else if (status === 'landed' && input.force) {
              log(dir, 'RULING', `${id} landed without a GO, forced by the lead`);
            }

            found.status = status;
            found.at = stamps().iso;
            writeJson(dir, PATHS.briefsIndex, index);
            log(dir, status.toUpperCase(), `${id}`);
            return { text: `${id} → ${status}.` };
          });
        } catch (err) {
          return ok(`Refused. The status change failed: ${err.message}\n\nNothing was written.`);
        }
        return ok(outcome.text);
      }

      const read = indexOf(dir);
      if (read.error) return ok(`Refused. ${read.error}`);
      if (!read.index.length) return ok('No briefs yet. op=new writes the first one.');
      const rows = read.index.slice(-(Number(input.limit) > 0 ? Number(input.limit) : 20)).reverse();
      return ok(
        table(
          ['Id', 'Title', 'Files', 'Tier', 'State', 'Age'],
          rows.map((b) => [b.id, b.title, String((b.files || []).length), b.tier, b.status, shortAge(b.at)]),
        ),
      );
    },
  };
}

/** The last gate verdict recorded for a seam, from the whole ledger. */
function lastVerdict(dir, id) {
  const entries = ledgerEntries(dir, Number.MAX_SAFE_INTEGER);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if ((entry.kind === 'READY' || entry.kind === 'RED') && entry.text.startsWith(`${id}:`)) return entry;
  }
  return null;
}

function clashReport(clashes) {
  return [
    'Refused. Two live seams would edit the same file, which is one seam with two owners and a merge conflict.',
    '',
    ...clashes.map((c) => `- \`${c.id}\` — ${c.why}: ${c.files.map((f) => `\`${f}\``).join(', ')}`),
    '',
    'Merge them into one seam, move the file boundary, or land one before you brief the other. Nothing was written.',
  ].join('\n');
}

// ---------------------------------------------------------------- swarm

const SWARM_CAP = 10;

function swarmTool(dir) {
  return {
    name: 'swarm',
    description:
      'Atomic fan-out. Takes 2 to 10 seams, proves their exact files are disjoint (and clear of every live brief), writes every brief body first and the index in one locked write, and returns one dispatch prompt per employee. Refuses the whole swarm if any seam is incomplete, duplicated, or shares a file. This is the only way to fan out more than one seam.',
    input: {
      type: 'object',
      properties: {
        why: { type: 'string', description: 'Why these seams run together. One line, shared by all of them.' },
        seams: {
          type: 'array',
          description: 'Two to ten seams. Each needs title, out, check, and files.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short seam title.' },
              id: { type: 'string', description: 'Seam id. Derived from the title when omitted.' },
              out: { type: 'string', description: 'The deliverable, one sentence.' },
              check: { type: 'string', description: 'The command that proves it.' },
              files: { type: 'array', items: { type: 'string' }, description: 'Exact files this seam may edit.' },
              owns: { type: 'array', items: { type: 'string' }, description: 'Globs for the scope audit.' },
              tier: { type: 'string', enum: ['cheap', 'standard', 'expert'], description: 'Model tier.' },
              agent: { type: 'string', description: 'Archetype id from routing.json.' },
              why: { type: 'string', description: 'Why this one matters. Falls back to the swarm reason.' },
            },
            required: ['title', 'out', 'check', 'files'],
            additionalProperties: false,
          },
        },
      },
      required: ['seams'],
      additionalProperties: false,
    },
    execute: async (input) => {
      ensureStack(dir);
      const seams = Array.isArray(input.seams) ? input.seams : [];
      const sharedWhy = str(input.why);

      if (seams.length < 2) {
        return ok(
          'Refused. A swarm is two or more seams. For one seam use `brief` op=new; fan-out of one is just work with extra steps.',
        );
      }
      if (seams.length > SWARM_CAP) {
        return ok(
          `Refused. ${seams.length} seams is over the ceiling of ${SWARM_CAP}. An unreconciled worker is work you cannot land. Cut it, or run two waves.`,
        );
      }

      const holes = [];
      const prepared = seams.map((s, i) => {
        const normalized = seamId(str(s.id) || slug(str(s.title) || `seam-${i + 1}`));
        const id = normalized.id || str(s.id) || `seam-${i + 1}`;
        if (normalized.error) holes.push(`- seam ${i + 1}: ${normalized.error}`);
        if (!str(s.title)) holes.push(`- seam ${i + 1}: no title`);
        if (!str(s.out)) holes.push(`- ${id}: no \`out\``);
        if (!str(s.check)) holes.push(`- ${id}: no \`check\`. A seam whose proof you cannot name is not ready to run.`);
        if (!list(s.files).length) holes.push(`- ${id}: no \`files\`. Disjointness is proved on exact paths.`);
        if (str(s.agent) && !isArchetype(str(s.agent))) {
          holes.push(`- ${id}: \`${str(s.agent)}\` is not an archetype in routing.json.`);
        }
        return {
          id,
          title: str(s.title) || id,
          out: str(s.out),
          check: str(s.check),
          files: list(s.files).map((f) => f.replace(/\\/g, '/')),
          owns: list(s.owns).length ? list(s.owns) : list(s.files).map((f) => f.replace(/\\/g, '/')),
          tier: str(s.tier) || 'standard',
          agent: str(s.agent),
          why: str(s.why) || sharedWhy,
        };
      });

      const ids = prepared.map((s) => s.id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupes.length) holes.push(`- duplicate seam id: ${[...new Set(dupes)].join(', ')}`);
      if (holes.length) {
        return ok(`Refused. A swarm with a hole is ten guesses running at once.\n\n${holes.join('\n')}\n\nNothing was written.`);
      }

      // Exact-file disjointness inside the swarm.
      const claims = new Map();
      const clashes = [];
      for (const seam of prepared) {
        for (const file of seam.files) {
          if (claims.has(file) && claims.get(file) !== seam.id) {
            clashes.push(`- \`${file}\` claimed by \`${claims.get(file)}\` and \`${seam.id}\``);
          } else {
            claims.set(file, seam.id);
          }
        }
      }
      if (clashes.length) {
        return ok(
          [
            'Refused. These seams would edit the same file, which makes them one seam with two owners.',
            '',
            ...clashes,
            '',
            'Merge the colliding seams, or move one file to a seam that owns it. Nothing was written.',
          ].join('\n'),
        );
      }

      // Collisions with seams that are already live outside this swarm.
      const read = indexOf(dir);
      if (read.error) return ok(`Refused. ${read.error}\n\nNothing was written.`);
      const incoming = new Set(ids);
      const external = [];
      for (const seam of prepared) {
        for (const hit of collisions(seam, read.index.filter((b) => !incoming.has(b.id)))) {
          external.push(`- \`${seam.id}\` vs live \`${hit.id}\`: ${hit.why} (${hit.files.join(', ')})`);
        }
      }
      if (external.length) {
        return ok(
          ['Refused. These seams collide with work already in flight.', '', ...external, '', 'Land or kill the older seam first. Nothing was written.'].join('\n'),
        );
      }

      // Build every body before touching the disk, so a bad seam cannot leave a
      // half-written swarm.
      let built;
      try {
        built = prepared.map((seam) => buildBrief(dir, seam));
      } catch (err) {
        return ok(`Refused. Building the swarm failed: ${err.message}\n\nNothing was written.`);
      }

      const writtenFiles = [];
      try {
        for (const item of built) {
          writeAtomic(item.file, item.body);
          writtenFiles.push(item.file);
        }
      } catch (err) {
        for (const file of writtenFiles) {
          try {
            fs.unlinkSync(file);
          } catch {
            /* already gone */
          }
        }
        return ok(
          `Refused. Writing the swarm failed: ${err.message}\n\nThe bodies already written were deleted and the index was left untouched.`,
        );
      }

      let committed;
      try {
        committed = withLock(dir, () => {
          const index = readJson(dir, PATHS.briefsIndex, []);
          const replacing = new Set(built.map((b) => b.id));
          writeJson(dir, PATHS.briefsIndex, [...index.filter((b) => !replacing.has(b.id)), ...built.map((b) => b.record)]);
          log(dir, 'SWARM', `${built.length} seams briefed: ${built.map((b) => b.id).join(', ')}`);
          return built.map((b) => ({ id: b.id, record: b.record }));
        });
      } catch (err) {
        for (const file of writtenFiles) {
          try {
            fs.unlinkSync(file);
          } catch {
            /* already gone */
          }
        }
        return ok(`Refused. Indexing the swarm failed: ${err.message}\n\nNothing was indexed.`);
      }

      return ok(
        [
          `## Swarm of ${committed.length} — files disjoint, checks named`,
          '',
          table(
            ['Seam', 'Files', 'Tier', 'Check'],
            committed.map((w) => [w.id, w.record.files.map((f) => `\`${f}\``).join('<br>'), w.record.tier, `\`${w.record.check}\``]),
          ),
          '',
          `Dispatch one employee per seam, all in the same response so they run at once. Ceiling ${SWARM_CAP}; you have ${committed.length}.`,
          '',
          ...committed.map((w) => `### ${w.id}\n\n\`\`\`text\n${dispatchBlock(w.id, w.record.tier, w.record.agent)}\n\`\`\``),
          '',
          'Reconcile in risk order, not completion order: `scope`, then `check`, then the diff, then `ready`. One worker red does not stop the others.',
        ].join('\n'),
      );
    },
  };
}

function shortAge(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return '?';
  if (mins < 60) return `${mins}m`;
  if (mins < 2880) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

// ---------------------------------------------------------------- check

/**
 * Detect the repo's proving commands so the first run is not an empty file.
 * Only well-known, cheap commands are written, and only when the project
 * actually carries the manifest that owns them.
 */
function initConfig(dir) {
  const result = seedStack(dir);
  if (!result.ok) {
    return [
      `No stack seeded: this directory is not a project (${result.reason}).`,
      '',
      'A stack needs a repository or a build manifest to know what to prove. Create .stack/ by hand if you want one anyway.',
    ].join('\n');
  }

  const cfg = config(dir);
  if (!cfg.checks || !cfg.checks.length) {
    return [
      `Seeded ${PATHS.root}/ but no check could be detected.`,
      '',
      'Add the command that proves this repo still works:',
      '',
      '```json',
      '{ "checks": [{ "name": "unit", "command": "npm test", "timeout": 240000 }] }',
      '```',
      '',
      'Until one exists, `ready` answers UNPROVEN rather than GO. That is deliberate.',
    ].join('\n');
  }

  return [
    `Stack ready in ${PATHS.root}/ with ${cfg.checks.length} check(s).`,
    '',
    table(['Name', 'Command'], cfg.checks.map((c) => [c.name, `\`${c.command}\``])),
    '',
    result.created.length || result.updated.length
      ? `Written: ${[...result.created, ...result.updated].join(', ')}`
      : 'Nothing needed writing; this stack was already current.',
    '',
    'Run `check` op=run to prove them, then trim anything slow or redundant. One honest check beats four theatrical ones.',
  ].join('\n');
}

/** The configured checks, with corruption named instead of silently empty. */
function configuredChecks(dir) {
  const cfg = config(dir);
  if (isCorruptConfig(cfg)) return { cfg, corrupt: true, all: [] };
  const all = Array.isArray(cfg.checks) ? cfg.checks.filter((c) => c && c.command) : [];
  return { cfg, corrupt: false, all };
}

/** Run the chosen checks and bind the result to the HEAD it ran at. */
async function executeChecks(dir, chosen) {
  const results = [];
  for (const c of chosen) {
    const r = await commandAsync(c.command, {
      cwd: str(c.cwd) ? path.join(dir, str(c.cwd)) : dir,
      timeout: Number(c.timeout) > 0 ? Number(c.timeout) : 180000,
      env: { ...process.env, CI: process.env.CI ?? '1' },
    });
    results.push({
      name: c.name || c.command,
      command: c.command,
      ok: r.ok,
      code: r.code,
      ms: r.ms,
      tail: r.display.split('\n').slice(-12).join('\n'),
    });
  }
  return { at: stamps().iso, head: head(dir), branch: branch(dir), results };
}

/**
 * What one recorded check run proves. The gate never trusts a stored record —
 * it runs the checks itself — so the only invariant left is that the record it
 * just made covers every configured check. A short record means the run was cut
 * off; a hand-edited `results: []` is caught by the same comparison.
 */
export function checkRecordReasons(record, configured) {
  const results = record.results;
  if (results.length !== configured.length) {
    return [`the check run recorded ${results.length} of ${configured.length} checks; a partial result set is not evidence of green.`];
  }
  const failed = results.filter((r) => !r.ok);
  return failed.length ? [`check is RED: ${failed.map((r) => r.name).join(', ')}.`] : [];
}

function checkTool(dir) {
  return {
    name: 'check',
    description:
      'Run this repo\'s proving commands from .stack/config.json and record the result against the current HEAD. op=run executes one or all; op=show returns the last recorded result without running anything. This is the only green that counts. A check must never read stdin: stdin is closed, so a prompting program sees EOF and exits 0 without proving anything.',
    input: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['init', 'run', 'show'], description: 'Operation. Default run.' },
        name: { type: 'string', description: 'Run only the check with this name.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    execute: async (input) => {
      ensureStack(dir);
      const op = str(input.op) || 'run';
      const previous = tryReadJson(dir, PATHS.checks, null);

      if (op === 'init') return ok(initConfig(dir));

      if (op === 'show') {
        if (previous.error) return ok(`Cannot read ${PATHS.checks}: ${previous.error.message}\n\nRun op=run to replace it.`);
        if (!previous.value) return ok(`No check has run here yet. Configure \`checks\` in ${PATHS.config}, then op=run.`);
        return ok(describeChecks(previous.value, dir));
      }

      const { corrupt, all } = configuredChecks(dir);
      if (corrupt) {
        return ok(`${PATHS.config} is not valid JSON, so there is nothing to run. Fix it, then op=init.`);
      }
      const wanted = str(input.name);
      const chosen = wanted ? all.filter((c) => c.name === wanted) : all;
      if (!selected(chosen)) {
        return ok(
          `No checks to run. Add them to ${PATHS.config}:\n\n\`\`\`json\n{\n  "checks": [\n    { "name": "unit", "command": "npm test", "timeout": 180000 }\n  ]\n}\n\`\`\`\nUntil one exists, readiness is UNPROVEN, not green.`,
        );
      }

      // A hard off switch for hosts that cannot tolerate child processes: the
      // tool prints exactly what it would have run and refuses to claim a green.
      if (process.env.OC_STACKED_NO_EXEC === '1') {
        return ok(
          [
            'Execution disabled by OC_STACKED_NO_EXEC=1. Nothing was run, so nothing is green.',
            '',
            table(['Name', 'Command'], chosen.map((c) => [c.name || c.command, `\`${c.command}\``])),
            '',
            'This is not a substitute for a run: `ready` re-runs the checks itself and will answer NO-GO while execution is disabled.',
          ].join('\n'),
        );
      }

      const record = await executeChecks(dir, chosen);
      writeJson(dir, PATHS.checks, record);
      const failed = record.results.filter((r) => !r.ok);
      log(
        dir,
        failed.length ? 'RED' : 'NOTE',
        failed.length
          ? `check red at ${shortSha(record.head)}: ${failed.map((f) => f.name).join(', ')}`
          : `check green at ${shortSha(record.head)}: ${record.results.map((r) => r.name).join(', ')}`,
      );
      return ok(describeChecks(record, dir));
    },
  };
}

const selected = (arr) => arr && arr.length;

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : 'no-head';
}

function describeChecks(record, dir) {
  const rows = record.results.map((r) => [
    r.ok ? 'pass' : 'FAIL',
    r.name,
    `\`${r.command}\``,
    String(r.code),
    `${(r.ms / 1000).toFixed(1)}s`,
  ]);
  const verdict = record.results.every((r) => r.ok) ? 'GREEN' : 'RED';
  const stale = record.head && head(dir) && record.head !== head(dir);
  return [
    `## ${verdict} — ${shortSha(record.head)} (${record.branch || 'detached'}) at ${record.at}`,
    '',
    table(['Result', 'Check', 'Command', 'Exit', 'Time'], rows),
    '',
    ...record.results.filter((r) => !r.ok).map((r) => `### ${r.name}\n\n\`\`\`text\n${r.tail || '(no output)'}\n\`\`\``),
    stale ? `\n**Stale:** HEAD moved since this run. Re-run before you claim anything.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------- scope

function scopeTool(dir) {
  return {
    name: 'scope',
    description:
      'The surgical-change auditor. Lists every path the working tree touched, compares it with a brief\'s Owns globs, and names what is out of bounds. Use it before claiming a seam is done.',
    input: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Brief id whose Owns globs define the seam.' },
        base: { type: 'string', description: 'Also diff against this ref, e.g. origin/main.' },
      },
      additionalProperties: false,
    },
    execute: async (input) => {
      ensureStack(dir);
      if (!isRepo(dir)) return ok(`Not a git repository: ${dir}. Scope needs git to be honest.`);
      const base = str(input.base) || null;
      const ignored = ignoredPaths(dir);
      const tracked = changedFiles(dir, { base }).filter((f) => !ignored(f.file));

      if (!tracked.length) return ok('The working tree is clean. Nothing to audit.');

      const id = str(input.id);
      const read = indexOf(dir);
      if (id && read.error) return ok(`Refused. ${read.error}`);
      const brief = id ? read.index.find((b) => b.id === id) : null;

      if (!brief) {
        return ok(
          [
            `## ${tracked.length} changed path${tracked.length === 1 ? '' : 's'}${id ? ` (no brief named ${id})` : ''}`,
            '',
            table(['Status', 'Path'], tracked.map((f) => [f.status, `\`${f.file}\``])),
            '',
            id ? `Pass a real brief id to get an ownership verdict.` : 'Pass `id` to get an ownership verdict.',
          ].join('\n'),
        );
      }

      const owns = list(brief.owns);
      const inside = tracked.filter((f) => owns.some((g) => matchesGlob(g, f.file)));
      const outside = tracked.filter((f) => !owns.some((g) => matchesGlob(g, f.file)));

      return ok(
        [
          `## Seam ${brief.id}: ${inside.length} in, ${outside.length} out`,
          '',
          table(['Where', 'Status', 'Path'], [
            ...inside.map((f) => ['in', f.status, `\`${f.file}\``]),
            ...outside.map((f) => ['**OUT**', f.status, `\`${f.file}\``]),
          ]),
          '',
          outside.length
            ? `Out of bounds. Each of these needs its own brief, or a line in the report saying why it belongs. Do not widen quietly.`
            : `Every touched path is inside the brief. Surgical.`,
        ].join('\n'),
      );
    },
  };
}

// ---------------------------------------------------------------- ready

const REPORT_SECTIONS = ['outcome', 'evidence', 'unverified', 'scope', 'lesson'];

/**
 * Headings with their bodies, ignoring fenced code. A report is prose; a fenced
 * block is an example, and a heading inside one is not a section. A heading
 * with no body under it is not a section either.
 */
function reportBodies(text) {
  const bodies = new Map();
  let fenced = false;
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      current = null;
      continue;
    }
    if (fenced) continue;
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      // The brief prints `## Outcome     what shipped, two or three sentences`,
      // so a report may copy that shape. The section is named by its leading
      // word; the description after it is prose, not part of the key.
      current = heading[1].trim().toLowerCase().split(/[\s\u2014\u2013:]/)[0];
      if (!bodies.has(current)) bodies.set(current, []);
      continue;
    }
    if (current) bodies.get(current).push(line);
  }
  const result = new Map();
  for (const [name, lines] of bodies) {
    result.set(name, lines.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim());
  }
  return result;
}

function readyTool(dir) {
  return {
    name: 'ready',
    description:
      'The landing gate. Re-runs the configured checks itself at the current HEAD and checks the named seam against reality: brief exists with a recorded base, report exists and answers Out with real bodies, checks are green now, nothing is out of scope, the tree is committed. Returns GO or NO-GO with each reason named. Never merges anything.',
    input: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Brief id to gate.' },
        lean: {
          type: 'boolean',
          description: 'Skip the report requirement for a small seam. The brief, the check at HEAD, the scope, and a clean tree are still required.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (input) => {
      ensureStack(dir);
      const normalized = seamId(input.id);
      if (normalized.error) return ok(`NO-GO — ${normalized.error}`);
      const id = normalized.id;
      const lean = input.lean === true;

      const read = indexOf(dir);
      if (read.error) return ok(`NO-GO — ${read.error}`);
      const brief = read.index.find((b) => b.id === id);
      const reasons = [];
      const passes = [];

      if (!brief) return ok(`NO-GO — no brief named \`${id}\`. A seam with no contract cannot land.`);

      passes.push(`brief: ${PATHS.briefs}/${id}.md`);

      if (!brief.agent) {
        reasons.push(
          `seam names no archetype: re-brief it with \`agent\` from routing.json. Until then the dispatch block says \`Agent: unassigned\` and nobody owns this work.`,
        );
      }

      const reportFile = path.join(dir, PATHS.reports, `${id}.md`);
      if (!fs.existsSync(reportFile)) {
        if (lean) {
          passes.push('lean: no report required for this seam');
        } else {
          reasons.push(`report missing: write \`.stack/reports/${id}.md\` before asking to land, or gate with lean for a small seam.`);
        }
      } else {
        const report = fs.readFileSync(reportFile, 'utf8');
        const bodies = reportBodies(report);
        for (const section of REPORT_SECTIONS) {
          const body = bodies.get(section);
          if (body === undefined) {
            reasons.push(`report has no \`${section}\` section.`);
          } else if (!body.replace(/[\s#>*_`\-]/g, '')) {
            reasons.push(`report's \`${section}\` section has no body; a heading is not evidence.`);
          }
        }
        if (/Unverified:\s*(none|_none_)/i.test(report)) passes.push('report declares nothing unverified');
      }

      const currentHead = head(dir);
      const { corrupt, all } = configuredChecks(dir);
      if (corrupt) {
        reasons.push(`${PATHS.config} is not valid JSON, so no check can be trusted. Fix it, then run \`check\` op=init.`);
      } else if (!all.length) {
        reasons.push(`no proving check is configured in ${PATHS.config}. Readiness without a command is UNPROVEN, not green.`);
      } else if (process.env.OC_STACKED_NO_EXEC === '1') {
        reasons.push(
          'execution is disabled by OC_STACKED_NO_EXEC=1, so this gate cannot re-run the checks. Readiness is UNPROVEN.',
        );
      } else {
        // The gate re-runs the checks through the same path as `check op=run`.
        // A checks.json a worker can write is not evidence, so the record is
        // replaced here, and what it proves is decided by checkRecordReasons.
        const record = await executeChecks(dir, all);
        writeJson(dir, PATHS.checks, record);
        const proven = checkRecordReasons(record, all);
        if (proven.length) {
          reasons.push(...proven);
        } else if (record.head !== currentHead) {
          reasons.push(`checks ran at ${shortSha(record.head)} but HEAD is ${shortSha(currentHead)}. Re-run at the head you want to land.`);
        } else {
          passes.push(`checks re-run green at ${shortSha(record.head)}: ${record.results.map((r) => r.name).join(', ')}`);
        }
      }

      if (isRepo(dir)) {
        const base = str(brief.head) || null;
        const ignored = ignoredPaths(dir);
        const owns = list(brief.owns);
        const exact = list(brief.files).map((f) => f.replace(/\\/g, '/').toLowerCase());
        const allowed = (f) => {
          const p = f.replace(/\\/g, '/');
          if (exact.length) return exact.includes(p.toLowerCase());
          return owns.some((g) => matchesGlob(g, p));
        };

        // One status call for branch, HEAD, and the working tree.
        const state = snapshot(dir);

        // 1. The working tree must be committed. A gate that reads only the
        //    working tree says GO on work committed outside the seam, which is
        //    the exact false green this tool exists to catch.
        const dirtyAll = state.files;
        const dirty = dirtyAll.filter((f) => !ignored(f.file));
        if (dirty.length) {
          reasons.push(`uncommitted work: ${dirty.map((f) => f.file).join(', ')}. Commit it, then gate again.`);
        }

        // 2. The committed range since the brief was written must be inside the
        //    seam, on exact files when they were declared. No base, or a base git
        //    cannot read, is a refusal: scope would be a guess.
        let committedAll = [];
        if (!base) {
          reasons.push(
            'no base commit recorded on this brief. Without it the gate cannot separate this seam\'s work from everyone else\'s; re-brief the seam at a known HEAD.',
          );
        } else {
          const committed = committedPaths(dir, base);
          if (committed === null) {
            reasons.push(
              `could not read the committed range ${shortSha(base)}..${shortSha(state.head)}; git refused. Without it the scope is unknown, so nothing lands.`,
            );
          } else {
            committedAll = committed;
            const inScope = committed.filter((f) => !ignored(f));
            const outside = inScope.filter((f) => !allowed(f));
            if (outside.length) {
              reasons.push(
                `committed outside this seam since ${shortSha(base)}: ${outside.join(', ')}. Move it to its own brief, or explain it in the report and widen the brief.`,
              );
            } else if (inScope.length) {
              passes.push(`committed diff inside the seam: ${shortSha(base)}..${shortSha(state.head)} (${inScope.length} path${inScope.length === 1 ? '' : 's'})`);
            } else {
              passes.push(`no committed change since ${shortSha(base)}`);
            }
          }
        }

        // 3. The proving config is trusted executable content. If it moved since
        //    the brief began, a worker could have made the check pass by editing
        //    the check, which is the one edit that must never be silent. This is
        //    checked before the ignore list, which exists to silence state churn.
        const tampered = [...dirtyAll.map((f) => f.file), ...committedAll].filter(
          (f) => f.replace(/\\/g, '/') === PATHS.config,
        );
        if (tampered.length) {
          reasons.push(
            `${PATHS.config} changed since this seam began. Inspect it, run \`check\` again, and confirm the commands are honest before gating.`,
          );
        }

        if (!dirty.length && !reasons.length) passes.push(`tree clean at ${shortSha(state.head)} on ${state.branch || 'detached'}`);
      }

      const verdict = reasons.length ? 'NO-GO' : 'GO';
      const text = [
        `## ${verdict} — seam ${id}`,
        '',
        ...passes.map((p) => `- pass · ${p}`),
        ...reasons.map((r) => `- **fail** · ${r}`),
        '',
        verdict === 'GO'
          ? 'Land it: one commit, plain words, the check output in the message body. Then mark the seam landed and log it.'
          : 'Nothing lands on a named reason. Fix the reason, not the wording.',
      ].join('\n');

      log(dir, verdict === 'GO' ? 'READY' : 'RED', `${id}: ${verdict}`);
      return ok(text);
    },
  };
}

// ---------------------------------------------------------------- clean

/** A suggestion for junk this tool names but never deletes, by name. */
function junkSuggestion(p) {
  if (/(Thumbs\.db|\.DS_Store)$/i.test(p)) return 'an OS artifact: delete it and add the name to `.gitignore`';
  if (/\.(bak|orig|rej)$/i.test(p)) return 'a merge or edit leftover: read it, then delete it';
  if (/\.log$/i.test(p)) return 'run output: delete it, or keep it out of the commit';
  return 'a crash leftover: delete it';
}

function cleanTool(dir) {
  return {
    name: 'clean',
    description:
      "The closing sweep. op=sweep (default) removes only artifacts oc-stacked itself created under .stack/: atomic-write *.tmp, the state lock once it is 10 minutes stale, plugin.log, and any empty directory under it (the briefs/reports/state scaffolding is kept). Nothing outside .stack is touched and no symlink is followed. op=report changes nothing: it lists what sweep would remove, plus junk in the working tree that oc-stacked did not create (*.log, *.tmp, *.bak, Thumbs.db, .DS_Store, *.orig, *.rej) with a suggestion for each, and never deletes them. A sweep that removes nothing says so plainly; that is the normal case.",
    input: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['sweep', 'report'], description: 'Operation. Default: sweep.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    execute: async (input) => {
      const op = str(input.op) || 'sweep';
      if (op !== 'sweep' && op !== 'report') return ok(`Unknown op \`${op}\`. Use \`sweep\` or \`report\`.`);

      const junk = junkPaths(dir);

      if (op === 'report') {
        const { removed, kept } = sweepStack(dir);
        const lines = ['## Clean — report', ''];
        lines.push(
          removed.length
            ? table(['Would remove', 'Why'], removed.map((r) => [`\`${r.path}\``, r.why]))
            : 'Nothing to remove. The stack holds only its own live files.',
        );
        if (kept.length) lines.push('', table(['Kept', 'Why'], kept.map((r) => [`\`${r.path}\``, r.why])));
        lines.push('', '### Found, not mine', '');
        lines.push(
          junk.length
            ? table(['Path', 'What to do'], junk.map((p) => [`\`${p}\``, junkSuggestion(p)]))
            : 'None. The working tree holds nothing that looks like junk.',
        );
        lines.push('', `Nothing here was deleted. \`op=sweep\` removes only the stack's own leftovers.`);
        return ok(lines.join('\n'));
      }

      const { removed, kept } = sweepStack(dir, { apply: true });
      const lines = ['## Clean — sweep', ''];
      lines.push(
        removed.length
          ? table(['Removed', 'Why'], removed.map((r) => [`\`${r.path}\``, r.why]))
          : 'Nothing to remove. The stack is clean.',
      );
      if (kept.length) lines.push('', table(['Kept', 'Why'], kept.map((r) => [`\`${r.path}\``, r.why])));
      if (removed.length) lines.push('', `Removed ${removed.length} item(s) this plugin created and no longer needs.`);
      if (junk.length) {
        lines.push(
          '',
          `Found but not mine: ${junk.length} junk-looking path(s) the stack did not create. None were touched; \`op=report\` names them.`,
        );
      }
      return ok(lines.join('\n'));
    },
  };
}

// ---------------------------------------------------------------- export

export function toolDefinitions({ dir }) {
  return [
    ledgerTool(dir),
    briefTool(dir),
    swarmTool(dir),
    checkTool(dir),
    scopeTool(dir),
    readyTool(dir),
    cleanTool(dir),
  ];
}

