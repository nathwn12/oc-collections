#!/usr/bin/env node
/**
 * oc-graphify - the proving check.
 *
 *   node --test test/            (npm run check -w packages/oc-graphify)
 *
 * No network. The live cases read the atlas recorded in the host's
 * `graphify.json`, so they fail loudly when that record drifts; they skip on a
 * machine with no host install (CI), where there is nothing live to read. The
 * synthetic cases pin the exact bytes the host receives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKER,
  askFreshness,
  configPath,
  graphFile,
  headCommit,
  isJsRuntime,
  readConfig,
  readGraph,
  render,
  runtimePath,
  short,
  stateLine,
  summarize,
  verdict,
} from '../lib.js';
import plugin from '../index.js';
import { ALLOWED } from '../../../scripts/release-target.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');
const REPO = path.join(HERE, '..', '..', '..');
const CONFIG = configPath();
const HOST = path.dirname(CONFIG);
const INSTALLED = path.join(HOST, 'plugins', 'oc-graphify');
const VENDOR = path.join(HOST, 'plugins', 'graphify.js');
const hasHost = fs.existsSync(CONFIG);

const tmp = (name, body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-graphify-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
};

const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));

test('configPath: defaults into the harness config dir, and honours the override', () => {
  assert.equal(configPath({}), path.join(os.homedir(), '.config', 'opencode', 'graphify.json'));
  assert.equal(configPath({ OC_GRAPHIFY_CONFIG: '  Q:\\x\\graphify.json ' }), 'Q:\\x\\graphify.json');
  assert.equal(configPath({ OC_GRAPHIFY_CONFIG: '   ' }), path.join(os.homedir(), '.config', 'opencode', 'graphify.json'));
});

test('config: a good file reads the atlas', () => {
  const file = tmp('graphify.json', JSON.stringify({ atlas: 'Q:\\vault' }));
  assert.deepEqual(readConfig(file), { atlas: 'Q:\\vault' });
});

test('config: missing, malformed, and empty all read null', () => {
  assert.equal(readConfig(path.join(os.tmpdir(), 'nope-oc-graphify.json')), null);
  assert.equal(readConfig(tmp('graphify.json', '{ not json')), null);
  assert.equal(readConfig(tmp('graphify.json', JSON.stringify({ atlas: '   ' }))), null);
  assert.equal(readConfig(tmp('graphify.json', JSON.stringify({}))), null);
});

test('summarize: counts nodes, links and distinct communities', () => {
  const s = summarize({
    nodes: [{ community: 1 }, { community: 1 }, { community: 2 }, {}],
    links: [{}, {}],
    built_at_commit: 'a'.repeat(40),
    graph: { graphify_version: '0.9.105' },
  });
  assert.equal(s.nodes, 4);
  assert.equal(s.edges, 2);
  assert.equal(s.communities, 2);
  assert.equal(s.commit, 'a'.repeat(40));
  assert.equal(s.version, '0.9.105');
});

test('summarize: an empty object is four zeros, never a throw', () => {
  const s = summarize({});
  assert.deepEqual([s.nodes, s.edges, s.communities, s.commit, s.version], [0, 0, 0, null, null]);
});

test('verdict: four states, each named', () => {
  assert.equal(verdict(null, 'a'.repeat(40)), 'missing');
  assert.equal(verdict({ commit: null }, 'a'.repeat(40)), 'unknown');
  assert.equal(verdict({ commit: 'a'.repeat(40) }, null), 'unknown');
  assert.equal(verdict({ commit: 'a'.repeat(40) }, 'a'.repeat(40)), 'fresh');
  assert.equal(verdict({ commit: 'b'.repeat(40) }, 'a'.repeat(40)), 'stale');
});

test('stateLine: a stale graph names both commits and says rebuild', () => {
  const line = stateLine({ commit: 'bbbbbbb'.padEnd(40, 'b') }, 'aaaaaaa'.padEnd(40, 'a'));
  assert.match(line, /STALE/);
  assert.match(line, /bbbbbbb/);
  assert.match(line, /aaaaaaa/);
  assert.match(line, /Rebuild/);
});

test('headCommit: a 40-hex answer is kept, anything else is null', () => {
  const sha = 'c'.repeat(40);
  const calls = [];
  assert.equal(
    headCommit('Q:\\x', {
      exec: (file, args, options) => {
        calls.push({ file, options });
        return `${sha}\n`;
      },
    }),
    sha,
  );
  assert.equal(calls[0].options.windowsHide, true, 'the git probe must not get a console');
  assert.equal(headCommit('Q:\\x', { exec: () => 'not a sha' }), null);
  assert.equal(
    headCommit('Q:\\x', {
      exec: () => {
        throw new Error('git missing');
      },
    }),
    null,
  );
});

test('render: identical inputs give identical bytes', () => {
  const graph = { nodes: 922, edges: 1537, communities: 86, commit: 'd'.repeat(40), version: '0.9.105', file: 'g.json' };
  assert.equal(render({ graph, head: 'd'.repeat(40), atlas: 'Q:\\v' }), render({ graph, head: 'd'.repeat(40), atlas: 'Q:\\v' }));
});

test('render: fresh and stale differ only in the state line', () => {
  const head = 'e'.repeat(40);
  const graph = { nodes: 1, edges: 1, communities: 1, commit: head, version: '0.9.105', file: 'g.json' };
  const fresh = render({ graph, head, atlas: 'Q:\\v' });
  const stale = render({ graph: { ...graph, commit: 'f'.repeat(40) }, head, atlas: 'Q:\\v' });
  const prefix = (block) => block.split('\n').slice(0, -1).join('\n');
  assert.equal(prefix(fresh), prefix(stale), 'the cached prefix must not move');
  assert.notEqual(fresh.split('\n').at(-1), stale.split('\n').at(-1));
});

test('render: one marker, under the byte budget, and it names the real verbs', () => {
  const graph = { nodes: 922, edges: 1537, communities: 86, commit: 'a'.repeat(40), version: '0.9.105', file: 'Q:\\v\\graphify-out\\graph.json' };
  const block = render({ graph, head: 'a'.repeat(40), atlas: 'Q:\\v' });
  assert.equal(block.split(MARKER).length - 1, 1);
  assert.ok(block.length < 1200, `block is ${block.length} chars, budget is 1200`);
  for (const verb of ['graph_stats', 'graph_node', 'graph_neighbors', 'graph_path', 'graph_god_nodes', 'graph_query']) {
    assert.ok(block.includes(verb), `missing verb ${verb}`);
  }
  assert.ok(block.startsWith(MARKER));
});

test('render: a missing graph still says where it looked', () => {
  const block = render({ graph: null, head: null, atlas: 'Q:\\v' });
  assert.match(block, /no graph\.json under Q:\\v/);
  assert.match(block, /missing/);
});

test('render: node, edge and community counts are not swapped', () => {
  const graph = { nodes: 7, edges: 13, communities: 3, commit: 'a'.repeat(40), version: null, file: 'g' };
  const block = render({ graph, head: 'a'.repeat(40), atlas: 'Q:\\v' });
  assert.match(block, /7 nodes/);
  assert.match(block, /13 edges/);
  assert.match(block, /3 communities/);
});

test('manifest: private exactly while the release allowlist omits it', () => {
  const listed = ALLOWED.includes(manifest.name);
  assert.equal(
    manifest.private === true,
    !listed,
    listed
      ? `${manifest.name} is in scripts/release-target.mjs ALLOWED, so its manifest must not be private`
      : `${manifest.name} is not releasable, so its manifest must be private: true`,
  );
});

test('manifest: entry points and file list point at files that exist', () => {
  assert.equal(manifest.type, 'module');
  for (const rel of [manifest.main, ...Object.values(manifest.exports ?? {}), ...(manifest.files ?? [])]) {
    assert.ok(fs.existsSync(path.join(PKG, rel)), `${rel} is declared but missing`);
  }
  assert.ok(!(manifest.files ?? []).some((file) => file.startsWith('test')), 'the test tree must not ship');
});

test('manifest: every sibling a shipped file imports is itself shipped', () => {
  const declared = new Set(manifest.files ?? []);
  const seen = new Set(['index.js']);
  const queue = ['index.js'];
  while (queue.length > 0) {
    const file = queue.shift();
    const text = fs.readFileSync(path.join(PKG, file), 'utf8');
    for (const match of text.matchAll(/^import[^'"]*['"]\.\/([^'"]+)['"]/gm)) {
      const spec = match[1];
      if (seen.has(spec)) continue;
      seen.add(spec);
      queue.push(spec);
      assert.ok(declared.has(spec), `${spec} is imported by ${file} but missing from "files": npm pack ships a broken module`);
    }
  }
});

test('source: no third-party imports, so the host loads it as committed', () => {
  for (const file of ['index.js', 'lib.js']) {
    const text = fs.readFileSync(path.join(PKG, file), 'utf8');
    const specifiers = [...text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    assert.ok(specifiers.length > 0, `${file} has no imports`);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('.'),
        `${file} imports ${specifier}; only node: built-ins and sibling files are allowed`,
      );
    }
  }
});

test('source: no command rewriting hook', () => {
  // Comments name the vendor hook on purpose; only code counts.
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of ['index.js', 'lib.js']) {
    const code = strip(fs.readFileSync(path.join(PKG, file), 'utf8'));
    assert.ok(!/execute\.before/.test(code), `${file} registers execute.before; that is the vendor behaviour`);
    assert.ok(!/input\.command|args\.command/.test(code), `${file} mutates a shell command`);
  }
});

test('setup: registers the three request hooks on a host that offers them', () => {
  // A clean runner has no atlas record, and setup returns early without one.
  // Point it at a fixture so this asserts hook registration, not whether this
  // machine happens to be configured.
  const previous = process.env.OC_GRAPHIFY_CONFIG
  process.env.OC_GRAPHIFY_CONFIG = tmp('hooks-config.json', JSON.stringify({ atlas: path.join(os.tmpdir(), 'atlas') }))
  try {
    const hooks = new Map()
    const ctx = { session: { hook: (name, fn) => hooks.set(name, fn) }, location: { directory: 'Q:\\v' } }
    plugin.setup(ctx)
    assert.deepEqual([...hooks.keys()].sort(), ['compaction', 'context', 'generate'])
  } finally {
    if (previous === undefined) delete process.env.OC_GRAPHIFY_CONFIG
    else process.env.OC_GRAPHIFY_CONFIG = previous
  }
})

test('setup: injecting puts the block once, in front of the first user message', { skip: !hasHost }, () => {
  const hooks = new Map();
  plugin.setup({ session: { hook: (name, fn) => hooks.set(name, fn) } });
  const inject = hooks.get('context');
  const event = { sessionID: 'ses_x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };

  inject(event);
  assert.equal(event.messages[0].content.length, 2);
  assert.ok(event.messages[0].content[0].text.startsWith(MARKER));
  assert.equal(event.messages[0].content[1].text, 'hello');

  inject(event); // the marker already travels: no second copy
  assert.equal(event.messages[0].content.length, 2);
});

test('setup: a host without the hook, a hostile ctx, and no config are all silent', () => {
  assert.doesNotThrow(() => plugin.setup(undefined));
  assert.doesNotThrow(() => plugin.setup({}));
  assert.doesNotThrow(() => plugin.setup({ session: { hook: () => { throw new Error('refused'); } } }));
});

test('setup: six reads registered, and the hooks land when the tool editor refuses', async () => {
  // Same reason as the hook test above: a clean runner has no atlas record, and
  // setup returns early without one. Point it at a fixture so this asserts
  // registration, not whether this machine happens to be configured.
  const previous = process.env.OC_GRAPHIFY_CONFIG
  process.env.OC_GRAPHIFY_CONFIG = tmp('reads-config.json', JSON.stringify({ atlas: path.join(os.tmpdir(), 'atlas') }))
  try {
    const added = [];
    const hooks = [];
    plugin.setup({
      session: { hook: (name) => hooks.push(name) },
      tool: {
        transform: (fn) => {
          fn({ add: (def) => added.push(def.name), namespace: () => {} });
          return Promise.resolve();
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(added.sort(), ['graph_god_nodes', 'graph_neighbors', 'graph_node', 'graph_path', 'graph_query', 'graph_stats']);
    assert.deepEqual(hooks.sort(), ['compaction', 'context', 'generate']);

    const stillHooked = [];
    plugin.setup({
      session: { hook: (name) => stillHooked.push(name) },
      tool: {
        transform: () => {
          throw new Error('no tool domain');
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stillHooked.length, 3, 'a refused tool editor must not cost the injection');
  } finally {
    if (previous === undefined) delete process.env.OC_GRAPHIFY_CONFIG
    else process.env.OC_GRAPHIFY_CONFIG = previous
  }
});

test('freshness: the vault command decides, hidden and with a real runtime', () => {
  const atlas = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-graphify-fresh-'));
  fs.mkdirSync(path.join(atlas, '.graphify', 'tools'), { recursive: true });
  fs.writeFileSync(path.join(atlas, '.graphify', 'tools', 'graph-freshness.mjs'), '// stub\n');

  const calls = [];
  const exec = (file, args, options) => {
    calls.push({ file, args, options });
    return 'graph fresh: built from abc; no corpus input changed\n';
  };
  assert.deepEqual(askFreshness(atlas, { exec }), {
    state: 'fresh',
    detail: 'built from abc; no corpus input changed',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.windowsHide, true, 'the freshness child must never get a console');
  assert.ok(isJsRuntime(calls[0].file), `spawned ${calls[0].file}, which is not a JS runtime`);

  const stale = Object.assign(new Error('exit 1'), {
    status: 1,
    stdout: '',
    stderr: 'graph-freshness: graph is stale (built from a, HEAD b; 2 corpus inputs changed)\n  note.md\n',
  });
  assert.deepEqual(askFreshness(atlas, { exec: () => { throw stale; } }), {
    state: 'stale',
    detail: 'graph is stale (built from a, HEAD b; 2 corpus inputs changed)',
  });

  const broken = Object.assign(new Error('ENOENT'), { status: 127, stdout: '', stderr: 'node: not found' });
  assert.equal(askFreshness(atlas, { exec: () => { throw broken; } }), null, 'a broken tool is not a verdict');
  assert.equal(askFreshness(path.join(os.tmpdir(), 'oc-graphify-absent-atlas')), null);
  assert.equal(
    askFreshness(atlas, { exec, runtime: 'C:\\Users\\nathan\\scoop\\persist\\bun\\install\\global\\node_modules\\@opencode\\cli\\bin\\opencode.exe' }),
    null,
    'the compiled host binary is not a JavaScript runtime',
  );
});

test('runtime: the compiled host binary is never chosen', () => {
  const host = 'C:\\Users\\nathan\\scoop\\persist\\bun\\install\\global\\node_modules\\@opencode\\cli\\bin\\opencode.exe';
  assert.equal(isJsRuntime(host), false);
  assert.equal(isJsRuntime('C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(isJsRuntime('C:\\tools\\bun.exe'), true);

  assert.equal(
    runtimePath({ execPath: host, env: {}, which: (name) => (name === 'bun' ? 'C:\\tools\\bun.exe' : null) }),
    'C:\\tools\\bun.exe',
  );
  assert.equal(runtimePath({ execPath: host, env: {}, which: () => null }), 'bun', 'PATH resolves bun, never the host');
  assert.equal(
    runtimePath({ execPath: 'C:\\Program Files\\nodejs\\node.exe', env: {} }),
    'C:\\Program Files\\nodejs\\node.exe',
  );
  assert.equal(
    runtimePath({ execPath: host, env: { OC_GRAPHIFY_RUNTIME: ' C:\\tools\\node.exe ' }, which: () => null }),
    'C:\\tools\\node.exe',
  );
});

test('setup: the module shape is what OpenCode 2 loads', () => {
  assert.equal(plugin.id, 'oc-graphify');
  assert.equal(typeof plugin.setup, 'function');
});

test('live: graphify.json records an atlas that has a graph', { skip: !hasHost }, () => {
  const config = readConfig(CONFIG);
  assert.ok(config, `${CONFIG} must record an atlas`);
  assert.ok(fs.existsSync(graphFile(config.atlas)), `no graph at ${graphFile(config.atlas)}`);
});

test('live: the real graph parses and agrees with git', { skip: !hasHost }, () => {
  const { atlas } = readConfig(CONFIG);
  const graph = readGraph(atlas);
  assert.ok(graph, 'readGraph returned null on the live atlas');
  assert.ok(graph.nodes > 100, `only ${graph.nodes} nodes`);
  assert.ok(graph.edges > 100, `only ${graph.edges} edges`);
  assert.ok(graph.communities > 1, `only ${graph.communities} communities`);
  assert.match(graph.commit, /^[0-9a-f]{40}$/);

  const head = headCommit(atlas);
  assert.ok(head, 'git could not read HEAD of the atlas');
  const state = verdict(graph, head);
  assert.ok(['fresh', 'stale'].includes(state), `unexpected state ${state}`);
  // A stale graph is an allowed outcome - it is reported, not hidden.
  if (state === 'stale') console.log(`  note: atlas is stale (${short(graph.commit)} vs HEAD ${short(head)})`);
});

test('live: AGENTS.md and graphify.json name the same atlas', { skip: !hasHost || !fs.existsSync(path.join(HOST, 'AGENTS.md')) }, () => {
  const config = readConfig(CONFIG);
  const agents = fs.readFileSync(path.join(HOST, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(config.atlas), `AGENTS.md does not name ${config.atlas}: one of the two records drifted`);
});

test('live: the installed plugin resolves back to this package', { skip: !fs.existsSync(INSTALLED) }, () => {
  assert.equal(
    fs.realpathSync(INSTALLED).toLowerCase(),
    fs.realpathSync(PKG).toLowerCase(),
    `${INSTALLED} does not resolve to ${PKG}; a copy shadows the repository`,
  );
});

test('live: the vendor reminder plugin is not installed beside this one', { skip: !hasHost }, () => {
  assert.ok(
    !fs.existsSync(VENDOR),
    `${VENDOR} re-appeared (graphify install --platform opencode). It rewrites shell commands and duplicates this plugin; delete it.`,
  );
});

test('repo: the workspace plan knows this package', () => {
  const plan = fs.readFileSync(path.join(REPO, 'scripts', 'workspace-plan.mjs'), 'utf8');
  assert.ok(plan.includes(`"${manifest.name}"`), `scripts/workspace-plan.mjs has no entry for ${manifest.name}`);
});
