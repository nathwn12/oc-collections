import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { configDir, snapshot, stripJsonc } from '../src/config.mjs';

test('stripJsonc keeps comment markers inside strings and drops trailing commas', () => {
  const raw = '{\n  // real comment\n  "url": "https://x//y", /* block */\n  "a": [1, 2,],\n}';
  const clean = stripJsonc(raw);
  assert.equal(JSON.parse(clean).url, 'https://x//y');
  assert.deepEqual(JSON.parse(clean).a, [1, 2]);
  assert.doesNotMatch(clean, /real comment|block/);
});

test('configDir follows OPENCODE_CONFIG_DIR, then XDG, then the home default', () => {
  assert.equal(configDir({ OPENCODE_CONFIG_DIR: '/cfg' }, '/home'), '/cfg');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/xdg' }, '/home'), join('/xdg', 'opencode'));
  assert.equal(configDir({}, '/home'), join('/home', '.config', 'opencode'));
  assert.equal(configDir({ OPENCODE_CONFIG_DIR: 'relative' }, '/home'), join('/home', '.config', 'opencode'));
});

test('snapshot reports the winning source for the merged subagent depth', () => {
  const files = {
    [join('/global', 'opencode.jsonc')]: '{ // global\n "experimental": { "subagent_depth": 2 }, }',
    [join('/work', '.opencode', 'opencode.jsonc')]: '{ "experimental": { "subagent_depth": 3 } }',
    [join('/single.json')]: '{ "experimental": { "subagent_depth": 4 } }',
  };
  const read = (p) => {
    if (!(p in files)) throw new Error('missing ' + p);
    return files[p];
  };
  const base = {
    env: { OPENCODE_CONFIG_DIR: '/global', OPENCODE_CONFIG: join('/single.json') },
    home: '/home',
    cwd: '/work',
    read,
  };

  assert.deepEqual(snapshot({ ...base, ctxConfig: { experimental: { subagent_depth: 5 } } }), {
    sources: ['global', 'project', 'file', 'host'],
    effectiveDepth: 5,
    winner: 'host',
  });
  assert.equal(snapshot(base).winner, 'file');
  assert.equal(snapshot(base).effectiveDepth, 4);
  assert.equal(snapshot({ ...base, env: { ...base.env, OPENCODE_DISABLE_PROJECT_CONFIG: '1' } }).winner, 'file');
  assert.deepEqual(snapshot({ ...base, read: () => { throw new Error('none'); }, env: {} }), {
    sources: [],
    effectiveDepth: null,
    winner: null,
  });
});

test('snapshot never writes and ignores an invalid depth value', () => {
  const calls = [];
  const result = snapshot({
    env: {},
    home: '/home',
    cwd: '/work',
    read: (p) => {
      calls.push(p);
      if (p.endsWith('opencode.jsonc')) return '{ "experimental": { "subagent_depth": "deep" } }';
      throw new Error('missing');
    },
  });
  assert.equal(result.effectiveDepth, null, 'a string is not a depth');
  assert.equal(result.winner, null);
  assert.ok(calls.length > 0, 'the sources were read');
  assert.ok(calls.every((p) => typeof p === 'string'));
});
