// The nstack board seam - the only place in this package that touches
// <repo>/.nstack/board.yaml.
//
// Contract:
// - The file is authoritative. Nothing caches rows or remembers a claim.
// - A read is strict: content it does not understand is a typed error, never a
//   shorter row list, because a tolerant reader plus a whole-file writer is how
//   a board loses rows silently.
// - A write is atomic: temp file in the same directory, fsync, then rename.
// - A claim holds an exclusive lock for the whole read-modify-write, and the
//   lock carries a token so a release only ever removes its own lock.
// - A closed row is history, not a lock: the caller's own closed rows are dropped
//   on its next claim, and other sessions' closed rows are capped so the board
//   can never grow into the cap that refuses every claim.
// - Top-level keys and per-row keys the contract does not model are preserved.
import fs from 'node:fs';
import path from 'node:path';

const BOARD_DIR = '.nstack';
const BOARD_NAME = 'board.yaml';
const LOCK_TTL_MS = 15000; // A lock older than this is presumed abandoned.
const LOCK_WAIT_MS = 1000; // How long a claim waits for the lock before failing.
export const BOARD_VERSION = 1;
export const BOARD_FIELDS = ['session', 'state', 'ticket', 'seam', 'since'];
export const BOARD_STATES = ['active', 'parked', 'closed'];
const MAX_BYTES = 256 * 1024;
const MAX_ROWS = 500;
const CLOSED_KEEP = 20; // Closed rows kept as history; the newest survive.

export function defaultBoardFile(directory) {
  const base = typeof directory === 'string' && directory ? directory : process.cwd();
  return path.resolve(base, BOARD_DIR, BOARD_NAME);
}

function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && line[i + 1] === "'") i++;
        else quote = '';
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw) {
  let value = String(raw === undefined || raw === null ? '' : raw).trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      value = value.slice(1, -1);
      if (first === "'") value = value.replaceAll("''", "'");
    }
  }
  return value;
}

// Control characters cannot survive a line-oriented file: a newline would end
// the quoted scalar early and turn the rest of the value into new rows.
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
function quote(value) {
  const clean = String(value === undefined || value === null ? '' : value).replace(UNSAFE, ' ');
  return "'" + clean.replaceAll("'", "''") + "'";
}

function normalizeRow(row) {
  const out = {};
  for (const field of BOARD_FIELDS) out[field] = typeof row[field] === 'string' ? row[field] : '';
  for (const [key, value] of Object.entries(row)) if (!BOARD_FIELDS.includes(key)) out[key] = value;
  return out;
}

// splitFlow: split a flow mapping body on commas that are outside quotes.
function splitFlow(body) {
  const parts = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      current += c;
      if (c === quote) {
        if (quote === "'" && body[i + 1] === "'") { current += body[++i]; continue; }
        quote = '';
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; current += c; continue; }
    if (c === ',') { parts.push(current); current = ''; continue; }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// parseBoard: strict. Returns { ok, rows, version, extra } or an error naming the line.
export function parseBoard(text) {
  const rows = [];
  const extra = [];
  let version = null;
  let sawRowsKey = false;
  let current = null;
  const lines = String(text ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = stripComment(lines[index]);
    if (!line.trim()) continue;
    const lineNo = index + 1;
    const rowStart = /^\s*-\s+(.*)$/.exec(line);
    if (rowStart) {
      current = {};
      rows.push(current);
      const rest = rowStart[1].trim();
      if (rest.startsWith('{')) {
        const body = rest.replace(/^\{/, '').replace(/\}$/, '');
        for (const part of splitFlow(body)) {
          const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(part.trim());
          if (!pair) return { ok: false, error: 'board_unreadable', reason: 'line ' + lineNo + ' has a flow field this board cannot model: ' + part.trim() };
          current[pair[1]] = scalar(pair[2]);
        }
        continue;
      }
      const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(rest);
      if (pair) current[pair[1]] = scalar(pair[2]);
      else if (rest) return { ok: false, error: 'board_unreadable', reason: 'line ' + lineNo + ' is not a row this board can model: ' + line.trim() };
      continue;
    }
    const top = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (top && !/^\s/.test(line)) {
      current = null;
      if (top[1] === 'rows') {
        sawRowsKey = true;
        if (top[2].trim() && top[2].trim() !== '[]') return { ok: false, error: 'board_unreadable', reason: 'line ' + lineNo + ' uses flow style; this board is a block list' };
      } else if (top[1] === 'version') {
        const v = Number(scalar(top[2]));
        if (!Number.isInteger(v)) return { ok: false, error: 'board_unreadable', reason: 'line ' + lineNo + ' has a non-numeric version' };
        version = v;
      } else {
        extra.push({ key: top[1], raw: top[2] });
      }
      continue;
    }
    const field = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (field && (sawRowsKey || rows.length > 0)) {
      if (!current) { current = {}; rows.push(current); }
      current[field[1]] = scalar(field[2]);
      continue;
    }
    return { ok: false, error: 'board_unreadable', reason: 'line ' + lineNo + ' is not a row this board can model: ' + line.trim() };
  }
  if (version !== null && version > BOARD_VERSION) return { ok: false, error: 'board_unreadable', reason: 'board version ' + version + ' is newer than this plugin reads (' + BOARD_VERSION + ')' };
  if (rows.length > MAX_ROWS) return { ok: false, error: 'board_too_large', reason: 'board holds ' + rows.length + ' rows; the cap is ' + MAX_ROWS };
  const normalized = rows.map(normalizeRow);
  const bad = normalized.find((r) => r.seam && !BOARD_STATES.includes(r.state));
  if (bad) return { ok: false, error: 'board_unreadable', reason: 'row for seam "' + bad.seam + '" has state "' + bad.state + '"; allowed: ' + BOARD_STATES.join(', ') };
  return { ok: true, rows: normalized, version: version ?? BOARD_VERSION, extra };
}

export function boardYaml(rows, extra = []) {
  const lines = ['# nstack board - plain YAML, editable by hand; oc-talk only writes rows.', 'version: ' + BOARD_VERSION];
  for (const item of extra) lines.push(item.key + ': ' + item.raw);
  if (!rows.length) { lines.push('rows: []'); return lines.join('\n') + '\n'; }
  lines.push('rows:');
  for (const row of rows) {
    const keys = [...BOARD_FIELDS.filter((k) => k in row), ...Object.keys(row).filter((k) => !BOARD_FIELDS.includes(k))];
    keys.forEach((key, index) => lines.push((index === 0 ? '  - ' : '    ') + key + ': ' + quote(row[key])));
  }
  return lines.join('\n') + '\n';
}

function readBoard(file) {
  const target = file || defaultBoardFile();
  let stat;
  try { stat = fs.statSync(target); }
  catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, rows: [], extra: [], version: BOARD_VERSION, file: target, message: 'no board at ' + target + '; the board is empty' };
    return { ok: false, error: 'board_unreadable', reason: 'cannot read ' + target + ': ' + String((err && err.code) || err) };
  }
  if (stat.size > MAX_BYTES) return { ok: false, error: 'board_too_large', reason: target + ' is ' + stat.size + ' bytes; the cap is ' + MAX_BYTES };
  let text;
  try { text = fs.readFileSync(target, 'utf8'); }
  catch (err) { return { ok: false, error: 'board_unreadable', reason: 'cannot read ' + target + ': ' + String((err && err.code) || err) }; }
  const parsed = parseBoard(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!parsed.ok) return parsed;
  return { ok: true, rows: parsed.rows, extra: parsed.extra, version: parsed.version, file: target };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// lockToken: the content a lock must still carry for its owner to release it.
function lockToken(lock) {
  try { return fs.readFileSync(lock, 'utf8'); }
  catch { return null; }
}

// withLock: exclusive create of a sidecar file that names its owner. A stale
// lock is stolen by rename, so exactly one thief wins. Every branch checks the
// deadline and yields. The token matters on the way out: a lock that was stolen
// and re-taken belongs to someone else, and unlinking it would open a second door.
async function withLock(file, fn) {
  const lock = file + '.lock';
  const token = process.pid + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
  const started = Date.now();
  let handle = null;
  while (handle === null) {
    try { handle = fs.openSync(lock, 'wx'); }
    catch (err) {
      if (!err || err.code !== 'EEXIST') return { ok: false, error: 'board_unwritable', reason: 'cannot take ' + lock + ': ' + String((err && err.code) || err) };
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_TTL_MS) {
          const stolen = lock + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.stale'; // A token holds colons; a Windows name cannot.
          try { fs.renameSync(lock, stolen); fs.unlinkSync(stolen); } catch {}
        }
      } catch {}
      if (Date.now() - started > LOCK_WAIT_MS) return { ok: false, error: 'board_locked', reason: 'another claim holds ' + lock + '; retry' };
      await sleep(10);
    }
  }
  try {
    fs.writeSync(handle, token);
    return await fn();
  }
  finally {
    try { fs.closeSync(handle); } catch {}
    if (lockToken(lock) === token) { try { fs.unlinkSync(lock); } catch {} }
  }
}

// pruneCallerClosed: a session's finished seams are litter the moment it claims
// again, so its own closed rows go. The row it is claiming now is kept.
function pruneCallerClosed(rows, keep) {
  if (!keep) return rows;
  return rows.filter((row) => !(row.session === keep.session && row.state === 'closed' && row.seam !== keep.seam));
}

// pruneRows: closed rows from other sessions are history and are capped, newest
// kept. The row just written is never pruned, whatever its state.
function pruneRows(rows, keep) {
  const closed = rows.filter((row) => row !== keep && row.state === 'closed');
  if (closed.length <= CLOSED_KEEP) return rows;
  const dropped = new Set(closed.slice(0, closed.length - CLOSED_KEEP));
  return rows.filter((row) => !dropped.has(row));
}

// claim: the whole read-modify-write under one lock. decide(rows) returns { rows } or { error, reason }.
async function claim(file, decide) {
  const target = file || defaultBoardFile();
  return withLock(target, () => {
    const board = readBoard(target);
    if (!board.ok) return board;
    const next = decide(board.rows, board.extra);
    if (next.error) return { ok: false, error: next.error, reason: next.reason };
    // Prune before the cap is checked: a board that only grew through history is
    // repaired by the next claim instead of refusing every claim forever.
    const rows = pruneRows(pruneCallerClosed(next.rows, next.row), next.row);
    if (rows.length > MAX_ROWS) return { ok: false, error: 'board_too_large', reason: 'the write would hold ' + rows.length + ' rows; the cap is ' + MAX_ROWS };
    const candidate = boardYaml(rows, next.extra ?? board.extra);
    if (Buffer.byteLength(candidate, 'utf8') > MAX_BYTES) return { ok: false, error: 'board_too_large', reason: 'the write would be ' + Buffer.byteLength(candidate, 'utf8') + ' bytes; the cap is ' + MAX_BYTES };
    const written = writeInner(target, rows, next.extra ?? board.extra);
    if (!written.ok) return written;
    return { ok: true, file: written.file, row: next.row };
  });
}

// writeInner: the atomic write without taking the lock again.
function writeInner(target, rows, extra) {
  const temp = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  let fd;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fd = fs.openSync(temp, 'w');
    fs.writeFileSync(fd, boardYaml(rows, extra), 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    return { ok: true, file: target };
  } catch (err) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    return { ok: false, error: 'board_unwritable', reason: 'cannot write ' + target + ': ' + String((err && err.code) || err) };
  }
}

// planClaim: the claim rule, pure. Returns { rows, row } or { error, reason }.
// A closed row is finished work, not a lock, so a new claim takes it over.
export function planClaim(rows, { caller, seam, state, ticket, now }) {
  if (!caller) return { error: 'bad_request', reason: 'talk_claim needs the calling session id' };
  if (!seam) return { error: 'bad_request', reason: 'seam must be a non-empty string' };
  if (!BOARD_STATES.includes(state)) return { error: 'bad_request', reason: 'state must be one of ' + BOARD_STATES.join(', ') + '; got ' + String(state) };
  const unsafe = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
  if (unsafe.test(seam)) return { error: 'bad_request', reason: 'seam must not contain control characters or line breaks' };
  if (typeof ticket === 'string' && unsafe.test(ticket)) return { error: 'bad_request', reason: 'ticket must not contain control characters or line breaks' };
  const holders = rows.filter((row) => row.seam === seam && row.session !== caller);
  const live = holders.find((row) => row.state !== 'closed');
  if (live) {
    return {
      error: 'seam_taken',
      reason: 'seam "' + seam + '" is held by ' + live.session + ' (state ' + live.state + '); no row was changed. Coordinate with that session through talk_send, or have it release the seam.',
    };
  }
  const inherited = holders.length ? holders[holders.length - 1].ticket : undefined;
  for (const row of holders) rows.splice(rows.indexOf(row), 1);
  const at = now || new Date().toISOString();
  let row = rows.find((candidate) => candidate.session === caller && candidate.seam === seam);
  if (row) {
    if (row.state !== state) { row.state = state; row.since = at; }
    if (ticket !== undefined) row.ticket = ticket;
  } else {
    row = { session: caller, state, ticket: ticket || inherited || '', seam, since: at };
    rows.push(row);
  }
  return { rows, row };
}

export { claim, planClaim as plan, readBoard, withLock };
