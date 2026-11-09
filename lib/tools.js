// The five local tools. No network, no MCP, no daemons: files and git only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchesGlob, slug, stamps, table } from './text.js';
import { git, head, branch, isRepo, changedFiles } from './git.js';
import {
  PATHS,
  config,
  ensureStack,
  log,
  ledgerEntries,
  readJson,
  writeJson,
} from './state.js';

const ok = (text) => ({ content: text });
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) =>
  Array.isArray(v) ? v.map(str).filter(Boolean) : str(v).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------- ledger

function ledgerTool(dir) {
  return {
    name: 'ledger',
    description:
      'The stack memory. op=log appends one stamped line (never edits); op=tail reads the last lines; op=digest rewrites .stack/digest.md from the ledger and the brief index and returns it. Kinds: NOTE, ASK, ANSWER, BRIEF, READY, LANDED, RED, RULING, LESSON.',
    input: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['log', 'tail', 'digest'], description: 'Operation. Default: tail.' },
        kind: { type: 'string', description: 'Ledger kind for op=log, e.g. NOTE, ASK, READY, LANDED.' },
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

function renderDigest(dir) {
  ensureStack(dir);
  const entries = ledgerEntries(dir, 120);
  const now = Date.now();
  const ageOf = (iso) => {
    if (!iso) return 'unknown';
    const mins = Math.round((now - Date.parse(iso)) / 60000);
    if (Number.isNaN(mins)) return 'unknown';
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m`;
    if (mins < 2880) return `${Math.round(mins / 60)}h`;
    return `${Math.round(mins / 1440)}d`;
  };

  const asks = entries.filter((e) => e.kind === 'ASK');
  const answers = entries.filter((e) => e.kind === 'ANSWER');
  const open = asks.filter((a) => !answers.some((x) => Date.parse(x.at) > Date.parse(a.at))).slice(-5);

  const fresh = entries
    .filter((e) => ['READY', 'LANDED', 'RED', 'NOTE', 'RULING'].includes(e.kind))
    .slice(-8)
    .reverse();

  const briefs = readJson(dir, PATHS.briefsIndex, []);
  const live = briefs.filter((b) => b.status !== 'landed');

  const lines = [
    `# Digest — ${stamps().local}`,
    '',
    'Rewritten by the lead. Newest first. An empty section is a true statement.',
    '',
    '## Needs you',
    '',
  ];
  lines.push(
    open.length
      ? open.map((a) => `- ${a.text} _(${ageOf(a.at)} ago)_`).join('\n')
      : '_Nothing. The owner has no open decision._',
  );
  lines.push('', '## New', '');
  lines.push(
    fresh.length
      ? fresh.map((e) => `- **${e.kind}** · ${ageOf(e.at)} · ${e.text}`).join('\n')
      : '_Nothing landed yet._',
  );
  lines.push('', '## In progress', '');
  lines.push(
    live.length
      ? table(
          ['Seam', 'Owns', 'State', 'Age'],
          live.map((b) => [
            `[${b.id}](${PATHS.briefs}/${b.id}.md)`,
            (b.owns || []).slice(0, 3).join('<br>') || '—',
            b.status || 'briefed',
            ageOf(b.at),
          ]),
        )
      : '_No briefed seam is open._',
  );
  lines.push('', '## Stall watch', '');
  const stalled = live.filter((b) => Date.parse(b.at) && now - Date.parse(b.at) > 6 * 3600_000);
  lines.push(
    stalled.length
      ? stalled.map((b) => `- ${b.id} has not moved in ${ageOf(b.at)}. Chase it, close it, or kill it.`).join('\n')
      : '_No seam is older than six hours._',
  );

  const text = `${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(dir, PATHS.digest), text, 'utf8');
  return `${text}\n_Written to ${PATHS.digest}._`;
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
  expert: 'Design judgement is the work; do not rush it.',
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

/** One writer for brief bodies, so `brief` and `swarm` cannot drift apart. */
function writeBrief(dir, spec) {
  const id = str(spec.id) || slug(str(spec.title));
  const title = str(spec.title) || id;
  const owns = list(spec.owns);
  const files = list(spec.files).map((f) => f.replace(/\\/g, '/'));
  const avoid = list(spec.avoid);
  const read = list(spec.read);
  const tier = str(spec.tier) || 'standard';

  const body = [
    `# Seam ${id}: ${title}`,
    '',
    `**Owner of this seam:** one employee. **Written by:** the lead. **State:** briefed.`,
    '',
    '## Why now',
    '',
    str(spec.why) || '_Not stated. The employee must not invent it._',
    '',
    '## Out',
    '',
    str(spec.out),
    '',
    '## Check',
    '',
    '```text',
    str(spec.check),
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

  const file = path.join(dir, PATHS.briefs, `${id}.md`);
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, body, 'utf8');

  const index = readJson(dir, PATHS.briefsIndex, []);
  const record = {
    id,
    title,
    out: str(spec.out),
    check: str(spec.check),
    owns,
    files,
    tier,
    status: 'briefed',
    at: stamps().iso,
  };
  writeJson(dir, PATHS.briefsIndex, [...index.filter((b) => b.id !== id), record]);
  log(dir, 'BRIEF', `${existed ? 'rewrote' : 'wrote'} ${id}: ${title}`);
  return { id, title, file, existed, record };
}

const dispatchBlock = (id, tier) =>
  `Seam: ${id}\nBrief: ${PATHS.briefs}/${id}.md\nTier: ${tier || 'standard'}\nReport: ${PATHS.reports}/${id}.md\n\nRead the brief first; it is your requirements. Build nothing outside its Files. Return one paragraph: outcome, commits, check result, concerns.`;

function briefTool(dir) {
  return {
    name: 'brief',
    description:
      'The seam contract. op=new writes .stack/briefs/<id>.md and indexes it; op=list shows every seam; op=get prints one; op=status moves a seam (briefed, building, ready, landed, killed). A brief missing Out, Check or Owns is refused. Declaring `files` also refuses a collision with any live seam that already owns one of those exact files.',
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
        why: { type: 'string', description: 'Why this seam matters now. One line.' },
        status: { type: 'string', description: 'New status for op=status.' },
        force: { type: 'boolean', description: 'Mark landed without a recorded GO. The refusal is logged.' },
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

        const id = str(input.id) || slug(str(input.title));
        const clashes = collisions({ id, files: input.files, owns: input.owns }, readJson(dir, PATHS.briefsIndex, []));
        if (clashes.length) return ok(clashReport(clashes));

        const { tier } = writeBrief(dir, { ...input, id });
        return ok(
          `Brief written: ${PATHS.briefs}/${id}.md\n\nDispatch one employee with:\n\`\`\`text\n${dispatchBlock(id, tier)}\n\`\`\``,
        );
      }

      if (op === 'get') {
        const id = str(input.id);
        const file = path.join(dir, PATHS.briefs, `${id}.md`);
        if (!id || !fs.existsSync(file)) return ok(`No brief named \`${id || '(empty)'}\`. Try op=list.`);
        return ok(fs.readFileSync(file, 'utf8'));
      }

      if (op === 'status') {
        const id = str(input.id);
        const status = str(input.status);
        if (!id || !status) return ok('op=status needs `id` and `status`.');
        const index = readJson(dir, PATHS.briefsIndex, []);
        const found = index.find((b) => b.id === id);
        if (!found) return ok(`No brief named \`${id}\`.`);

        // A seam is landed only behind a recorded GO. Otherwise the digest would
        // quietly claim work the gate never approved, which is the exact failure
        // this system exists to prevent.
        if (status === 'landed' && !input.force) {
          const verdict = lastVerdict(dir, id);
          if (!verdict || verdict.kind !== 'READY') {
            const last = verdict ? `the last gate said **${verdict.kind}**: ${verdict.text}` : 'no gate has run for this seam';
            return ok(
              `Refused. ${id} cannot be marked landed: ${last}.\n\nRun \`ready\` with the id and land only on GO. If the gate cannot see something it needs, pass \`force: true\` and say why in the ledger; the refusal is recorded either way.`,
            );
          }
          log(dir, 'LANDED', `${id} behind ${verdict.at}`);
        } else if (status === 'landed' && input.force) {
          log(dir, 'RULING', `${id} landed without a GO, forced by the lead`);
        }

        found.status = status;
        found.at = stamps().iso;
        writeJson(dir, PATHS.briefsIndex, index);
        log(dir, status.toUpperCase(), `${id}`);
        return ok(`${id} → ${status}.`);
      }

      const index = readJson(dir, PATHS.briefsIndex, []);
      if (!index.length) return ok('No briefs yet. op=new writes the first one.');
      const rows = index.slice(-(Number(input.limit) > 0 ? Number(input.limit) : 20)).reverse();
      return ok(
        table(
          ['Id', 'Title', 'Files', 'Tier', 'State', 'Age'],
          rows.map((b) => [b.id, b.title, String((b.files || []).length), b.tier, b.status, shortAge(b.at)]),
        ),
      );
    },
  };
}

/** The last gate verdict recorded for a seam, straight from the ledger. */
function lastVerdict(dir, id) {
  const entries = ledgerEntries(dir, 300);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if ((entry.kind === 'READY' || entry.kind === 'RED') && entry.text.startsWith(`${id}:`)) return entry;
  }
  return null;
}

function clashReport(clashes) {  return [
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
      'Atomic fan-out. Takes 2 to 10 seams, proves their exact files are disjoint (and clear of every live brief), writes every brief in one call, and returns one dispatch prompt per employee. Refuses the whole swarm if any seam is incomplete, duplicated, or shares a file. This is the only way to fan out more than one seam.',
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
        const id = str(s.id) || slug(str(s.title) || `seam-${i + 1}`);
        if (!str(s.title)) holes.push(`- seam ${i + 1}: no title`);
        if (!str(s.out)) holes.push(`- ${id}: no \`out\``);
        if (!str(s.check)) holes.push(`- ${id}: no \`check\`. A seam whose proof you cannot name is not ready to run.`);
        if (!list(s.files).length) holes.push(`- ${id}: no \`files\`. Disjointness is proved on exact paths.`);
        return {
          id,
          title: str(s.title) || id,
          out: str(s.out),
          check: str(s.check),
          files: list(s.files).map((f) => f.replace(/\\/g, '/')),
          owns: list(s.owns).length ? list(s.owns) : list(s.files).map((f) => f.replace(/\\/g, '/')),
          tier: str(s.tier) || 'standard',
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
      const index = readJson(dir, PATHS.briefsIndex, []);
      const incoming = new Set(ids);
      const external = [];
      for (const seam of prepared) {
        for (const hit of collisions(seam, index.filter((b) => !incoming.has(b.id)))) {
          external.push(`- \`${seam.id}\` vs live \`${hit.id}\`: ${hit.why} (${hit.files.join(', ')})`);
        }
      }
      if (external.length) {
        return ok(
          ['Refused. These seams collide with work already in flight.', '', ...external, '', 'Land or kill the older seam first. Nothing was written.'].join('\n'),
        );
      }

      const written = prepared.map((seam) => writeBrief(dir, seam));
      log(dir, 'SWARM', `${written.length} seams briefed: ${written.map((w) => w.id).join(', ')}`);

      return ok(
        [
          `## Swarm of ${written.length} — files disjoint, checks named`,
          '',
          table(
            ['Seam', 'Files', 'Tier', 'Check'],
            written.map((w) => [w.id, w.record.files.map((f) => `\`${f}\``).join('<br>'), w.record.tier, `\`${w.record.check}\``]),
          ),
          '',
          `Dispatch one employee per seam, all in the same response so they run at once. Ceiling ${SWARM_CAP}; you have ${written.length}.`,
          '',
          ...written.map((w) => `### ${w.id}\n\n\`\`\`text\n${dispatchBlock(w.id, w.record.tier)}\n\`\`\``),
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
  const has = (f) => fs.existsSync(path.join(dir, f));
  const cfg = config(dir);
  const found = [];
  const add = (name, command, timeout = 240000) => {
    if (!found.some((c) => c.command === command)) found.push({ name, command, timeout });
  };

  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const scripts = pkg.scripts || {};
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm';
      const verb = pm === 'npm' ? 'npm run' : pm;
      for (const name of ['test', 'typecheck', 'lint', 'build']) {
        if (scripts[name]) add(name, `${verb} ${name}`);
      }
    } catch {
      /* a broken package.json is not this tool's problem */
    }
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('tox.ini') || has('tests')) add('pytest', 'python -m pytest -q');
  if (has('go.mod')) add('go', 'go test ./...');
  if (has('Cargo.toml')) add('cargo', 'cargo test');
  if (has('Makefile')) {
    try {
      if (/^test:/m.test(fs.readFileSync(path.join(dir, 'Makefile'), 'utf8'))) add('make', 'make test');
    } catch {
      /* unreadable Makefile, skip */
    }
  }

  const next = { ...cfg, checks: found.slice(0, 4) };
  writeJson(dir, PATHS.config, next);
  log(dir, 'NOTE', `config initialised with ${next.checks.length} check(s)`);

  if (!next.checks.length) {
    return [
      `No check could be detected here. ${PATHS.config} now exists with an empty list.`,
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
    `Detected ${next.checks.length} check(s) and wrote ${PATHS.config}:`,
    '',
    table(['Name', 'Command'], next.checks.map((c) => [c.name, `\`${c.command}\``])),
    '',
    'Run `check` op=run to prove them, then trim anything that is slow or redundant. One honest check beats four theatrical ones.',
  ].join('\n');
}

function checkTool(dir) {
  return {
    name: 'check',
    description:
      'Run this repo\'s proving commands from .stack/config.json and record the result against the current HEAD. op=run executes one or all; op=show returns the last recorded result without running anything. This is the only green that counts.',
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
      const previous = readJson(dir, PATHS.checks, null);

      if (op === 'init') return ok(initConfig(dir));

      if (op === 'show') {
        if (!previous) return ok(`No check has run here yet. Configure \`checks\` in ${PATHS.config}, then op=run.`);
        return ok(describeChecks(previous, dir));
      }

      const cfg = config(dir);
      const all = Array.isArray(cfg.checks) ? cfg.checks.filter((c) => c && c.command) : [];
      const wanted = str(input.name);
      const chosen = wanted ? all.filter((c) => c.name === wanted) : all;
      if (!selected(chosen)) {
        return ok(
          `No checks to run. Add them to ${PATHS.config}:\n\n\`\`\`json\n{\n  "checks": [\n    { "name": "unit", "command": "npm test", "timeout": 180000 }\n  ]\n}\n\`\`\`\nUntil one exists, readiness is UNPROVEN, not green.`,
        );
      }

      const results = [];
      for (const c of chosen) {
        const started = Date.now();
        const run = spawnSync(c.command, {
          cwd: str(c.cwd) ? path.join(dir, str(c.cwd)) : dir,
          shell: true,
          timeout: Number(c.timeout) > 0 ? Number(c.timeout) : 180000,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, CI: process.env.CI ?? '1' },
        });
        const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
        const timedOut = run.error?.code === 'ETIMEDOUT';
        results.push({
          name: c.name || c.command,
          command: c.command,
          ok: !timedOut && run.status === 0,
          code: timedOut ? 'timeout' : run.status,
          ms: Date.now() - started,
          tail: output.split('\n').slice(-12).join('\n'),
        });
      }

      const record = { at: stamps().iso, head: head(dir), branch: branch(dir), results };
      writeJson(dir, PATHS.checks, record);
      const failed = results.filter((r) => !r.ok);
      log(
        dir,
        failed.length ? 'RED' : 'NOTE',
        failed.length
          ? `check red at ${shortSha(record.head)}: ${failed.map((f) => f.name).join(', ')}`
          : `check green at ${shortSha(record.head)}: ${results.map((r) => r.name).join(', ')}`,
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
    String(r.code),
    `${(r.ms / 1000).toFixed(1)}s`,
  ]);
  const verdict = record.results.every((r) => r.ok) ? 'GREEN' : 'RED';
  const stale = record.head && head(dir) && record.head !== head(dir);
  return [
    `## ${verdict} — ${shortSha(record.head)} (${record.branch || 'detached'}) at ${record.at}`,
    '',
    table(['Result', 'Check', 'Exit', 'Time'], rows),
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
      const files = changedFiles(dir, { base });
      const cfg = config(dir);
      const ignore = list(cfg?.ownership?.ignore);
      const tracked = files.filter((f) => !ignore.some((g) => matchesGlob(g, f.file)) && !f.file.startsWith('.stack/'));

      if (!tracked.length) return ok('The working tree is clean. Nothing to audit.');

      const id = str(input.id);
      const briefs = readJson(dir, PATHS.briefsIndex, []);
      const brief = id ? briefs.find((b) => b.id === id) : null;

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

function readyTool(dir) {
  return {
    name: 'ready',
    description:
      'The landing gate. Checks the named seam against reality: brief exists, report exists and answers Out, checks are green at the current HEAD, nothing is out of scope, the tree is committed. Returns GO or NO-GO with each reason named. Never merges anything.',
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
      const id = str(input.id);
      const lean = input.lean === true;
      const briefs = readJson(dir, PATHS.briefsIndex, []);
      const brief = briefs.find((b) => b.id === id);
      const reasons = [];
      const passes = [];

      if (!brief) return ok(`NO-GO — no brief named \`${id}\`. A seam with no contract cannot land.`);

      passes.push(`brief: ${PATHS.briefs}/${id}.md`);

      const reportFile = path.join(dir, PATHS.reports, `${id}.md`);
      if (!fs.existsSync(reportFile)) {
        if (lean) {
          passes.push('lean: no report required for this seam');
        } else {
          reasons.push(`report missing: write \`.stack/reports/${id}.md\` before asking to land, or gate with lean for a small seam.`);
        }
      } else {
        const report = fs.readFileSync(reportFile, 'utf8');
        for (const section of ['Outcome', 'Evidence', 'Unverified', 'Scope', 'Lesson']) {
          if (!new RegExp(`^#+\\s*${section}`, 'im').test(report)) reasons.push(`report has no \`${section}\` section.`);
        }
        if (/Unverified:\s*(none|_none_)/i.test(report)) passes.push('report declares nothing unverified');
      }

      const recorded = readJson(dir, PATHS.checks, null);
      if (!recorded) {
        reasons.push(`no check has run. Run the check tool first; readiness without evidence is UNPROVEN.`);
      } else if (!recorded.results.every((r) => r.ok)) {
        reasons.push(`check is RED: ${recorded.results.filter((r) => !r.ok).map((r) => r.name).join(', ')}.`);
      } else if (recorded.head !== head(dir)) {
        reasons.push(`check ran at ${shortSha(recorded.head)} but HEAD is ${shortSha(head(dir))}. Re-run at the head you want to land.`);
      } else {
        passes.push(`checks green at ${shortSha(recorded.head)}: ${recorded.results.map((r) => r.name).join(', ')}`);
      }

      if (isRepo(dir)) {
        const files = changedFiles(dir, {})
          .filter((f) => !f.file.startsWith('.stack/'))
          .filter((f) => !list(config(dir)?.ownership?.ignore).some((g) => matchesGlob(g, f.file)));
        if (files.length) {
          const owns = list(brief.owns);
          const outside = files.filter((f) => !owns.some((g) => matchesGlob(g, f.file)));
          if (outside.length) reasons.push(`uncommitted or out-of-scope paths: ${outside.map((f) => f.file).join(', ')}.`);
          else reasons.push(`uncommitted work in the seam: ${files.map((f) => f.file).join(', ')}. Commit it.`);
        } else {
          passes.push(`tree clean at ${shortSha(head(dir))} on ${branch(dir)}`);
        }
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

// ---------------------------------------------------------------- export

export function toolDefinitions({ dir }) {
  return [
    ledgerTool(dir),
    briefTool(dir),
    swarmTool(dir),
    checkTool(dir),
    scopeTool(dir),
    readyTool(dir),
  ];
}
