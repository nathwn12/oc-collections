import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as lib from '../lib.js';

/**
 * Freshness is a claim about corpus bytes, not about HEAD. These two cases are
 * the ones the old stamp-only comparison got wrong: a commit that touched no
 * corpus input called a good graph stale, and an edited note at the build
 * commit called a bad graph fresh. The ledger fixture mirrors the real build
 * manifest: `stamp` plus a sha256 for each input, written beside graph.json.
 */
function ledgerFixture({
  built = 'a'.repeat(40),
  head = 'b'.repeat(40),
  noteBytes = '# note\n',
  recordedBytes = noteBytes,
} = {}) {
  const atlas = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-graphify-corpus-'));
  const rel = '00 — Core/note.md';
  const note = path.join(atlas, ...rel.split('/'));
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, noteBytes);
  const out = path.join(atlas, 'graphify-out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'graph.json'), JSON.stringify({
    nodes: [{ id: 'n', file_type: 'document', source_file: rel, community: 0 }],
    links: [],
    built_at_commit: built,
  }));
  fs.writeFileSync(path.join(out, '.graphify_build.json'), JSON.stringify({
    stamp: built.slice(0, 8),
    inputs: { [rel]: createHash('sha256').update(recordedBytes).digest('hex') },
  }));
  return { atlas, graph: lib.readGraph(atlas), head };
}

test('freshness: a commit that changes no corpus input reports fresh, not stale', () => {
  const fixture = ledgerFixture();
  try {
    const fresh = lib.corpusFreshness(fixture.atlas, fixture.graph);
    assert.equal(fresh?.state, 'fresh');
    assert.equal(lib.verdict(fixture.graph, fixture.head, fresh), 'fresh');
    assert.match(lib.stateLine(fixture.graph, fixture.head, fresh), /Graph state: fresh/);
    // The old fallback compared the stamp with HEAD and called this stale.
    assert.notEqual(lib.verdict(fixture.graph, fixture.head), 'stale', 'stamp-only fallback must be gone');
  } finally {
    fs.rmSync(fixture.atlas, { recursive: true, force: true });
  }
});

test('freshness: a changed corpus input reports stale, even at the build commit', () => {
  const built = 'a'.repeat(40);
  const fixture = ledgerFixture({ built, head: built, recordedBytes: '# old note\n' });
  try {
    const fresh = lib.corpusFreshness(fixture.atlas, fixture.graph);
    assert.equal(fresh?.state, 'stale');
    assert.match(fresh.detail, /1 corpus input\(s\) changed/);
    assert.equal(lib.verdict(fixture.graph, fixture.head, fresh), 'stale');
    assert.match(lib.stateLine(fixture.graph, fixture.head, fresh), /STALE/);
    // The old fallback saw equal stamps and called this fresh.
    assert.notEqual(lib.verdict(fixture.graph, fixture.head), 'fresh', 'stamp-only fallback must be gone');
  } finally {
    fs.rmSync(fixture.atlas, { recursive: true, force: true });
  }
});
