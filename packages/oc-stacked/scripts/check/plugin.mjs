/**
 * The load surface: the V2 id and setup, the V1 export, the one-way import
 * boundaries, the namespace the host is handed, and the vanilla install - what
 * a stranger gets from this plugin alone in a directory that had nothing.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import plugin, { StackedPlugin } from '../../index.js';
import { loadCards } from '../../lib/router.js';
import { readSkills, skillsDir } from '../../lib/content.js';

/** The two seats this package ships, and the only agent files it may install. */
const SEATS = ['lead', 'morph'];
/** Long enough to be a task, and worded so the cards route it to `backend`. */
const VANILLA_PROMPT = 'the login endpoint in our backend returns 500 on every request';
const VANILLA_SESSION = 'ses_vanilla';

/** Every path under `dir`, directories with a trailing slash, so a create shows. */
function treeOf(dir) {
  const out = [];
  const walk = (at, rel) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(entry.isDirectory() ? `${name}/` : name);
      if (entry.isDirectory()) walk(path.join(at, entry.name), name);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * A host that records instead of shipping: every surface `setup` registers on
 * is here, and what it hands over is what the cases read. No event loop, so the
 * fixture owns no subscription that outlives the run.
 */
function fakeHost(dir) {
  const host = {
    dir,
    skillCalls: 0,
    skills: [],
    toolCalls: 0,
    tools: [],
    namespace: null,
    hooks: new Map(),
    toolHooks: new Map(),
    instructions: [],
    titles: [],
    synthetic: [],
  };
  host.ctx = {
    location: { directory: dir },
    app: { version: 'vanilla-check' },
    skill: {
      transform: async (fn) => {
        host.skillCalls += 1;
        return fn({ add: (skill) => host.skills.push(skill) });
      },
    },
    tool: {
      transform: async (fn) => {
        host.toolCalls += 1;
        return fn({
          namespace: (value) => {
            host.namespace = value;
          },
          add: (tool) => host.tools.push(tool),
        });
      },
      hook: async (name, fn) => host.toolHooks.set(name, fn),
    },
    session: {
      hook: async (name, fn) => host.hooks.set(name, fn),
      get: async ({ sessionID }) => ({ id: sessionID, directory: dir, title: '' }),
      update: async (input) => host.titles.push(input),
      synthetic: async (input) => host.synthetic.push(input),
      instructions: { entry: { put: async (input) => host.instructions.push(input) } },
    },
  };
  return host;
}

let vanillaPromise = null;

/**
 * The one takeover this subject reads: a fresh temporary root holding one
 * `project/` directory, `git init`-ed and otherwise empty - the folder a
 * stranger opens. `git init` is not the plugin's work: `lib/state.js` treats a
 * directory as a project only when it has a repository or a build manifest, and
 * a new project is a repository. The tree is snapshotted before and after
 * `setup`, so the cases can tell what the plugin wrote and where.
 */
function vanilla() {
  if (!vanillaPromise) vanillaPromise = buildVanilla();
  return vanillaPromise;
}

async function buildVanilla() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-vanilla-'));
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  const before = treeOf(root);
  const host = fakeHost(dir);
  const fixture = { root, dir, host, before, after: [], problem: null };
  // `scripts/check/router.mjs` sets OC_STACKED_NO_SEED=1 for the whole process
  // and never puts it back, so a subject that runs after it would inherit a
  // world no stranger has. The flag is the fixture's, not the product's: clear
  // it for this takeover and hand it back exactly as it was found.
  const noSeed = process.env.OC_STACKED_NO_SEED;
  delete process.env.OC_STACKED_NO_SEED;
  try {
    await plugin.setup(host.ctx);
    fixture.after = treeOf(root);
  } catch (err) {
    fixture.problem = err?.message || String(err);
  } finally {
    if (noSeed === undefined) delete process.env.OC_STACKED_NO_SEED;
    else process.env.OC_STACKED_NO_SEED = noSeed;
  }
  return fixture;
}

export async function register(ctx) {
  const { check, checkAsync, assert, repo } = ctx;

  await checkAsync('registered skill commands forward the invocation to the named skill', async () => {
    const host = fakeHost(repo);
    const commands = [];
    let sent;
    host.ctx.command = { transform: async (fn) => fn({ add: (command) => commands.push(command) }) };
    host.ctx.session.prompt = async (input) => { sent = input; };
    await plugin.setup(host.ctx);
    const ids = readSkills().map((skill) => skill.id);
    assert(commands.length === ids.length && ids.every((id) => commands.some((command) => command.name === id)), 'host did not get every skill command');
    await commands.find((command) => command.name === 'stacked-debug').execute({ sessionID: 'ses_test', prompt: { text: 'crash' }, delivery: 'queue' });
    assert(sent.sessionID === 'ses_test' && sent.delivery === 'queue' && sent.text.includes('`stacked-debug`') && sent.text.includes('crash'), 'command lost skill or arguments');
    return `${commands.length} skill commands registered and one forwarded (mock)`;
  });

  await checkAsync('dispatch refuses before creating a child while parent attenuation is unproven', async () => {
    const host = fakeHost(repo);
    let created = 0;
    host.ctx.permission = { assert: async () => {} };
    host.ctx.session.create = async (value) => { created += 1; return { id: 'ses_child', ...value }; };
    host.ctx.session.prompt = async () => {};
    host.ctx.session.wait = async () => {};
    await plugin.setup(host.ctx);
    const tool = host.tools.find((item) => item.name === 'dispatch');
    assert(tool, 'dispatch tool missing');
    let refused = false;
    try { await tool.execute({ role: 'reviewer', complexity: 'expert', prompt: 'test', files: [] }, { sessionID: 'ses_parent' }); } catch { refused = true; }
    assert(refused && created === 0, 'dispatch created a child without proving parent permission attenuation');
    return 'refused before child creation (mock)';
  });

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

  // ------------------------------------------------------------- vanilla install
  //
  // Install once, open a new directory, and the whole experience is there. Every
  // case below drives the real `setup(ctx)` through the fake host in one fresh
  // project; none of them can pass if `setup` stops doing the work, because
  // nothing else in the fixture writes `.stack`, adds a skill, or routes a prompt.

  const installed = await vanilla();
  const takenOver = (detail) => {
    assert(!installed.problem, `setup did not complete in the fresh project: ${installed.problem}`);
    return detail;
  };

  check('a fresh project is seeded before the first tool call', () => {
    takenOver();
    const stack = path.join(installed.dir, '.stack');
    for (const file of ['config.json', 'ledger.md', 'digest.md']) {
      assert(fs.existsSync(path.join(stack, file)), `setup left no .stack/${file} in a fresh project`);
    }
    const config = JSON.parse(fs.readFileSync(path.join(stack, 'config.json'), 'utf8'));
    assert(Array.isArray(config.checks), `config.checks is ${JSON.stringify(config.checks)}, not an array`);
    return `config + ledger + digest, ${config.checks.length} detected check(s)`;
  });

  check('the catalogue reaches the host: two seats, 22 readable cards', () => {
    takenOver();
    const agentsDir = path.join(repo, 'agents');
    const ids = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .sort();
    assert(
      ids.length === SEATS.length && ids.every((id, at) => id === [...SEATS].sort()[at]),
      `agents/ installs ${ids.join(', ')}; the two seats are ${SEATS.join(', ')}`,
    );

    // The cards are read the way the plugin reads them on every prompt, from
    // the package directory, not from a list here.
    const cards = loadCards(path.join(repo, 'roles'));
    const onDisk = fs.readdirSync(path.join(repo, 'roles')).filter((file) => file.toLowerCase().endsWith('.md'));
    assert(cards.length === 22, `roles/ holds ${cards.length} card(s), not 22`);
    assert(!cards.skipped.length, `cards skipped: ${cards.skipped.map((c) => `${c.id} (${c.reason})`).join(', ')}`);
    assert(cards.length === onDisk.length, `roles/ has ${onDisk.length} .md file(s) but ${cards.length} parsed`);
    for (const id of cards.map((card) => card.id)) {
      assert(fs.existsSync(path.join(repo, 'roles', `${id}.md`)), `card ${id} is not readable in roles/`);
    }
    // A card routes to a seat, so every seat a card names has to be installed.
    const named = [...new Set(cards.map((card) => card.seat))].sort();
    assert(
      named.every((seat) => ids.includes(seat)),
      `cards name the seat(s) ${named.join(', ')} but agents/ installs ${ids.join(', ')}`,
    );
    return `${ids.length} seats, ${cards.length} cards, seats named: ${named.join(', ')}`;
  });

  check('every shipped skill is registered with the host', () => {
    takenOver();
    const onDisk = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')))
      .sort();
    assert(installed.host.skillCalls > 0, 'setup never called ctx.skill.transform');
    assert(onDisk.length >= 16, `skills/ holds ${onDisk.length} skill(s) with a SKILL.md; 16 are documented`);
    const registered = installed.host.skills.map((skill) => skill.id);
    const missing = onDisk.filter((id) => !registered.includes(id));
    assert(!missing.length, `not registered with the host: ${missing.join(', ')}`);
    const duplicated = registered.filter((id, at) => registered.indexOf(id) !== at);
    assert(!duplicated.length, `registered twice: ${[...new Set(duplicated)].join(', ')}`);
    return `${onDisk.length} skill dirs, ${registered.length} ids registered`;
  });

  await checkAsync('the first prompt in a fresh project routes to a seat', async () => {
    takenOver();
    const hook = installed.host.hooks.get('prompt');
    assert(typeof hook === 'function', 'setup registered no `prompt` hook');
    assert(
      !installed.host.instructions.some((entry) => entry.key === 'route'),
      'a route was already put before any prompt was sent',
    );

    await hook({ sessionID: VANILLA_SESSION, prompt: { type: 'text', text: VANILLA_PROMPT } });

    const added = installed.host.instructions.filter((entry) => entry.sessionID === VANILLA_SESSION);
    const route = added.find((entry) => entry.key === 'route');
    assert(
      route,
      `the first prompt put no route; keys put: ${added.map((entry) => entry.key).join(', ') || 'none'}`,
    );
    assert(typeof route.value === 'string' && route.value.length, 'the route value is empty');

    const cards = loadCards(path.join(repo, 'roles'));
    const seats = cards.map((card) => card.seat);
    const seat = [...new Set(seats)].find((name) => new RegExp(`\\b${name}\\b`).test(route.value));
    assert(seat, `the route names no seat (${[...new Set(seats)].join(', ')}): ${route.value}`);

    const named = route.value.match(/Routed: ([a-z0-9-]+)/);
    assert(named, `the route does not name the card it routed to: ${route.value}`);
    const cardFile = path.join(repo, 'roles', `${named[1]}.md`);
    assert(fs.existsSync(cardFile), `the route names ${named[1]}, which has no card at roles/${named[1]}.md`);
    assert(fs.readFileSync(cardFile, 'utf8').length, `roles/${named[1]}.md is empty`);
    return `${named[1]} -> ${seat} in a directory that had no .stack a moment ago`;
  });

  check('setup writes nothing beside the project it takes over', () => {
    takenOver();
    const { before, after } = installed;
    assert(after.length, 'the tree was never re-read after setup');
    const added = after.filter((entry) => !before.includes(entry));
    assert(added.includes('project/.stack/'), `setup created no .stack/ in the fresh project: ${added.join(', ')}`);
    const outside = added.filter((entry) => !entry.startsWith('project/'));
    assert(!outside.length, `setup wrote beside the project: ${outside.join(', ')}`);
    return `${added.length} path(s) created, all under project/`;
  });

  try {
    fs.rmSync(installed.root, { recursive: true, force: true });
  } catch {
    // The OS reclaims tmp; a refused cleanup is not a failed case.
  }
}
