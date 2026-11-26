// The board rules that the rewrite added: strict parse, plan claims, atomic write.
// These assert behaviour a reader can verify from the file, not internal calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claim, parseBoard, plan, readBoard, withLock } from '../src/board.mjs';

const row = (over = {}) => ({ session: 'ses_a', state: 'active', ticket: '', seam: 'parser', since: '2026-01-01T00:00:00.000Z', ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oc-talk-board-'));

test('parse refuses flow-style rows instead of dropping them', () => {
  const out = parseBoard('version: 1\nrows: [{session: ses_a, seam: parser}]\n');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'board_unreadable');
});

test('parse refuses a line it cannot model', () => {
  const out = parseBoard('version: 1\nrows:\n  - session: ses_a\n    seam: parser\n  this line is prose\n');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'board_unreadable');
  assert.match(out.reason, /line 5/);
});

test('parse refuses a board written by a newer version', () => {
  const out = parseBoard('version: 99\nrows: []\n');
  assert.equal(out.ok, false);
  assert.match(out.reason, /newer/);
});

test('parse refuses a row with an unknown state', () => {
  const out = parseBoard("version: 1\nrows:\n  - session: 'ses_a'\n    state: 'banana'\n    seam: 'parser'\n");
  assert.equal(out.ok, false);
  assert.match(out.reason, /banana/);
});

test('parse enforces the row cap', () => {
  const rows = Array.from({ length: 501 }, (_, i) => `  - session: 'ses_${i}'\n    state: 'active'\n    seam: 's${i}'`).join('\n');
  const out = parseBoard('version: 1\nrows:\n' + rows + '\n');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'board_too_large');
});

test('plan refuses a seam held by an active session and names the holder', () => {
  const out = plan([row()], { caller: 'ses_b', seam: 'parser', state: 'active' });
  assert.equal(out.error, 'seam_taken');
  assert.match(out.reason, /ses_a/);
  assert.match(out.reason, /talk_send/);
});

test('plan takes over a closed row instead of blocking the seam', () => {
  const out = plan([row({ state: 'closed' })], { caller: 'ses_b', seam: 'parser', state: 'active' });
  assert.equal(out.row.session, 'ses_b');
  assert.equal(out.row.state, 'active');
  assert.equal(out.rows.length, 1);
});

test('plan keeps both rows when one session holds two seams', () => {
  const first = plan([], { caller: 'ses_a', seam: 'one', state: 'active' });
  const second = plan(first.rows, { caller: 'ses_a', seam: 'two', state: 'active' });
  assert.equal(second.rows.length, 2);
  assert.deepEqual(second.rows.map((r) => r.seam).sort(), ['one', 'two']);
});

test('plan keeps since on the same state and moves it when the state changes', () => {
  const first = plan([], { caller: 'ses_a', seam: 'parser', state: 'active', now: '2026-01-01T00:00:00.000Z' });
  const again = plan(first.rows, { caller: 'ses_a', seam: 'parser', state: 'active', now: '2026-02-02T00:00:00.000Z' });
  assert.equal(again.row.since, '2026-01-01T00:00:00.000Z');
  const parked = plan(again.rows, { caller: 'ses_a', seam: 'parser', state: 'parked', now: '2026-03-03T00:00:00.000Z' });
  assert.equal(parked.row.since, '2026-03-03T00:00:00.000Z');
});

test('plan refuses a state outside the three words', () => {
  const out = plan([], { caller: 'ses_a', seam: 'parser', state: 'banana' });
  assert.equal(out.error, 'bad_request');
  assert.match(out.reason, /active, parked, closed/);
});

test('a claim preserves top-level extras and writes a version, leaving no temp or lock behind', async () => {
  const dir = tmp();
  const file = path.join(dir, '.nstack', 'board.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "version: 1\nproject: 'demo'\nrows:\n  - session: 'ses_a'\n    state: 'active'\n    ticket: ''\n    seam: 'parser'\n    since: '2026-01-01T00:00:00.000Z'\n", 'utf8');
  const result = await claim(file, (rows) => plan(rows, { caller: 'ses_b', seam: 'lexer', state: 'active' }));
  assert.equal(result.ok, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /project: 'demo'/);
  assert.match(text, /version: 1/);
  assert.match(text, /seam: 'lexer'/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')), []);
});

test('readBoard treats a missing file as an empty board and names the path', () => {
  const file = path.join(tmp(), '.nstack', 'board.yaml');
  const out = readBoard(file);
  assert.equal(out.ok, true);
  assert.deepEqual(out.rows, []);
  assert.equal(out.file, file);
  assert.match(out.message, /no board/);
});

test('plan refuses a seam or ticket carrying a line break', () => {
  const seam = plan([], { caller: 'ses_a', seam: 'parser\nrows:', state: 'active' });
  assert.equal(seam.error, 'bad_request');
  assert.match(seam.reason, /control characters or line breaks/);
  const ticket = plan([], { caller: 'ses_a', seam: 'parser', state: 'active', ticket: 'a\rb' });
  assert.equal(ticket.error, 'bad_request');
});

test('claim refuses a write that would pass the row cap', async () => {
  const dir = tmp();
  const file = path.join(dir, '.nstack', 'board.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = Array.from({ length: 500 }, (_, i) => `  - session: 'ses_${i}'\n    state: 'active'\n    ticket: ''\n    seam: 's${i}'\n    since: '2026-01-01T00:00:00.000Z'`).join('\n');
  fs.writeFileSync(file, "version: 1\nrows:\n" + rows + "\n", 'utf8');
  const result = await claim(file, (list) => plan(list, { caller: 'ses_new', seam: 'overflow', state: 'active' }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'board_too_large');
  assert.match(fs.readFileSync(file, 'utf8'), /seam: 's499'/);
});

test('parse accepts the flow row shape the harness writes', () => {
  const text = `- {session: ses_a, state: active, ticket: harness, seam: spec/nstack.yaml, since: "2026-11-26T08:00:00+08:00"}\n- {session: ses_b, state: parked, ticket: '"'"''"'"', seam: 'x', since: 't'}\n`;
  const out = parseBoard(text);
  assert.equal(out.ok, true);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].session, 'ses_a');
  assert.equal(out.rows[0].seam, 'spec/nstack.yaml');
  assert.equal(out.rows[0].state, 'active');
});

// The harness board, unedited: a fixture copied from the live file, because a
// hand-written shape proves nothing about the file the tool actually meets.
test('parse accepts the live harness board unchanged', () => {
  const text = fs.readFileSync(new URL('./fixtures/harness-board.yaml', import.meta.url), 'utf8');
  const out = parseBoard(text);
  assert.equal(out.ok, true, out.reason);
  assert.ok(out.rows.length >= 3);
  for (const row of out.rows) {
    assert.equal(typeof row.session, 'string');
    assert.ok(row.seam.length > 0);
    assert.ok(['active', 'parked', 'closed'].includes(row.state));
  }
});

// ---------------------------------------------------------------- the lock

test('a fresh foreign lock refuses the claim instead of stealing it', async () => {
  const dir = tmp();
  const file = path.join(dir, '.nstack', 'board.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'version: 1\nrows: []\n', 'utf8');
  fs.writeFileSync(file + '.lock', 'someone-else', 'utf8');
  const result = await claim(file, (list) => plan(list, { caller: 'ses_a', seam: 'parser', state: 'active' }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'board_locked');
  assert.match(fs.readFileSync(file, 'utf8'), /rows: \[\]/);
});

test('a stale lock is stolen and the claim then releases its own', async () => {
  const dir = tmp();
  const file = path.join(dir, '.nstack', 'board.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'version: 1\nrows: []\n', 'utf8');
  fs.writeFileSync(file + '.lock', 'a-dead-claim', 'utf8');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file + '.lock', old, old);
  const result = await claim(file, (list) => plan(list, { caller: 'ses_a', seam: 'parser', state: 'active' }));
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(file + '.lock'), false);
});

// The window the rewrite left open: a lock that was stolen and re-taken while its
// first owner still held it must not be unlinked by that owner on the way out.
test('a release leaves a lock that another claimant now owns', async () => {
  const dir = tmp();
  const file = path.join(dir, 'board.yaml');
  await withLock(file, () => {
    fs.unlinkSync(file + '.lock');
    fs.writeFileSync(file + '.lock', 'second-owner', 'utf8');
  });
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'second-owner');
});

// ---------------------------------------------------------------- the pruning

test('a claim drops the caller own closed rows for other seams', async () => {
  const dir = tmp();
  const file = path.join(dir, '.nstack', 'board.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "version: 1\nrows:\n  - session: 'ses_a'\n    state: 'closed'\n    ticket: ''\n    seam: 'old'\n    since: '2026-01-01T00:00:00.000Z'\n", 'utf8');
  const result = await claim(file, (list) => plan(list, { caller: 'ses_a', seam: 'new', state: 'active' }));
  assert.equal(result.ok, true);
  const parsed = parseBoard(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(parsed.rows.map((row) => row.seam), ['new']);
});

test('closed rows from other sessions are capped and the newest survive', async () => {
  const dir = tmp();
  const file = path.join(dir, '.nstack', 'board.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const history = Array.from({ length: 30 }, (_, i) => "  - session: 'ses_" + i + "'\n    state: 'closed'\n    ticket: ''\n    seam: 's" + i + "'\n    since: '2026-01-01T00:00:0" + (i % 10) + ".000Z'").join('\n');
  fs.writeFileSync(file, 'version: 1\nrows:\n' + history + '\n', 'utf8');
  const result = await claim(file, (list) => plan(list, { caller: 'ses_new', seam: 'fresh', state: 'active' }));
  assert.equal(result.ok, true);
  const parsed = parseBoard(fs.readFileSync(file, 'utf8'));
  const closed = parsed.rows.filter((row) => row.state === 'closed');
  assert.equal(closed.length, 20);
  assert.ok(closed.some((row) => row.seam === 's29'));
  assert.ok(!closed.some((row) => row.seam === 's0'));
  assert.ok(parsed.rows.some((row) => row.seam === 'fresh'));
});
