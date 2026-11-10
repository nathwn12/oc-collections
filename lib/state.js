// The stack's memory: one directory, plain files, greppable after any compaction.
import fs from 'node:fs';
import path from 'node:path';
import { stamps, table } from './text.js';

export const DIR = '.stack';
export const PATHS = {
  root: DIR,
  ledger: `${DIR}/ledger.md`,
  digest: `${DIR}/digest.md`,
  briefs: `${DIR}/briefs`,
  reports: `${DIR}/reports`,
  state: `${DIR}/state`,
  checks: `${DIR}/state/checks.json`,
  briefsIndex: `${DIR}/state/briefs.json`,
  config: `${DIR}/config.json`,
};

const DEFAULT_CONFIG = {
  checks: [],
  ownership: { ignore: ['.stack/**'] },
};

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Makefile', 'pytest.ini', 'tox.ini'];

export function ensureStack(dir) {
  for (const key of ['root', 'briefs', 'reports', 'state']) {
    fs.mkdirSync(path.join(dir, PATHS[key]), { recursive: true });
  }
  if (!fs.existsSync(path.join(dir, PATHS.config))) {
    fs.writeFileSync(path.join(dir, PATHS.config), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
  }
}

export function config(dir) {
  const file = path.join(dir, PATHS.config);
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function readJson(dir, rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(dir, rel, value) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Append one line to the ledger. Append-only by contract: a correction is a new
 * line, never an edit. Returns the stamped line so the caller can echo it.
 */
export function log(dir, kind, text) {
  ensureStack(dir);
  const now = stamps();
  const line = `- ${now.iso} · ${kind.toUpperCase()} · ${text.replace(/\s+/g, ' ').trim()}`;
  const file = path.join(dir, PATHS.ledger);
  const header = fs.existsSync(file) ? '' : `# Stack ledger\n\nAppend-only. Newest at the bottom. The digest is derived from here.\n\n`;
  fs.appendFileSync(file, `${header}${line}\n`, 'utf8');
  return line;
}

export function ledgerEntries(dir, limit = 40) {
  const file = path.join(dir, PATHS.ledger);
  if (!fs.existsSync(file)) return [];
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- '));
  return lines.slice(Math.max(0, lines.length - limit)).map(parseLedgerLine);
}

function parseLedgerLine(line) {
  const m = line.match(/^- (\S+) · ([A-Z]+) · (.*)$/);
  if (!m) return { at: null, kind: 'NOTE', text: line.replace(/^- /, '') };
  return { at: m[1], kind: m[2], text: m[3] };
}

// ---------------------------------------------------------------- seeding

/** A directory is a project if it has a repository or a build manifest. */
export function isProject(dir) {
  if (fs.existsSync(path.join(dir, '.git'))) return true;
  return MANIFESTS.some((m) => fs.existsSync(path.join(dir, m)));
}

/**
 * The repo's proving commands, detected from its own manifests. Only cheap,
 * well-known commands, and only the ones the project actually declares.
 */
export function detectChecks(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
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
  return found.slice(0, 4);
}

/**
 * Make `.stack/` exist and be useful, without ever destroying what is there.
 *
 * Missing -> create the directories, the config with detected checks, the
 * ledger header, and a first digest. Present -> add any check the manifests now
 * declare that the config does not, union the ignore list, and refresh the
 * digest when the ledger is newer. Custom checks, notes, briefs and reports are
 * never touched.
 */
export function seedStack(dir, { quiet = true } = {}) {
  if (!isProject(dir)) return { ok: false, reason: 'not a project', created: [] };

  const created = [];
  const updated = [];
  ensureStack(dir);
  if (!fs.existsSync(path.join(dir, PATHS.ledger))) created.push(PATHS.ledger);

  const cfgFile = path.join(dir, PATHS.config);
  const cfg = config(dir);
  const detected = detectChecks(dir);
  const before = JSON.stringify({ ...cfg, checks: cfg.checks, ownership: cfg.ownership });
  const mergedChecks = [...(Array.isArray(cfg.checks) ? cfg.checks : [])];
  for (const check of detected) {
    if (!mergedChecks.some((c) => c && (c.command === check.command || c.name === check.name))) mergedChecks.push(check);
  }
  const ignore = new Set([...(cfg.ownership?.ignore || []), ...DEFAULT_CONFIG.ownership.ignore]);
  const next = {
    ...cfg,
    checks: mergedChecks,
    ownership: { ...(cfg.ownership || {}), ignore: [...ignore] },
  };
  if (JSON.stringify(next) !== before || !fs.existsSync(cfgFile)) {
    writeJson(dir, PATHS.config, next);
    if (fs.existsSync(cfgFile)) updated.push(PATHS.config);
    else created.push(PATHS.config);
  }

  if (created.includes(PATHS.ledger)) {
    log(dir, 'SEED', `stack seeded in ${path.basename(dir)} with ${next.checks.length} check(s)`);
  }

  const digestFile = path.join(dir, PATHS.digest);
  const ledgerFile = path.join(dir, PATHS.ledger);
  const stale =
    !fs.existsSync(digestFile) ||
    (fs.existsSync(ledgerFile) && fs.statSync(ledgerFile).mtimeMs > fs.statSync(digestFile).mtimeMs);
  if (stale) {
    renderDigest(dir);
    if (fs.existsSync(digestFile)) created.includes(PATHS.digest) || updated.push(PATHS.digest);
  }

  return { ok: true, created: [...new Set(created)], updated: [...new Set(updated)], checks: next.checks.length };
}

/** The digest, derived from the ledger and the brief index. Never hand-maintained. */
export function renderDigest(dir) {
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
    .filter((e) => ['READY', 'LANDED', 'RED', 'NOTE', 'RULING', 'SEED'].includes(e.kind))
    .slice(-8)
    .reverse();

  const briefs = readJson(dir, PATHS.briefsIndex, []);
  const live = briefs.filter((b) => b.status !== 'landed');

  // The objective is the one fact that must survive compaction. The lead logs it
  // at intake; if the digest does not render it, the stack can execute a plan
  // flawlessly toward a goal nobody can restate.
  const intake = [...entries].reverse().find((e) => e.kind === 'INTAKE' || /^intake:/i.test(e.text));

  const lines = [
    `# Digest — ${stamps().local}`,
    '',
    'Rewritten by the lead. Newest first. An empty section is a true statement.',
    '',
    ...(intake ? [`**Objective** — ${intake.text.replace(/^intake:\s*/i, '')}`, ''] : []),
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

  // Three of the four seats leave an artifact. The auditor's verdict is the one
  // that used to live only in chat, which means "landed" could quietly mean
  // "landed and never reviewed".
  const audits = entries.filter((e) => e.kind === 'AUDIT');
  const unaudited = briefs.filter((b) => b.status === 'landed' && !audits.some((a) => a.text.includes(b.id)));
  if (unaudited.length) {
    lines.push('', '## Landed, unaudited', '');
    lines.push(unaudited.map((b) => `- ${b.id} landed without a recorded verdict. Run \`stacked-audit\` and log it.`).join('\n'));
  }

  const text = `${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(dir, PATHS.digest), text, 'utf8');
  return `${text}\n_Written to ${PATHS.digest}._`;
}

export { DEFAULT_CONFIG };
