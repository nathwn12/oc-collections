// maxBytes is a contract: a read may exceed it only by the bytes needed to
// finish the one character or escape sequence that straddles its end.
//
// A ConPTY opens every session with escape-only chunks, so the first read of
// every session used to hit the widen-to-the-end path and hand back the whole
// buffered output. These tests pin the bound with a child that writes a
// terminal-shaped preamble itself, so they do not depend on ConPTY timing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../lib/sessions.js';

const EMOJI = String.fromCharCode(55357, 56832);
const MODE_ESCAPES = '\u001b[?9001h\u001b[?1004h';
// The documented allowance (MAX_SEQUENCE_OVERAGE_BYTES in lib/sessions.js) is
// 64 KiB for a pathological sequence; these streams only need a few bytes, so
// a tight slack is what proves the reply did not widen to the ring.
const SMALL_SLACK = 16;

function writeAndExit(payload) {
  return [process.execPath, ['-e', `process.stdout.write(${JSON.stringify(payload)})`]];
}

function writeAndHold(payload) {
  return [
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(payload)}); setInterval(() => {}, 1000);`],
  ];
}

test('a small maxBytes stays bounded when the session opens with escape sequences', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const [command, args] = writeAndExit(MODE_ESCAPES + EMOJI.repeat(200));
  const { sessionId } = manager.spawn({ command, args, description: 'escape preamble then a wide emoji stream' });

  for (const maxBytes of [7, 1]) {
    const first = await manager.read(sessionId, { cursor: 0, maxBytes, waitMs: 5000 });
    assert.ok(first.data.length > 0, 'the read must reach the visible output behind the escapes');
    assert.ok(
      Buffer.byteLength(first.data, 'utf8') <= maxBytes + SMALL_SLACK,
      `maxBytes ${maxBytes} must bound the reply, got ${Buffer.byteLength(first.data, 'utf8')} bytes`,
    );
    assert.equal(first.data, EMOJI, 'one emoji, and no escape byte in the stripped reply');
    assert.ok(first.cursor > 0, 'the cursor must move past the consumed escapes');

    // The next read returns exactly what its window holds, cursor included.
    const next = await manager.read(sessionId, {
      cursor: first.cursor,
      maxBytes: 1,
      waitMs: 1000,
      stripAnsi: false,
    });
    assert.ok(next.cursor > first.cursor, 'a read from the same cursor must make progress');
    assert.equal(
      Buffer.byteLength(next.data, 'utf8'),
      next.cursor - first.cursor,
      'a raw read advances exactly by the bytes it returns',
    );
  }
});

test('paging a maxBytes-sized stream reassembles it exactly and ends at the true total', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const expected = EMOJI.repeat(200);
  const [command, args] = writeAndExit(MODE_ESCAPES + expected);
  const { sessionId } = manager.spawn({ command, args, description: 'emoji stream paged seven bytes at a time' });

  let cursor = 0;
  let collected = '';
  const deadline = Date.now() + 8000;
  for (;;) {
    assert.ok(Date.now() < deadline, `paging timed out at ${cursor} with ${collected.length} characters`);
    const state = await manager.read(sessionId, { cursor, maxBytes: 7, waitMs: 1000 });
    if (state.data !== '') {
      assert.ok(
        Buffer.byteLength(state.data, 'utf8') <= 7 + SMALL_SLACK,
        `a chunk may not exceed the window's allowance, got ${Buffer.byteLength(state.data, 'utf8')} bytes`,
      );
      collected += state.data;
    }
    assert.ok(state.cursor >= cursor, 'the cursor must be monotonic');
    cursor = state.cursor;
    if (state.exited && state.data === '') break;
  }

  assert.equal(collected, expected, 'successive reads must rebuild the exact text');
  assert.equal(cursor, manager.list().sessions[0].bytes, 'paging must end at the true total');
});

test('a long OSC title that straddles the window is held back whole and never leaks', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.killAll());

  const title = `TITLE-MARKER-${'x'.repeat(188)}`;
  const osc = `\u001b]0;${title}\u0007`;
  const posts = 'POST'.repeat(100);
  const expected = `PRE${posts}`;
  const [command, args] = writeAndHold(MODE_ESCAPES + `PRE${osc}${posts}`);
  const { sessionId } = manager.spawn({ command, args, description: 'a long window title between two visible markers' });

  // ConPTY may re-emit a window-title sequence out of line, so the byte the
  // title starts at is found from a raw read rather than assumed.
  let raw = '';
  let rawCursor = 0;
  const rawDeadline = Date.now() + 5000;
  while (Date.now() < rawDeadline && !(raw.includes('TITLE-MARKER') && raw.includes('POST'))) {
    const state = await manager.read(sessionId, {
      cursor: rawCursor, maxBytes: 1048576, waitMs: 200, stripAnsi: false,
    });
    raw += state.data;
    rawCursor = state.cursor;
  }
  assert.ok(raw.includes('TITLE-MARKER'), 'the title must reach the buffer');
  const oscIndex = raw.indexOf('\u001b]0;');
  assert.ok(oscIndex >= 0, 'the raw stream must contain the title sequence');

  const total = manager.list().sessions[0].bytes;
  let cursor = 0;
  let collected = '';
  const deadline = Date.now() + 8000;
  while (cursor < total && Date.now() < deadline) {
    const state = await manager.read(sessionId, { cursor, maxBytes: 7, waitMs: 500 });
    if (state.data !== '') {
      assert.ok(
        Buffer.byteLength(state.data, 'utf8') <= 7 + SMALL_SLACK,
        `a chunk may not exceed the window's allowance, got ${Buffer.byteLength(state.data, 'utf8')} bytes`,
      );
      assert.ok(!state.data.includes('\u001b'), 'no escape byte may leak into a stripped reply');
      assert.ok(!state.data.includes('TITLE-MARKER'), 'the title must never leak as text');
      collected += state.data;
    }
    assert.ok(state.cursor > cursor, 'a read with buffered output must advance the cursor');
    cursor = state.cursor;
  }

  assert.equal(collected, expected, 'the visible stream must reassemble around the held-back title');

  // The title run itself: a read starting on its first byte decodes it whole,
  // skips it, and moves the cursor past it without returning the title.
  const over = await manager.read(sessionId, { cursor: oscIndex, maxBytes: 7, waitMs: 1000 });
  assert.ok(over.cursor > oscIndex, 'the read at the title must advance past it');
  assert.ok(!over.data.includes('TITLE-MARKER'), 'the title must never leak as text');
  assert.ok(!over.data.includes('\u001b'), 'no escape byte may leak into a stripped reply');
});
