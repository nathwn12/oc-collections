/**
 * The load surface: the V2 id and setup, the V1 export, the one-way import
 * boundaries, and the namespace the host is handed.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin, { StackedPlugin } from '../../index.js';

export async function register(ctx) {
  const { check, checkAsync, assert, repo } = ctx;

  check('plugin exports a V2 id', () => {
    assert(plugin && typeof plugin === 'object', 'default export is not an object');
    assert(plugin.id === 'oc-stacked', `id is ${JSON.stringify(plugin.id)}`);
    return plugin.id;
  });

  check('plugin exports setup() for V2', () => {
    assert(typeof plugin.setup === 'function', 'setup is not a function');
    return 'function';
  });

  check('plugin keeps a V1 server export', () => {
    assert(typeof plugin.server === 'function', 'server export missing');
    assert(typeof StackedPlugin === 'function', 'named V1 export missing');
    return 'StackedPlugin';
  });

  check('lib imports the entry nowhere, and the registry never imports the injected text', () => {
    const libDir = path.join(repo, 'lib');
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const p = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(p) : [p];
      });
    const modules = walk(libDir).filter((p) => p.endsWith('.js'));
    assert(modules.length, 'lib/ has no modules to sweep; this assertion is reading nothing');
    const offenders = [];
    for (const file of modules) {
      const name = path.relative(libDir, file).replace(/\\/g, '/');
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\bfrom\s*)?['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (/(^|\/)index\.js$/.test(spec)) offenders.push(`${name} imports the plugin entry (${spec})`);
        if (name === 'content.js' && /(^|\/)bootstrap\.js$/.test(spec)) offenders.push(`${name} imports ${spec}`);
      }
    }
    assert(!offenders.length, `a one-way boundary is broken: ${offenders.join('; ')}`);
    return `${modules.length} modules, entry and bootstrap both one-way`;
  });

  await checkAsync('the namespace description names the swarm tool', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-ns-'));
    let description = null;
    const editor = {
      namespace: (value) => {
        description = value.description;
      },
      add: () => {},
    };
    const ctx = {
      location: { directory: d },
      app: { version: 'test' },
      skill: { transform: async (fn) => fn(editor) },
      tool: { transform: async (fn) => fn(editor) },
      session: { hook: async () => {}, get: async () => null },
    };
    await plugin.setup(ctx);
    assert(description, 'setup registered no namespace');
    assert(/swarm/i.test(description), `the namespace description omits the swarm: ${description}`);
    fs.rmSync(d, { recursive: true, force: true });
    return 'swarm named';
  });
}
