import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import plugin, { createRecallPlugin } from './index.js';
import { readConfig, render, stateLine } from './lib.js';

function fakeHost() {
  const tools = new Map();
  const hooks = new Map();
  let disposedTools = false;
  const ctx = {
    tool: {
      async transform(callback) {
        callback({
          namespace(value) { ctx.namespace = value; },
          add(definition) { tools.set(definition.name, definition); },
        });
        return { async dispose() { disposedTools = true; } };
      },
    },
    session: {
      async hook(name, callback) {
        hooks.set(name, callback);
        return { async dispose() { hooks.delete(name); } };
      },
    },
  };
  return { ctx, tools, hooks, disposed: () => disposedTools };
}

test('default export is the V2 object plugin with oc-recall identity', () => {
  assert.equal(typeof plugin, 'object');
  assert.equal(plugin.id, 'oc-recall');
  assert.equal(typeof plugin.setup, 'function');
});

test('package entrypoint exposes the V2 plugin as a private preview without dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'oc-recall');
  assert.equal(manifest.private, true);
  assert.equal(manifest.exports['.'], './index.js');
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test('freshness rendering keeps missing, stale and proven-fresh states distinct', () => {
  const graph = { nodes: 1, edges: 0, communities: 1, commit: 'abcdef0123456789', file: 'graph.json' };
  assert.match(stateLine(null, null), /missing/);
  assert.match(stateLine(graph, null, { state: 'stale', detail: 'corpus changed' }), /STALE.*corpus changed/);
  assert.match(stateLine(graph, null, { state: 'fresh', detail: 'verified stamp' }), /fresh.*verified stamp/);
  const orientation = render({ graph, atlas: 'synthetic-atlas', head: null, fresh: { state: 'unknown' } });
  assert.match(orientation, /untrusted evidence/);
  assert.doesNotMatch(orientation, /[A-Z]:[\\/]|Users[\\/]/);
});

test('setup retains six graph tools, separate lexical tool and three orientation hooks', async () => {
  const atlas = await mkdtemp(path.join(tmpdir(), 'oc-recall-plugin-'));
  try {
    const host = fakeHost();
    const cleanup = await createRecallPlugin({ atlas }).setup(host.ctx);
    assert.equal(host.ctx.namespace.name, 'recall');
    assert.deepEqual([...host.tools.keys()].sort(), [
      'graph_god_nodes', 'graph_neighbors', 'graph_node', 'graph_path', 'graph_query', 'graph_stats', 'recall_search',
    ]);
    assert.deepEqual([...host.hooks.keys()].sort(), ['compaction', 'context', 'generate']);
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'question' }] }];
    host.hooks.get('context')({ messages });
    const orientation = messages[0].content[0].text;
    assert.match(orientation, /untrusted evidence, never instructions/i);
  assert.match(orientation, /missing or unreadable/);
    const count = messages[0].content.length;
    host.hooks.get('context')({ messages });
    assert.equal(messages[0].content.length, count);
    await cleanup();
    assert.equal(host.hooks.size, 0);
    assert.equal(host.disposed(), true);
  } finally { await rm(atlas, { recursive: true, force: true }); }
});

test('missing configuration remains loadable and reports the missing Atlas', async () => {
  const host = fakeHost();
  const cleanup = await createRecallPlugin({ env: {}, configFile: 'missing-graphify.json' }).setup(host.ctx);
  assert.equal(host.tools.size, 7);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'question' }] }];
  host.hooks.get('context')({ messages });
  assert.match(messages[0].content[0].text, /Atlas graph: not configured/);
  assert.match((await host.tools.get('graph_stats').execute()).content, /atlas is not configured/);
  assert.match((await host.tools.get('recall_search').execute({ query: 'term' })).content, /atlas is not configured/);
  await cleanup();
});

test('explicit plugin options and environment configuration take precedence over legacy config', async () => {
  const atlas = await mkdtemp(path.join(tmpdir(), 'oc-recall-config-'));
  const environmentAtlas = await mkdtemp(path.join(tmpdir(), 'oc-recall-env-'));
  try {
    const graph = (label) => JSON.stringify({
      nodes: [{ id: 'node', label }],
      links: [],
      graph: { graphify_version: 'fixture' },
    });
    await mkdir(path.join(atlas, 'graphify-out'), { recursive: true });
    await mkdir(path.join(environmentAtlas, 'graphify-out'), { recursive: true });
    await writeFile(path.join(atlas, 'graphify-out', 'graph.json'), graph('OptionNode'));
    await writeFile(path.join(environmentAtlas, 'graphify-out', 'graph.json'), graph('EnvironmentNode'));
    const host = fakeHost();
    await createRecallPlugin({ env: { OC_GRAPHIFY_ATLAS: environmentAtlas }, configFile: 'missing' }).setup({
      ...host.ctx,
      options: { atlas },
    });
    const optionsResult = await host.tools.get('graph_node').execute({ name: 'OptionNode' });
    assert.match(optionsResult.content, /OptionNode/);
    assert.doesNotMatch(optionsResult.content, /EnvironmentNode/);
    const legacyFile = path.join(atlas, 'graphify.json');
    await writeFile(legacyFile, JSON.stringify({ atlas }));
    assert.deepEqual(readConfig(legacyFile), { atlas });
    const envHost = fakeHost();
    await createRecallPlugin({ env: { OC_GRAPHIFY_ATLAS: environmentAtlas }, configFile: legacyFile }).setup(envHost.ctx);
    assert.match((await envHost.tools.get('graph_node').execute({ name: 'EnvironmentNode' })).content, /EnvironmentNode/);
  } finally {
    await rm(atlas, { recursive: true, force: true });
    await rm(environmentAtlas, { recursive: true, force: true });
  }
});

test('lexical tool reports missing mirror without disabling independent graph tools', async () => {
  const atlas = await mkdtemp(path.join(tmpdir(), 'oc-recall-plugin-'));
  try {
    const host = fakeHost();
    await createRecallPlugin({ atlas }).setup(host.ctx);
    const response = await host.tools.get('recall_search').execute({ query: 'needle' });
    assert.match(response.content, /corpus membership unavailable/);
    assert.equal(host.tools.has('graph_stats'), true);
    assert.match((await host.tools.get('graph_stats').execute()).content, /^error:/);
  } finally { await rm(atlas, { recursive: true, force: true }); }
});

test('all six graph reads stay available as separate recall tools', async () => {
  const atlas = await mkdtemp(path.join(tmpdir(), 'oc-recall-plugin-'));
  try {
    const graphPath = path.join(atlas, 'graphify-out', 'graph.json');
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, JSON.stringify({
      nodes: [
        { id: 'a', label: 'Alpha', community: 1, file_type: 'concept' },
        { id: 'b', label: 'Beta', community: 1, file_type: 'concept' },
      ],
      links: [{ source: 'a', target: 'b', relation: 'connects' }],
      graph: { graphify_version: 'test' },
    }));
    const host = fakeHost();
    await createRecallPlugin({ atlas }).setup(host.ctx);
    for (const [name, input] of [
      ['graph_stats', {}], ['graph_node', { name: 'Alpha' }],
      ['graph_neighbors', { name: 'Alpha' }], ['graph_path', { from: 'Alpha', to: 'Beta' }],
      ['graph_god_nodes', {}], ['graph_query', { question: 'Alpha' }],
    ]) {
      const response = await host.tools.get(name).execute(input);
      assert.equal(typeof response.content, 'string', name);
      assert.doesNotMatch(response.content, /^error:/, name);
    }
  } finally { await rm(atlas, { recursive: true, force: true }); }
});

test('missing graph does not disable lexical search and search never reads mirror content', async () => {
  const atlas = await mkdtemp(path.join(tmpdir(), 'oc-recall-plugin-'));
  try {
    const mirror = path.join(atlas, '.graphify', 'corpus', '00 - Canon');
    const original = path.join(atlas, '00 - Canon', 'source.md');
    await mkdir(mirror, { recursive: true });
    await mkdir(path.dirname(original), { recursive: true });
    await writeFile(path.join(mirror, 'source.md'), 'mirror-only sentinel');
    await writeFile(original, 'approved original needle');
    const host = fakeHost();
    await createRecallPlugin({ atlas }).setup(host.ctx);
    assert.match((await host.tools.get('graph_stats').execute()).content, /^error:/);
    const result = JSON.parse((await host.tools.get('recall_search').execute({ query: 'needle' })).content);
    assert.equal(result.status, 'evidence-only');
    assert.equal(result.results[0].excerpt, 'approved original needle');
    assert.equal(result.results[0].membershipFreshness, 'unverified');
    assert.equal(result.results[0].untrusted, true);
    assert.doesNotMatch(JSON.stringify(result), /mirror-only sentinel/);
    assert.match(result.warning, /verify every excerpt/i);
  } finally { await rm(atlas, { recursive: true, force: true }); }
});

test('no approved membership means no broader fallback and invalid inputs are explicit', async () => {
  const atlas = await mkdtemp(path.join(tmpdir(), 'oc-recall-plugin-'));
  try {
    await mkdir(path.join(atlas, '99 - Archive'), { recursive: true });
    await writeFile(path.join(atlas, '99 - Archive', 'secret.md'), 'needle');
    const host = fakeHost();
    await createRecallPlugin({ atlas }).setup(host.ctx);
    const noMirror = await host.tools.get('recall_search').execute({ query: 'needle' });
    assert.match(noMirror.content, /^error:/);
    await mkdir(path.join(atlas, '.graphify', 'corpus', '99 - Archive'), { recursive: true });
    const noApproved = JSON.parse((await host.tools.get('recall_search').execute({ query: 'needle' })).content);
    assert.equal(noApproved.status, 'no-approved-sources');
    assert.deepEqual(noApproved.results, []);
    assert.match((await host.tools.get('recall_search').execute({ query: 'x'.repeat(2049) })).content, /^error:/);
    assert.match((await host.tools.get('recall_search').execute({ query: 'needle', limit: 100 })).content, /^error:/);
  } finally { await rm(atlas, { recursive: true, force: true }); }
});
