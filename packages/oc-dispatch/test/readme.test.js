import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const README = path.join(import.meta.dirname, '..', 'README.md');

test('the README does not claim grading that is not wired', () => {
  const text = readFileSync(README, 'utf8');
  assert.match(text, /grade store/i, 'the grade store is mentioned');
  assert.match(text, /is read|read for ranking/i, 'reading it is stated');
  assert.match(text, /not yet wired/i, 'automatic recording is not claimed');
  assert.match(text, /auto-unbank/i, 'auto-unbank is named');
  assert.match(text, /next slice/i, 'the remaining work is named as a slice');
});

test('the README documents the offline CLI and the estimate label', () => {
  const text = readFileSync(README, 'utf8');
  for (const verb of ['status', 'off', 'init', 'doctor']) {
    assert.match(text, new RegExp('`' + verb + '`'), 'CLI verb documented: ' + verb);
  }
  assert.match(text, /oc-dispatch status/);
  assert.match(text, /est\. \$x/);
  assert.match(text, /^github:nathwn12\/oc-collections#main::path:packages\/oc-dispatch$/m);
});
