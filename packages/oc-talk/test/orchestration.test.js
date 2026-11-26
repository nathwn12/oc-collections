// Orchestration rules added after the board-gripe review: leases, takeover,
// filtered reads, compare-guarded writes and old-shape compatibility. Every case
// is offline; the only clock is the `now` a test supplies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { claim, boardYaml, parseBoard, plan, readBoard } from '../src/board.mjs';
import { viewBoard } from '../src/board-view.mjs';
import { broadcastPlan } from '../src/broadcast.mjs';
import { isExpired } from '../src/lease.mjs';

const ENTRY = path.join(import.meta.dirname, '..', 'src', 'index.js');
const NOW = '2026-01-02T00:00:00.000Z';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oc-talk-orch-'));
const leasedRow = (over = {}) => ({
  session: 'ses_a', state: 'active', ticket: '', seam: 'parser',
  since: '2026-01-01T00:00:00.000Z',
  heartbeat: '2026-01-01T00:00:00.000Z',
  leaseUntil: '2026-01-01T00:05:00.000Z',
  ...over,
});
const held = (over = {}) => ({ caller: 'ses_b', seam: 'parser', state: 'active', now: NOW, ...over });

// 1. A live lessor is never stolen, even with an expired lease and a reason.
test('takeover refuses a live lessor even when the lease has expired', () => {
  const out = plan([leasedRow()], held({ takeover: true, reason: 'holder wedged', liveness: { session: 'ses_a', live: true } }));
  assert.equal(out.error, 'seam_taken');
  assert.match(out.reason, /still live/);
  assert.match(out.reason, /ses_a/);
});

// 2. Expired lease + absent holder + explicit reason = takeover, recorded.
test('takeover of an expired lease from a dead session is allowed and recorded', async () => {
  const dir = tmp();
  const file = path.join(dir, '.nstack', 'board.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, boardYaml([leasedRow()]));
  const result = await claim(file, (rows) => plan(rows, held({ takeover: true, reason: 'holder exited', liveness: { session: 'ses_a', live: false, code: 'session_not_found' } })));
  assert.equal(result.ok, true, JSON.stringify(result));
  const parsed = parseBoard(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].session, 'ses_b');
  assert.equal(parsed.rows[0].state, 'active');
  assert.equal(parsed.rows[0].takeoverReason, 'holder exited');
  assert.equal(parsed.rows[0].takeoverAt, NOW);
  assert.ok(Date.parse(parsed.rows[0].leaseUntil) > Date.parse(NOW), 'a fresh lease is stamped');
});

// 3. All three takeover gates are mandatory.
test('takeover without a reason, liveness, a matching holder or expiry is refused', () => {
  const noReason = plan([leasedRow()], held({ takeover: true, liveness: { session: 'ses_a', live: false, code: 'session_not_found' } }));
  assert.equal(noReason.error, 'bad_request');
  assert.match(noReason.reason, /reason/);

  const noLiveness = plan([leasedRow()], held({ takeover: true, reason: 'x' }));
  assert.equal(noLiveness.error, 'seam_taken');
  assert.match(noLiveness.reason, /liveness check/);

  const wrongHolder = plan([leasedRow()], held({ takeover: true, reason: 'x', liveness: { session: 'ses_z', live: false, code: 'session_not_found' } }));
  assert.equal(wrongHolder.error, 'seam_taken');
  assert.match(wrongHolder.reason, /liveness check/);

  const fresh = plan([leasedRow({ leaseUntil: '2026-01-03T00:00:00.000Z' })], held({ takeover: true, reason: 'x', liveness: { session: 'ses_a', live: false, code: 'session_not_found' } }));
  assert.equal(fresh.error, 'seam_taken');
  assert.match(fresh.reason, /lease has not expired/);
});

// 4. Filtered reads and pagination keep the {rows} shape.
test('viewBoard filters by state/seam/session and pages with a cursor', () => {
  const rows = [
    { session: 'ses_a', state: 'active', seam: 'one' },
    { session: 'ses_b', state: 'parked', seam: 'two' },
    { session: 'ses_c', state: 'active', seam: 'three' },
    { session: 'ses_a', state: 'closed', seam: 'four' },
    { session: 'ses_d', state: 'active', seam: 'five' },
  ];
  const active = viewBoard(rows, { state: 'active' });
  assert.deepEqual(active.rows.map((r) => r.seam), ['one', 'three', 'five']);
  assert.equal(active.total, 3);

  const first = viewBoard(rows, { limit: 2 });
  assert.deepEqual(first.rows.map((r) => r.seam), ['one', 'two']);
  assert.equal(first.cursor.next, '2');
  const second = viewBoard(rows, { limit: 2, cursor: '2' });
  assert.deepEqual(second.rows.map((r) => r.seam), ['three', 'four']);
  assert.equal(second.cursor.previous, '0');
  assert.equal(second.cursor.next, '4');

  const bySession = viewBoard(rows, { session: 'ses_a' });
  assert.deepEqual(bySession.rows.map((r) => r.seam), ['one', 'four']);
  const bySeam = viewBoard(rows, { seam: 'three' });
  assert.deepEqual(bySeam.rows.map((r) => r.seam), ['three']);

  assert.equal(viewBoard(rows, { state: 'banana' }).error, 'bad_request');
  assert.equal(viewBoard(rows, { cursor: '-1' }).error, 'bad_request');
  assert.equal(viewBoard(rows, { limit: 'x' }).error, 'bad_request');
  // No options at all: the whole board, unchanged.
  assert.equal(viewBoard(rows).rows.length, 5);
});

// 5. A hand edit under our lock is detected: no lost row.
test('a concurrent hand writer is reported as board_changed and keeps its row', async () => {
  const dir = tmp();
  const file = path.join(dir, 'board.yaml');
  fs.writeFileSync(file, boardYaml([leasedRow()]));
  const injected = {
    session: 'ses_hand', state: 'active', ticket: '', seam: 'manual',
    since: NOW,
  };
  const result = await claim(file, (rows) => {
    // A human editor never takes the sidecar lock; it lands between read and write.
    fs.writeFileSync(file, boardYaml([...rows, injected]));
    return plan(rows, held({ seam: 'fresh' }));
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'board_changed');
  const parsed = parseBoard(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed.rows.some((row) => row.seam === 'manual'), 'the hand-written row survived');
  assert.ok(!parsed.rows.some((row) => row.seam === 'fresh'), 'no lost update, no overwriting write');
});

// 6. Old-shape rows stay compatible: held, parseable, and lease-stamped on claim.
test('old-shape rows without lease metadata are compatible but never stealable', async () => {
  const old = {
    session: 'ses_a', state: 'active', ticket: '', seam: 'parser',
    since: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(isExpired(old, NOW), false, 'no lease means unknown, not expired');
  const refused = plan([{ ...old }], held());
  assert.equal(refused.error, 'seam_taken');

  const dir = tmp();
  const file = path.join(dir, 'board.yaml');
  fs.writeFileSync(file, boardYaml([old]));
  const result = await claim(file, (rows) => plan(rows, { caller: 'ses_me', seam: 'new', state: 'active', now: NOW }));
  assert.equal(result.ok, true);
  const parsed = parseBoard(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.rows.length, 2);
  assert.ok(parsed.rows[0].seam === 'parser', 'the old row is untouched');
  const stamped = parsed.rows.find((row) => row.seam === 'new');
  assert.ok(stamped.leaseUntil && stamped.heartbeat, 'the new row carries a lease');
  // The internal row carries the lease; the tool projects only the five
  // public fields, so old callers see the same shape as before.
  for (const key of ['session', 'state', 'ticket', 'seam', 'since']) assert.ok(key in result.row);
  assert.ok(result.row.leaseUntil && result.row.heartbeat, 'lease is internal row metadata');
});

// 7. Re-claiming your own seam is a heartbeat.
test('a re-claim refreshes the lease without moving since on the same state', () => {
  const first = plan([], { caller: 'ses_a', seam: 'parser', state: 'active', now: '2026-01-01T00:00:00.000Z' });
  const again = plan(first.rows, { caller: 'ses_a', seam: 'parser', state: 'active', now: NOW });
  assert.equal(again.row.since, '2026-01-01T00:00:00.000Z');
  assert.equal(again.row.heartbeat, NOW);
  assert.equal(again.row.leaseUntil, '2026-01-02T00:05:00.000Z');
});

// 8. Read-only broadcast planner: dedup and cap, no send.
test('broadcastPlan deduplicates targets, caps the group and sends nothing', () => {
  const out = broadcastPlan(['ses_a', 'ses_b', 'ses_a', '', null], 'hello');
  assert.deepEqual(out, { targets: [{ session: 'ses_a', text: 'hello' }, { session: 'ses_b', text: 'hello' }] });
  assert.equal(broadcastPlan([], 'hello').targets.length, 0);
  assert.equal(broadcastPlan(['ses_a'], '').error, 'bad_request');
  assert.equal(broadcastPlan(Array.from({ length: 25 }, (_, i) => 'ses_' + i), 'x').error, 'bad_request');
});

// 9. Tool wiring: talk_board filtering and talk_claim takeover through the host.
let loads = 0;
const load = () => import(pathToFileURL(ENTRY).href + '?o=' + ++loads);

async function toolHost(t, contents, api = async () => ({ ok: true, json: { data: {} } })) {
  const mod = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-talk-orch-tool-'));
  const file = path.join(dir, 'board.yaml');
  if (contents !== undefined) fs.writeFileSync(file, contents, 'utf8');
  mod.setBoardFile(file);
  mod.setApiRunner(api);
  const added = [];
  await mod.default.setup({
    options: { boardFile: file },
    tool: { transform: async (fn) => fn({ add: (tool) => added.push(tool) }) },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { file, byName: (name) => added.find((tool) => tool.name === name) };
}

test('talk_board filters without breaking the default {rows} read', async (t) => {
  const text = boardYaml([
    { session: 'ses_a', state: 'active', ticket: 'T', seam: 'parser', since: NOW },
    { session: 'ses_b', state: 'parked', ticket: '', seam: 'docs', since: NOW },
  ]);
  const { byName } = await toolHost(t, text);
  const all = JSON.parse((await byName('talk_board').execute({}, { sessionID: 'ses_caller' })).content);
  assert.equal(all.error, undefined);
  assert.deepEqual(all.rows.map((r) => r.seam), ['parser', 'docs']);
  const active = JSON.parse((await byName('talk_board').execute({ state: 'active' }, { sessionID: 'ses_caller' })).content);
  assert.deepEqual(active.rows.map((r) => r.seam), ['parser']);
  assert.equal(active.total, 1);
  const paged = JSON.parse((await byName('talk_board').execute({ limit: 1 }, { sessionID: 'ses_caller' })).content);
  assert.equal(paged.rows.length, 1);
  assert.equal(paged.cursor.next, '1');
});

test('talk_claim takeover consults the service and refuses a live holder', async (t) => {
  const expired = boardYaml([leasedRow()]);
  const api = async (args) => {
    if (args[0] === 'session.get') return { ok: true, json: { data: { id: 'ses_a', title: 'holder' } } };
    return { ok: true, json: { data: {} } };
  };
  const live = await toolHost(t, expired, api);
  const refused = JSON.parse((await live.byName('talk_claim').execute(
    { seam: 'parser', takeover: true, reason: 'x' }, { sessionID: 'ses_b' },
  )).content);
  assert.equal(refused.error, 'seam_taken');
  assert.match(refused.reason, /still live/);

  const deadApi = async (args) => {
    if (args[0] === 'session.get') return { ok: false, code: 'session_not_found', detail: 'gone' };
    return { ok: true, json: { data: {} } };
  };
  const dead = await toolHost(t, expired, deadApi);
  const taken = JSON.parse((await dead.byName('talk_claim').execute(
    { seam: 'parser', takeover: true, reason: 'session gone' }, { sessionID: 'ses_b' },
  )).content);
  assert.equal(taken.error, undefined, JSON.stringify(taken));
  assert.equal(taken.session, 'ses_b');
  const text = fs.readFileSync(dead.file, 'utf8');
  assert.match(text, /takeoverReason: 'session gone'/);
});

test('readBoard exposes the raw snapshot used by the compare guard', (t) => {
  const dir = tmp();
  const file = path.join(dir, 'board.yaml');
  const text = boardYaml([{ session: 'ses_a', state: 'active', ticket: '', seam: 'parser', since: NOW }]);
  fs.writeFileSync(file, text);
  const out = readBoard(file);
  assert.equal(out.ok, true);
  assert.equal(out.raw, text);
});

// --- cold-review finding 1: only an explicit session_not_found proves "gone".

test('a non-not-found liveness failure never authorizes takeover', () => {
  for (const code of ['backend_unavailable', 'timeout', 'backend_error', '']) {
    const out = plan([leasedRow()], held({ takeover: true, reason: 'x', liveness: { session: 'ses_a', live: false, code } }));
    assert.equal(out.error, 'seam_taken', 'code ' + JSON.stringify(code));
    assert.match(out.reason, /not proven gone/, JSON.stringify(out));
    assert.match(out.reason, /ses_a/);
  }
});

test('a live service answer still refuses takeover with a reason present', () => {
  const out = plan([leasedRow()], held({ takeover: true, reason: 'x', liveness: { session: 'ses_a', live: true, code: '' } }));
  assert.equal(out.error, 'seam_taken');
  assert.match(out.reason, /still live/);
});

test('takeover:false is a harmless boolean and a non-boolean is bad_request', () => {
  const free = plan([], held({ takeover: false }));
  assert.ok(free.row, JSON.stringify(free));
  assert.equal(free.row.session, 'ses_b');
  const taken = plan([leasedRow()], held({ takeover: false }));
  assert.equal(taken.error, 'seam_taken');
  const bad = plan([], held({ takeover: 'yes' }));
  assert.equal(bad.error, 'bad_request');
});

test('talk_claim refuses takeover on each non-not-found backend failure and writes nothing', async (t) => {
  for (const code of ['backend_unavailable', 'timeout', 'backend_error']) {
    const api = async (args) => {
      if (args[0] === 'session.get') return { ok: false, code, detail: 'lookup failed' };
      return { ok: true, json: { data: {} } };
    };
    const { file, byName } = await toolHost(t, boardYaml([leasedRow()]), api);
    const before = fs.readFileSync(file, 'utf8');
    const out = JSON.parse((await byName('talk_claim').execute(
      { seam: 'parser', takeover: true, reason: 'x' }, { sessionID: 'ses_b' },
    )).content);
    assert.equal(out.error, 'seam_taken', code + ': ' + JSON.stringify(out));
    assert.match(out.reason, /not proven gone/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, code + ': the board must be untouched');
  }
});
