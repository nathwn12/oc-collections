// Release-gate regression. release.yml rewrites packages/oc-talk/package.json to
// the derived version before it runs the test step, so neither the shipped code
// nor the tests may carry a version literal. Both checks here are offline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { readManifestVersion } from '../src/index.js';

const ROOT = path.join(import.meta.dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const SRC = path.join(ROOT, 'src');

test('a bumped manifest version is read from the file at call time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-talk-version-'));
  try {
    const bumped = path.join(dir, 'package.json');
    fs.writeFileSync(bumped, JSON.stringify({ name: 'oc-talk', version: '0.7.0' }));
    assert.equal(readManifestVersion(pathToFileURL(bumped)), '0.7.0');
    // The shipped manifest stays the source of truth for the normal path.
    assert.equal(readManifestVersion(pathToFileURL(PKG)), JSON.parse(fs.readFileSync(PKG, 'utf8')).version);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no source file hardcodes a VERSION literal or the current version', () => {
  const version = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
  for (const name of fs.readdirSync(SRC)) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    const text = fs.readFileSync(path.join(SRC, name), 'utf8');
    assert.doesNotMatch(text, /\b(?:const|let|var)\s+VERSION\s*=\s*['"`]/, name + ' hardcodes VERSION');
    assert.ok(!text.includes(version), name + ' hardcodes the manifest version ' + version);
  }
});

test('a malformed manifest fails loudly instead of shipping an empty version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-talk-version-bad-'));
  try {
    const bad = path.join(dir, 'package.json');
    fs.writeFileSync(bad, JSON.stringify({ name: 'oc-talk' }));
    assert.throws(() => readManifestVersion(pathToFileURL(bad)), /no version/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
