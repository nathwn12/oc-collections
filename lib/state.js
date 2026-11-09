// The stack's memory: one directory, plain files, greppable after any compaction.
import fs from 'node:fs';
import path from 'node:path';
import { stamps } from './text.js';

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
  // Ten is the host's hard ceiling for concurrent subagents. A ceiling is not a
  // target: dispatch only what you can reconcile.
  dispatch: { live: 10, cap: 10 },
};

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

export { DEFAULT_CONFIG };
