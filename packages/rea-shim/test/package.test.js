'use strict';
//
// Manifest guard.
//
// The launcher resolves a JDK/Ghidra pair and relays a stdio channel using
// Node builtins only: it ships no upstream code and needs no third-party
// module. It also speaks MCP over stdio, so it never imports the client's own
// `@opencode/*` packages. Both properties live in the package manifest, and
// both are checked here rather than asserted in prose.
//

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PACKAGE_DIR = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];

test('the launcher declares no runtime dependency', () => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const value = pkg[field];
    assert.ok(
      value === undefined || Object.keys(value).length === 0,
      `package.json must not declare ${field}: ${JSON.stringify(value)}`,
    );
  }
  assert.equal(pkg.bundledDependencies, undefined, 'package.json must not bundle dependencies');
  assert.equal(pkg.bundleDependencies, undefined, 'package.json must not bundle dependencies');
});

test('no dependency field names an MCP client package', () => {
  for (const field of DEPENDENCY_FIELDS) {
    const value = pkg[field];
    if (!value) continue;
    for (const name of Object.keys(value)) {
      assert.ok(!name.startsWith('@opencode/'), `package.json must not depend on ${name} in ${field}`);
    }
  }
});

test('package.json declares the Node range npm must enforce', () => {
  assert.ok(pkg.engines && typeof pkg.engines === 'object', 'package.json must carry an engines block');
  assert.equal(typeof pkg.engines.node, 'string', 'engines.node must be a range string');
  assert.notEqual(pkg.engines.node.trim(), '', 'engines.node must not be empty');
});
