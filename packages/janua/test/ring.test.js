import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputRing } from '../lib/ring.js';

const EMOJI = [0xf0, 0x9f, 0x98, 0x80];

test('a partial UTF-8 character at the tail is held until its bytes arrive', () => {
  const ring = new OutputRing(1024);
  ring.append(Buffer.from(EMOJI.slice(0, 3)));

  const first = ring.read(0, 2);
  assert.equal(first.data.length, 0, 'a character cut by the tail must not decode as U+FFFD');
  assert.equal(first.end, 0, 'the cursor must stay before the cut character');
  assert.equal(first.incomplete, true, 'the held tail is a typed condition, not a silent empty read');

  // Progress must be guaranteed: a repeated read either advances or says why
  // it cannot, rather than looping on the same bytes.
  const again = ring.read(first.end, 2);
  assert.equal(again.end, first.end);
  assert.equal(again.incomplete, true);

  ring.append(Buffer.from(EMOJI.slice(3)));
  const second = ring.read(first.end, 2);
  assert.equal(second.data.toString('utf8'), '😀');
  assert.equal(second.end, EMOJI.length, 'the read must consume the whole character');
  assert.equal(second.incomplete, false);
});

test('a read that reaches the tail returns only the complete prefix', () => {
  const ring = new OutputRing(1024);
  ring.append(Buffer.from([0x41, 0x42, ...EMOJI.slice(0, 3)]));

  const held = ring.read(0, 100);
  assert.equal(held.data.toString('utf8'), 'AB', 'the complete prefix is returned, the cut character is not');
  assert.equal(held.end, 2);
  assert.equal(held.incomplete, true);

  ring.append(Buffer.from(EMOJI.slice(3)));
  const rest = ring.read(held.end, 100);
  assert.equal(rest.data.toString('utf8'), '😀');
  assert.equal(rest.end, 2 + EMOJI.length);
});

test('a character cut by exit is flushed and reported as truncated', () => {
  const ring = new OutputRing(1024);
  ring.append(Buffer.from([0x41, ...EMOJI.slice(0, 3)]));

  const live = ring.read(0, 100);
  assert.equal(live.data.toString('utf8'), 'A');
  assert.equal(live.end, 1);
  assert.equal(live.incomplete, true);

  const flushed = ring.read(live.end, 100, { atEnd: true });
  assert.equal(flushed.end, 4, 'exit must advance past the fragment rather than stranding the cursor');
  assert.equal(flushed.truncated, true, 'the flush is typed, never silent');
  assert.equal(flushed.data.toString('utf8'), '\uFFFD', 'the orphan bytes decode as one replacement character');
});
