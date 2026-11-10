#!/usr/bin/env node
/**
 * The plugin's own proving check. No OpenCode required, no network, no deps.
 *
 * It answers one question: if a user installed this today, would the thing that
 * loads actually work? Every assertion here is a way the plugin has failed or
 * could fail silently in a host.
 *
 *   node scripts/check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    pass += 1;
    process.stdout.write(`  pass  ${name}${detail ? `  (${detail})` : ''}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    process.stdout.write(`  pass  ${name}${detail ? `  (${detail})` : ''}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-'));
  spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['config', 'user.email', 'check@local'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['config', 'user.name', 'check'], { cwd: dir, windowsHide: true });
  return dir;
}

function commitAll(dir, message) {
  spawnSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', message], {
    cwd: dir,
    windowsHide: true,
  });
}

/** A repo with one committed, passing check: the fixture every gate test needs. */
function configuredRepo(command = 'node -e "process.exit(0)"') {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, '.stack'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.stack', 'config.json'),
    JSON.stringify({ checks: [{ name: 'ok', command, timeout: 60000 }] }, null, 2),
  );
  commitAll(dir, 'seed config');
  return dir;
}

process.stdout.write('\noc-stacked self-test\n\n');

// ---------------------------------------------------------------- module shape
const mod = await import(new URL('../index.js', import.meta.url));
const plugin = mod.default;
const { readSkills, bootstrap, MARKER } = await import(new URL('../lib/skills.js', import.meta.url));
const { toolDefinitions, checkRecordReasons } = await import(new URL('../lib/tools.js', import.meta.url));
const { parse, needsShell, commandAsync } = await import(new URL('../lib/exec.js', import.meta.url));
const { snapshot } = await import(new URL('../lib/git.js', import.meta.url));
const { seedStack } = await import(new URL('../lib/state.js', import.meta.url));

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
  assert(typeof mod.StackedPlugin === 'function', 'named V1 export missing');
  return 'StackedPlugin';
});

// ---------------------------------------------------------------- skills
const skills = readSkills();

check('sixteen skills register', () => {
  const expected = [
    'stacked',
    'stacked-soul',
    'stacked-pls',
    'stacked-lead',
    'stacked-employee',
    'stacked-audit',
    'stacked-plan',
    'stacked-swarm',
    'stacked-debug',
    'stacked-tdd',
    'stacked-review',
    'stacked-ship',
    'stacked-deepen',
    'stacked-wizard',
    'stacked-oftb',
    'stacked-loop',
  ];
  assert(skills.length === 16, `expected 16, got ${skills.length}: ${skills.map((s) => s.id).join(', ')}`);
  for (const id of expected) assert(skills.some((s) => s.id === id), `missing skill: ${id}`);
  return skills.map((s) => s.id).join(', ');
});

check('skill ids are unique and kebab-case', () => {
  const ids = skills.map((s) => s.id);
  assert(new Set(ids).size === ids.length, `duplicate id: ${ids.join(', ')}`);
  for (const id of ids) assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id), `bad id: ${id}`);
  return `${ids.length} unique`;
});

check('every skill has a description the model can route on', () => {
  for (const s of skills) {
    assert(s.description && s.description.length > 20, `${s.id} has no usable description`);
    assert(s.content && s.content.length > 200, `${s.id} body is too thin (${s.content?.length || 0} chars)`);
    assert(fs.existsSync(s.path), `${s.id} path does not exist: ${s.path}`);
  }
  return `shortest body ${Math.min(...skills.map((s) => s.content.length))} chars`;
});

check('SOUL.md is registered as stacked-soul, not duplicated', () => {
  const soul = skills.find((s) => s.id === 'stacked-soul');
  assert(soul, 'stacked-soul missing');
  assert(soul.path.endsWith('SOUL.md'), `soul path is ${soul.path}`);
  assert(!fs.existsSync(path.join(repo, 'skills', 'stacked-soul')), 'a duplicate skills/stacked-soul directory exists');
  for (const law of ['Law 1', 'Law 2', 'Law 3', 'Law 4']) assert(soul.content.includes(law), `soul is missing ${law}`);
  return 'four laws present';
});

/** The ids the README's skills table advertises, read from that section only. */
function readmeSkillsTable() {
  const text = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  const start = text.indexOf('## The skills');
  assert(start >= 0, 'README.md has no "The skills" section');
  const rest = text.slice(start + 1);
  const end = rest.search(/\n## /);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  return [...body.matchAll(/^\|\s*`([a-z0-9][a-z0-9-]*)`\s*\|/gm)].map((m) => m[1]);
}

check('every skill the docs tell an agent to load is registered', () => {
  const ids = new Set(skills.map((s) => s.id));
  const refs = [];
  const scan = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:Load|Read)\s+`([a-z0-9][a-z0-9-]*)`/gi)) {
      refs.push([m[1], path.relative(repo, file)]);
    }
  };
  for (const f of fs.readdirSync(path.join(repo, 'agents'))) {
    if (f.endsWith('.md')) scan(path.join(repo, 'agents', f));
  }
  for (const entry of fs.readdirSync(path.join(repo, 'skills'), { withFileTypes: true })) {
    const file = path.join(repo, 'skills', entry.name, 'SKILL.md');
    if (entry.isDirectory() && fs.existsSync(file)) scan(file);
  }
  assert(refs.length >= 4, `the scan found only ${refs.length} Load/Read references; it is not reading the docs`);
  const missing = refs.filter(([id]) => !ids.has(id));
  assert(!missing.length, `docs load skills that are not registered: ${missing.map(([id, where]) => `${id} (${where})`).join(', ')}`);
  return `${refs.length} references resolve`;
});

check('the README skills table and the registry cannot drift', () => {
  const ids = skills.map((s) => s.id);
  const table = readmeSkillsTable();
  const unregistered = table.filter((id) => !ids.includes(id));
  const undocumented = ids.filter((id) => !table.includes(id));
  assert(!unregistered.length, `the README lists skills that are not registered: ${unregistered.join(', ')}`);
  assert(!undocumented.length, `the README omits registered skills: ${undocumented.join(', ')}`);
  assert(new Set(table).size === table.length, `the README lists a skill twice: ${table.join(', ')}`);
  return `${table.length} ids agree`;
});

check('the installer advertises the registered skill ids, with prefixes', () => {
  const text = fs.readFileSync(path.join(repo, 'scripts', 'install.mjs'), 'utf8');
  const list = text.match(/skills register:([\s\S]*?)\n\s*3\.\s/);
  assert(list, 'the installer no longer lists the skill ids it registers');
  const advertised = list[1].split(',').map((s) => s.trim()).filter(Boolean);
  const ids = skills.map((s) => s.id);
  const missing = ids.filter((id) => !advertised.includes(id));
  const extra = advertised.filter((id) => !ids.includes(id));
  assert(!missing.length, `the installer omits registered skills: ${missing.join(', ')}`);
  assert(!extra.length, `the installer names ids that are not registered: ${extra.join(', ')}`);
  return `${advertised.length} ids advertised`;
});

check('stacked-pls names both exits, and shape comes first', () => {
  const pls = skills.find((s) => s.id === 'stacked-pls');
  assert(pls, 'stacked-pls is not registered');
  const body = pls.content;
  const shape = body.indexOf('## Shape, or execute');
  const execute = body.indexOf('## Execute');
  assert(shape >= 0, 'stacked-pls has no "Shape, or execute" section');
  assert(execute >= 0, 'stacked-pls has no "Execute" section');
  assert(shape < execute, `the shape section must precede the execute section (${shape} vs ${execute})`);
  assert(/\*\*Shape\*\*/.test(body) && /\*\*Execute\*\*/.test(body), 'the two exits are not both named');
  assert(/Default is execute/.test(body), 'the default exit is not stated');
  return 'shape first, execute second';
});

check('stacked teaches sharp output, not a separate voice section', () => {
  const stacked = skills.find((s) => s.id === 'stacked');
  assert(stacked, 'stacked is not registered');
  assert(/^## Sharp output$/m.test(stacked.content), 'stacked has no "## Sharp output" section');
  assert(!/^## Voice$/m.test(stacked.content), '"## Voice" still exists as a separate section');
  assert(/Lead with the next action/.test(stacked.content), 'the section does not lead with an action');
  assert(bootstrap().includes('Answer for action'), 'the bootstrap does not carry the action line');
  assert(/five items max/.test(bootstrap()), 'the bootstrap line does not cap the list');
  return 'action contract in skill and bootstrap';
});

check('sharp output is an action contract with a pre-send check', () => {
  const stacked = skills.find((s) => s.id === 'stacked').content;
  for (const phrase of ['Lead with the next action', 'Cap visible lists at five', 'No preamble', 'Pre-send check']) {
    assert(stacked.includes(phrase), `stacked is missing "${phrase}"`);
  }
  const soul = fs.readFileSync(path.join(repo, 'SOUL.md'), 'utf8');
  assert(soul.includes('does it need to exist'), 'SOUL.md has no laziness ladder');
  assert(/deletion beats addition/i.test(soul), 'SOUL.md does not say deletion beats addition');
  for (const id of ['stacked-pls', 'stacked-employee']) {
    assert(/what you skipped/.test(skills.find((s) => s.id === id).content), `${id} has no honest tail`);
  }
  const eng = fs.readFileSync(path.join(repo, 'skills', 'stacked-employee', 'references', 'engineering.md'), 'utf8');
  assert(/does it need to exist/i.test(eng), 'the engineering handbook has no ladder');
  return 'ten rules, pre-send check, ladder in SOUL and engineering';
});

check('the lead writes savepoints', () => {
  const lead = fs.readFileSync(path.join(repo, 'skills', 'stacked-lead', 'SKILL.md'), 'utf8');
  assert(/^## Savepoints$/m.test(lead), 'stacked-lead has no Savepoints section');
  assert(lead.includes('chore: savepoint'), 'stacked-lead does not name the savepoint commit type');
  assert(!lead.includes('`savepoint:`'), 'stacked-lead still uses savepoint: as a prefix');
  const owner = fs.readFileSync(path.join(repo, 'OWNER.md'), 'utf8');
  assert(/never be allowed to get dirty/.test(owner), 'OWNER.md has no savepoint rule');
  return 'five savepoints, chore: type, owner rule';
});

check('the session-title convention is one vocabulary', () => {
  const owner = fs.readFileSync(path.join(repo, 'OWNER.md'), 'utf8');
  for (const status of ['[active]', '[parked]', '[done]']) {
    assert(owner.includes(status), `OWNER.md is missing ${status}`);
  }
  assert(/immutable/.test(owner), 'OWNER.md does not make [done] immutable');
  for (const id of ['stacked-lead', 'stacked-pls']) {
    assert(fs.readFileSync(path.join(repo, 'skills', id, 'SKILL.md'), 'utf8').includes('[done]'), `${id} never sets [done]`);
  }
  return 'three statuses, immutable [done], both skills set it';
});

// ---------------------------------------------------------------- the fallback CLI
const cli = path.join(repo, 'bin', 'stack.js');
const cliRun = (args, cwd) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', windowsHide: true });

check('the fallback CLI answers --help with every command', () => {
  const r = cliRun(['--help'], repo);
  assert(r.status === 0, `--help exited ${r.status}: ${r.stderr}`);
  for (const name of ['check', 'ready', 'clean', 'ledger']) assert(r.stdout.includes(name), `--help never names ${name}`);
  return 'check, ready, clean, ledger';
});

check('bad usage exits 2', () => {
  const missing = cliRun(['ready'], repo);
  assert(missing.status === 2, `ready with no --id exited ${missing.status}`);
  const unknown = cliRun(['wizard'], repo);
  assert(unknown.status === 2, `an unknown command exited ${unknown.status}`);
  return 'missing --id and unknown command both exit 2';
});

await checkAsync('the CLI runs the gate with no plugin loaded', async () => {
  const d = tmpRepo();
  fs.writeFileSync(
    path.join(d, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  const init = cliRun(['check', 'init'], d);
  assert(init.status === 0, `check init exited ${init.status}: ${init.stdout}${init.stderr}`);
  const run = cliRun(['check', 'run'], d);
  assert(run.status === 0, `check run exited ${run.status}: ${run.stdout}${run.stderr}`);
  const refused = cliRun(['ready', '--id', 'missing'], d);
  assert(refused.status === 1, `ready on a missing seam exited ${refused.status}`);
  assert(/missing/.test(refused.stdout), `the refusal did not name the seam:\n${refused.stdout}`);
  fs.rmSync(d, { recursive: true, force: true });
  return 'init 0, run 0, refusal 1';
});

check('the CLI cannot depend on the plugin entry point', () => {
  const raw = fs.readFileSync(path.join(repo, 'bin', 'stack.js'), 'utf8');
  assert(!/from\s+['"]\.\.\/index\.js['"]/.test(raw), 'bin/stack.js imports the plugin entry point');
  assert(!/\bspawn\(/.test(raw), 'bin/stack.js spawns a process of its own');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert(pkg.bin && pkg.bin.stack === './bin/stack.js', 'package.json has no stack bin entry');
  return 'no index.js import, no spawn, bin declared';
});

check('the release convention is written down and wired', () => {
  const p = path.join(repo, 'RELEASING.md');
  assert(fs.existsSync(p), 'RELEASING.md is missing');
  const rel = fs.readFileSync(p, 'utf8');
  for (const phrase of ['tag', 'npm view', 'never force-push', 'Conventional Commits', 'imperative']) {
    assert(new RegExp(phrase, 'i').test(rel), `RELEASING.md is missing "${phrase}"`);
  }
  assert(rel.includes('<type>(<scope>): <imperative summary>'), 'RELEASING.md has no commit format');
  const ship = fs.readFileSync(path.join(repo, 'skills', 'stacked-ship', 'SKILL.md'), 'utf8');
  assert(/^## Release$/m.test(ship), 'stacked-ship has no "## Release" section');
  assert(ship.includes('`<type>(<scope>): <imperative summary>`'), 'stacked-ship does not state the commit format');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert(pkg.scripts && pkg.scripts.prepublishOnly, 'package.json has no prepublishOnly: the suite is not the publish gate');
  assert(pkg.private === true, 'package.json is no longer private, so publishing is no longer an owner decision');
  const owner = fs.readFileSync(path.join(repo, 'OWNER.md'), 'utf8');
  assert(/Adopt the upstream format/.test(owner), 'OWNER.md does not adopt the upstream format');
  return 'RELEASING.md, ship, prepublishOnly, owner line';
});

check('stacked-pls answers an invocation with no task', () => {
  const pls = skills.find((s) => s.id === 'stacked-pls');
  assert(pls, 'stacked-pls is not registered');
  assert(/^## Invoked bare$/m.test(pls.content), 'stacked-pls has no "## Invoked bare" section');
  assert(pls.content.includes('@stacked-pls'), 'the bare-invocation section does not name @stacked-pls');
  assert(/file:line/.test(pls.content), 'the bare-invocation section does not require file:line evidence');
  return 'bare invocation defined';
});

check('bootstrap is cached, marked, and small', () => {
  const a = bootstrap();
  const b = bootstrap();
  assert(a === b, 'bootstrap is rebuilt on every call (cache miss)');
  assert(a.startsWith(MARKER), 'bootstrap does not start with its marker');
  assert(a.includes('</STACKED>'), 'bootstrap has no closing marker');
  assert(a.length < 9000, `bootstrap is ${a.length} chars; it is paid for on every step`);
  assert(a.includes('lead') || a.includes('LEAD'), 'bootstrap does not name the rungs');
  assert(!/\bCEO\b|\bceo\b/.test(a), 'bootstrap still names a CEO seat that no longer exists');
  assert(a.length < 3600, `bootstrap is ${a.length} chars; it is paid for on every step (raised from 3200 when the route table became always-on)`);
  return `${a.length} chars`;
});

// ---------------------------------------------------------------- tools
const dir = tmpRepo();
const tools = toolDefinitions({ dir });

check('seven tools are defined', () => {
  assert(tools.length === 7, `expected 7, got ${tools.length}`);
  const names = tools.map((t) => t.name);
  for (const required of ['ledger', 'brief', 'swarm', 'check', 'scope', 'ready', 'clean']) {
    assert(names.includes(required), `missing tool: ${required}`);
  }
  return names.join(', ');
});

check('every tool declares a valid, self-consistent input schema', () => {
  for (const t of tools) {
    assert(t.name && typeof t.name === 'string', 'tool without a name');
    assert(t.description && t.description.length > 40, `${t.name} description is too thin`);
    assert(typeof t.execute === 'function', `${t.name} has no execute`);
    assert(t.input && t.input.type === 'object', `${t.name} input is not an object schema`);
    assert(t.input.properties && Object.keys(t.input.properties).length, `${t.name} has no properties`);
    for (const key of t.input.required || []) {
      assert(t.input.properties[key], `${t.name} requires unknown property "${key}"`);
    }
    for (const [key, prop] of Object.entries(t.input.properties)) {
      assert(prop.type, `${t.name}.${key} has no type`);
      if (prop.type === 'string' && prop.enum) {
        assert(prop.enum.every((v) => typeof v === 'string'), `${t.name}.${key} enum has a non-string`);
      }
    }
    const json = JSON.stringify(t.input);
    assert(!json.includes('undefined'), `${t.name} schema contains undefined`);
  }
  return 'schemas consistent';
});

// ---------------------------------------------------------------- behaviour
const tool = (name) => tools.find((t) => t.name === name);
const run = async (name, input) => {
  const result = await tool(name).execute(input, {});
  const content = typeof result === 'string' ? result : result?.content;
  assert(typeof content === 'string' && content.length, `${name} returned no content`);
  return content;
};
const runIn = async (otherDir, name, input) => {
  const def = toolDefinitions({ dir: otherDir }).find((t) => t.name === name);
  const result = await def.execute(input, {});
  const content = typeof result === 'string' ? result : result?.content;
  assert(typeof content === 'string' && content.length, `${name} returned no content in ${otherDir}`);
  return content;
};

// Config is executable content, and the gate treats a config change since the
// seam began as a finding. So the config exists and is committed before the
// first brief, exactly as a real project seeds and commits it.
fs.mkdirSync(path.join(dir, '.stack'), { recursive: true });
fs.writeFileSync(
  path.join(dir, '.stack', 'config.json'),
  JSON.stringify({ checks: [{ name: 'smoke', command: 'node -e "process.exit(0)"', timeout: 30000 }] }, null, 2),
);
spawnSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', 'seed config'], { cwd: dir, windowsHide: true });

await checkAsync('brief refuses a seam with a hole', async () => {
  const out = await run('brief', { op: 'new', agent: 'backend', title: 'half a seam', out: 'something', owns: ['src/**'] });
  assert(/Refused/i.test(out), 'a brief without a check was accepted');
  assert(!fs.existsSync(path.join(dir, '.stack', 'briefs', 'half-a-seam.md')), 'the refused brief was still written');
  return 'no check, no brief';
});

await checkAsync('brief writes a contract that names the check', async () => {
  const out = await run('brief', {
    op: 'new', agent: 'backend',
    title: 'retry budget',
    out: 'a failing endpoint is retried at most three times',
    check: 'node -e "process.exit(0)"',
    owns: ['src/**', '.stack/**'],
    why: 'production retries never stop',
    tier: 'standard',
  });
  assert(/Brief written/i.test(out), `unexpected reply: ${out.slice(0, 120)}`);
  const file = path.join(dir, '.stack', 'briefs', 'retry-budget.md');
  assert(fs.existsSync(file), 'brief file missing');
  const body = fs.readFileSync(file, 'utf8');
  assert(body.includes('## Out') && body.includes('## Check') && body.includes('## Owns'), 'brief missing a section');
  return 'retry-budget.md';
});

await checkAsync('ledger appends and the digest is derived from it', async () => {
  await run('ledger', { op: 'log', kind: 'ASK', text: 'D1 · ship before the release? recommend yes because the check is green' });
  await run('ledger', { op: 'log', kind: 'NOTE', text: 'intake: make webhooks retry honestly' });
  const digest = await run('ledger', { op: 'digest' });
  assert(digest.includes('## Needs you'), 'digest has no Needs-you section');
  assert(digest.includes('D1 ·'), 'digest dropped the open ask');
  assert(digest.includes('## In progress'), 'digest has no In-progress section');
  assert(digest.includes('retry-budget'), 'digest does not list the live brief');
  assert(fs.existsSync(path.join(dir, '.stack', 'digest.md')), 'digest.md was not written');
  const tail = await run('ledger', { op: 'tail', limit: 5 });
  assert(tail.includes('ASK'), 'tail dropped an entry');
  return 'Needs you / New / In progress';
});

await checkAsync('check init detects nothing and says so honestly', async () => {
  const emptyDir = tmpRepo();
  const out = await runIn(emptyDir, 'check', { op: 'init' });
  assert(/no check could be detected/i.test(out), `unexpected: ${out.slice(0, 160)}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(emptyDir, '.stack', 'config.json'), 'utf8'));
  assert(Array.isArray(cfg.checks) && cfg.checks.length === 0, 'config was not written with an empty list');
  fs.rmSync(emptyDir, { recursive: true, force: true });
  return 'empty list, UNPROVEN';
});

await checkAsync('check runs a configured command and binds it to HEAD', async () => {
  const out = await run('check', { op: 'run' });
  assert(/GREEN/.test(out), `expected GREEN, got: ${out.slice(0, 160)}`);
  const record = JSON.parse(fs.readFileSync(path.join(dir, '.stack', 'state', 'checks.json'), 'utf8'));
  assert(record.results[0].ok === true, 'result not recorded as ok');
  assert('head' in record, 'record is not bound to a HEAD');
  assert(out.includes('node -e'), 'the command itself is not printed, so nobody can audit it');
  return 'GREEN at HEAD, command printed';
});

await checkAsync('check reports RED, not green, on a failing command', async () => {
  const redDir = tmpRepo();
  fs.mkdirSync(path.join(redDir, '.stack'), { recursive: true });
  fs.writeFileSync(
    path.join(redDir, '.stack', 'config.json'),
    JSON.stringify({ checks: [{ name: 'broken', command: 'node -e "process.exit(3)"', timeout: 30000 }] }, null, 2),
  );
  const out = await runIn(redDir, 'check', { op: 'run' });
  assert(/RED/.test(out) && !/GREEN/.test(out), `a failing command was not called RED: ${out.slice(0, 160)}`);
  fs.rmSync(redDir, { recursive: true, force: true });
  return 'exit 3 → RED';
});

await checkAsync('scope names what left the brief', async () => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'webhook.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'outside.ts'), 'export const y = 1;\n');
  const out = await run('scope', { id: 'retry-budget' });
  assert(/OUT/.test(out), 'an out-of-bounds path was not flagged');
  assert(out.includes('outside.ts'), 'the out-of-bounds file is not named');
  assert(!/OUT.*webhook\.ts/.test(out), 'an in-bounds file was wrongly flagged');
  return 'outside.ts flagged';
});

await checkAsync('ready is NO-GO while the tree is dirty, and names why', async () => {
  const out = await run('ready', { id: 'retry-budget' });
  assert(/NO-GO/.test(out), 'a dirty tree was gated GO');
  assert(/report missing|uncommitted|RED/i.test(out), 'no reason was named');
  return out.split('\n')[0].replace('## ', '');
});

await checkAsync('ready is NO-GO with no report even when the check is green', async () => {
  await run('check', { op: 'run' });
  const out = await run('ready', { id: 'retry-budget' });
  assert(/NO-GO/.test(out), 'a seam with no report was gated GO');
  assert(/report missing/i.test(out), 'the missing report was not named');
  return 'report is not optional';
});

await checkAsync('ready turns GO only when nothing is left to verify', async () => {
  // Commit everything, write the report, prove the check at the new HEAD.
  fs.writeFileSync(path.join(dir, '.stack', 'reports', 'retry-budget.md'), [
    '# retry budget',
    '',
    '## Outcome',
    '',
    'Retries stop at three.',
    '',
    '## Evidence',
    '',
    '`node -e "process.exit(0)"` exit 0.',
    '',
    '## Unverified',
    '',
    'none',
    '',
    '## Scope',
    '',
    '`src/webhook.ts` only.',
    '',
    '## Lesson',
    '',
    'A counter that resets is not a counter.',
    '',
  ].join('\n'));
  // Make the brief's Owns cover everything actually touched.
  const briefFile = path.join(dir, '.stack', 'briefs', 'retry-budget.md');
  fs.writeFileSync(briefFile, fs.readFileSync(briefFile, 'utf8').replace('- `src/**`', '- `src/**`\n- `outside.ts`'));
  const index = JSON.parse(fs.readFileSync(path.join(dir, '.stack', 'state', 'briefs.json'), 'utf8'));
  index[0].owns = ['src/**', 'outside.ts', '.stack/**'];
  fs.writeFileSync(path.join(dir, '.stack', 'state', 'briefs.json'), JSON.stringify(index, null, 2));

  spawnSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', 'retry budget'], {
    cwd: dir,
    windowsHide: true,
  });
  await run('check', { op: 'run' });
  const out = await run('ready', { id: 'retry-budget' });
  assert(/## GO\b/.test(out), `expected GO, got:\n${out}`);
  return 'GO on committed, checked, reported work';
});

await checkAsync('ready re-runs the checks at the head it gates', async () => {
  const before = JSON.parse(fs.readFileSync(path.join(dir, '.stack', 'state', 'checks.json'), 'utf8')).head;
  fs.writeFileSync(path.join(dir, 'src', 'webhook.ts'), 'export const x = 2;\n');
  commitAll(dir, 'move head');
  const out = await run('ready', { id: 'retry-budget' });
  assert(/## GO\b/.test(out), `expected GO after a green re-run at the new HEAD, got:\n${out}`);
  const now = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const after = JSON.parse(fs.readFileSync(path.join(dir, '.stack', 'state', 'checks.json'), 'utf8'));
  assert(after.head === now, `the gate did not re-run the check at HEAD (${after.head} vs ${now})`);
  assert(before !== now, 'the head did not actually move, so this proves nothing');
  return 're-ran at the new head';
});

// ---------------------------------------------------------------- swarm
const swarmDir = tmpRepo();
const swarmTools = toolDefinitions({ dir: swarmDir });
const runSwarm = async (input) => {
  const result = await swarmTools.find((t) => t.name === 'swarm').execute(input, {});
  return typeof result === 'string' ? result : result?.content;
};
const seam = (id, file, extra = {}) => ({
  id,
  title: id,
  out: `${id} is done`,
  check: 'node -e "process.exit(0)"',
  files: [file],
  agent: 'backend',
  ...extra,
});

await checkAsync('swarm refuses a single seam as fan-out of one', async () => {
  const out = await runSwarm({ seams: [seam('a', 'src/a.ts')] });
  assert(/Refused/.test(out), 'one seam was accepted as a swarm');
  return 'two is the floor';
});

await checkAsync('swarm refuses eleven seams at the hard ceiling', async () => {
  const seams = Array.from({ length: 11 }, (_, i) => seam(`s${i}`, `src/f${i}.ts`));
  const out = await runSwarm({ seams });
  assert(/Refused/.test(out), 'eleven seams were accepted');
  assert(/ceiling of 10/.test(out), 'the ceiling was not named');
  return 'ten is the ceiling';
});

await checkAsync('swarm refuses two seams that share one file', async () => {
  const out = await runSwarm({
    seams: [seam('alpha', 'src/auth/session.ts'), seam('beta', 'src/auth/session.ts')],
  });
  assert(/Refused/.test(out), 'a shared file was accepted');
  assert(/session\.ts/.test(out), 'the shared file was not named');
  const index = fs.existsSync(path.join(swarmDir, '.stack', 'state', 'briefs.json'))
    ? JSON.parse(fs.readFileSync(path.join(swarmDir, '.stack', 'state', 'briefs.json'), 'utf8'))
    : [];
  assert(index.length === 0, 'a refused swarm still wrote briefs');
  return 'none written';
});

await checkAsync('swarm writes four disjoint briefs with a dispatch prompt each', async () => {
  const out = await runSwarm({
    why: 'four independent surfaces',
    seams: [
      seam('auth-form', 'src/auth/form.tsx'),
      seam('auth-store', 'src/auth/store.ts'),
      seam('billing-api', 'src/billing/api.ts'),
      seam('docs', 'docs/auth.md'),
    ],
  });
  assert(/Swarm of 4/.test(out), `unexpected: ${out.slice(0, 140)}`);
  assert((out.match(/Seam: /g) || []).length === 4, 'not one dispatch prompt per seam');
  const index = JSON.parse(fs.readFileSync(path.join(swarmDir, '.stack', 'state', 'briefs.json'), 'utf8'));
  assert(index.length === 4, `index has ${index.length} seams`);
  for (const b of index) assert(b.files.length === 1, `${b.id} lost its file list`);
  return '4 seams, same folder, no shared file';
});

await checkAsync('brief refuses a file a live swarm seam already owns', async () => {
  const briefTool = swarmTools.find((t) => t.name === 'brief');
  const result = await briefTool.execute(
    {
      op: 'new', agent: 'backend',
      title: 'late arrival',
      out: 'one more thing',
      check: 'node -e "process.exit(0)"',
      owns: ['src/auth/**'],
      files: ['src/auth/store.ts'],
    },
    {},
  );
  const out = typeof result === 'string' ? result : result.content;
  assert(/Refused/.test(out), 'a colliding brief was accepted');
  assert(/auth-store/.test(out), 'the colliding seam was not named');
  return 'collision named';
});

await checkAsync('brief allows a neighbour in the same folder on another file', async () => {
  const briefTool = swarmTools.find((t) => t.name === 'brief');
  const result = await briefTool.execute(
    {
      op: 'new', agent: 'backend',
      title: 'auth guard',
      out: 'a guard in the same folder',
      check: 'node -e "process.exit(0)"',
      owns: ['src/auth/**'],
      files: ['src/auth/guard.ts'],
    },
    {},
  );
  const out = typeof result === 'string' ? result : result.content;
  assert(/Brief written/.test(out), `a same-folder neighbour was refused: ${out.slice(0, 160)}`);
  return 'folder is not the boundary, the file is';
});

fs.rmSync(swarmDir, { recursive: true, force: true });

await checkAsync('marking a seam landed without a GO is refused', async () => {
  await run('brief', {
    op: 'new', agent: 'backend',
    title: 'no gate yet',
    out: 'something nobody proved',
    check: 'node -e "process.exit(0)"',
    owns: ['notes/**'],
    files: ['notes/plan.md'],
  });
  const out = await run('brief', { op: 'status', id: 'no-gate-yet', status: 'landed' });
  assert(/Refused/.test(out), 'a seam landed with no gate at all');
  assert(/no gate has run|cannot be marked landed/i.test(out), 'the reason was not named');
  const index = JSON.parse(fs.readFileSync(path.join(dir, '.stack', 'state', 'briefs.json'), 'utf8'));
  assert(index.find((b) => b.id === 'no-gate-yet').status === 'briefed', 'the status changed anyway');
  return 'status unchanged';
});

await checkAsync('landing after a NO-GO is refused, and force records why', async () => {
  // The gate must log a RED for this seam before we can prove the landing gate
  // reads it. A dirty tree is the cheapest honest way to be refused.
  fs.writeFileSync(path.join(dir, 'src', 'uncommitted.ts'), 'export const z = 1;\n');
  const gate = await run('ready', { id: 'retry-budget' });
  assert(/NO-GO/.test(gate), `the dirty tree was gated GO:\n${gate}`);
  const refused = await run('brief', { op: 'status', id: 'retry-budget', status: 'landed' });
  assert(/Refused/.test(refused), 'a NO-GO seam was marked landed');
  assert(/RED/.test(refused), 'the last verdict was not quoted');
  fs.rmSync(path.join(dir, 'src', 'uncommitted.ts'), { force: true });
  const forced = await run('brief', { op: 'status', id: 'retry-budget', status: 'landed', force: true });
  assert(/landed/.test(forced), 'force did not work');
  const tail = await run('ledger', { op: 'tail', limit: 6 });
  assert(/without a GO/.test(tail), 'the forced landing left no ruling in the ledger');
  return 'refused, then forced with a ruling';
});

// ---------------------------------------------------------------- the gate's memory
await checkAsync('a commit outside the seam is caught after the tree is clean', async () => {
  const d = tmpRepo();
  fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
  fs.writeFileSync(
    path.join(d, '.stack', 'config.json'),
    JSON.stringify({ checks: [{ name: 'ok', command: 'node -e "process.exit(0)"', timeout: 30000 }] }, null, 2),
  );
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  const commit = (m) => {
    spawnSync('git', ['add', '-A'], { cwd: d, windowsHide: true });
    spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', m], { cwd: d, windowsHide: true });
  };
  commit('base');

  await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'only a',
    out: 'a changes',
    check: 'node -e "process.exit(0)"',
    owns: ['src/a.ts'],
    files: ['src/a.ts'],
  });

  // The seam is briefed; now commit something it never claimed.
  fs.writeFileSync(path.join(d, 'src', 'b.ts'), 'export const b = 1;\n');
  commit('sneak b in');
  await runIn(d, 'check', { op: 'run' });

  const out = await runIn(d, 'ready', { id: 'only-a', lean: true });
  assert(/NO-GO/.test(out), `a committed file outside the seam was gated GO:\n${out}`);
  assert(/src\/b\.ts/.test(out), `the out-of-seam commit was not named:\n${out}`);

  // Widen the brief honestly and the same gate passes.
  const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index[0].files = ['src/a.ts', 'src/b.ts'];
  index[0].owns = ['src/a.ts', 'src/b.ts'];
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  const widened = await runIn(d, 'ready', { id: 'only-a', lean: true });
  assert(/## GO/.test(widened), `a widened brief did not pass:\n${widened}`);

  fs.rmSync(d, { recursive: true, force: true });
  return 'caught after commit, then GO when widened';
});

await checkAsync('editing the check config mid-seam is a finding, not a pass', async () => {
  const d = tmpRepo();
  fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
  const cfg = (cmd) => JSON.stringify({ checks: [{ name: 'ok', command: cmd, timeout: 30000 }] }, null, 2);
  fs.writeFileSync(path.join(d, '.stack', 'config.json'), cfg('node -e "process.exit(0)"'));
  spawnSync('git', ['add', '-A'], { cwd: d, windowsHide: true });
  spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', 'base'], { cwd: d, windowsHide: true });

  await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'trusted check',
    out: 'a thing',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['notes.md'],
  });

  // The attack: make the check trivially pass, then claim green.
  fs.writeFileSync(path.join(d, '.stack', 'config.json'), cfg('node -e "process.exit(0)" // tampered'));
  await runIn(d, 'check', { op: 'run' });
  const out = await runIn(d, 'ready', { id: 'trusted-check', lean: true });
  assert(/NO-GO/.test(out), `a tampered check config was gated GO:\n${out}`);
  assert(/config\.json changed/.test(out), 'the config change was not named');

  fs.rmSync(d, { recursive: true, force: true });
  return 'config change refused';
});

await checkAsync('a verdict survives a ledger far past any window', async () => {
  const d = tmpRepo();
  fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
  fs.writeFileSync(
    path.join(d, '.stack', 'config.json'),
    JSON.stringify({ checks: [{ name: 'ok', command: 'node -e "process.exit(0)"', timeout: 30000 }] }, null, 2),
  );
  spawnSync('git', ['add', '-A'], { cwd: d, windowsHide: true });
  spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', 'base'], { cwd: d, windowsHide: true });
  await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'old gate',
    out: 'a thing',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['notes.md'],
  });
  await runIn(d, 'check', { op: 'run' });
  const gate = await runIn(d, 'ready', { id: 'old-gate', lean: true });
  assert(/## GO/.test(gate), `setup gate failed:\n${gate}`);

  for (let i = 0; i < 350; i += 1) await runIn(d, 'ledger', { op: 'log', kind: 'NOTE', text: `noise ${i}` });
  const landed = await runIn(d, 'brief', { op: 'status', id: 'old-gate', status: 'landed' });
  assert(!/Refused/.test(landed), `the gate forgot its own verdict after 350 entries:\n${landed}`);

  fs.rmSync(d, { recursive: true, force: true });
  return 'GO found at entry 1 of 360';
});

// ---------------------------------------------------------------- seeding, objective, audit
await checkAsync('a project is seeded and re-seeded without losing a hand-written check', async () => {
  const d = tmpRepo();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
  const first = seedStack(d);
  assert(first.ok, 'seed refused a git repo');
  assert(fs.existsSync(path.join(d, '.stack', 'config.json')), 'config missing');
  assert(fs.existsSync(path.join(d, '.stack', 'ledger.md')), 'ledger missing');
  assert(fs.existsSync(path.join(d, '.stack', 'digest.md')), 'digest missing');
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.stack', 'config.json'), 'utf8'));
  assert(cfg.checks.some((c) => c.name === 'test'), 'the test script was not detected');

  cfg.checks.push({ name: 'mine', command: 'node -e "process.exit(0)"', timeout: 1000 });
  fs.writeFileSync(path.join(d, '.stack', 'config.json'), JSON.stringify(cfg, null, 2));
  seedStack(d);
  const again = JSON.parse(fs.readFileSync(path.join(d, '.stack', 'config.json'), 'utf8'));
  assert(again.checks.filter((c) => c.name === 'mine').length === 1, 'a hand-written check was lost or duplicated');
  assert(again.checks.filter((c) => c.name === 'test').length === 1, 'a detected check was duplicated');

  fs.rmSync(d, { recursive: true, force: true });
  return 'detected, preserved, idempotent';
});

await checkAsync('a directory that is not a project is left alone', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-plain-'));
  const result = seedStack(d);
  assert(!result.ok, 'seeded a directory with no repository and no manifest');
  assert(!fs.existsSync(path.join(d, '.stack')), 'it wrote .stack anyway');
  fs.rmSync(d, { recursive: true, force: true });
  return 'no .git, no manifest, no writes';
});

await checkAsync('the digest renders the objective and flags a landed seam with no verdict', async () => {
  const d = tmpRepo();
  fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
  fs.writeFileSync(
    path.join(d, '.stack', 'config.json'),
    JSON.stringify({ checks: [{ name: 'ok', command: 'node -e "process.exit(0)"', timeout: 30000 }] }, null, 2),
  );
  spawnSync('git', ['add', '-A'], { cwd: d, windowsHide: true });
  spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', 'base'], { cwd: d, windowsHide: true });
  await runIn(d, 'ledger', { op: 'log', kind: 'INTAKE', text: 'make webhooks retry honestly' });
  await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'audited seam', out: 'a thing', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  await runIn(d, 'check', { op: 'run' });
  await runIn(d, 'ready', { id: 'audited-seam', lean: true });
  await runIn(d, 'brief', { op: 'status', id: 'audited-seam', status: 'landed' });

  const digest = await runIn(d, 'ledger', { op: 'digest' });
  assert(/\*\*Objective\*\* — make webhooks retry honestly/.test(digest), 'the objective is not in the digest');
  assert(/Landed, unaudited/.test(digest), 'a landed seam with no verdict was not flagged');

  await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: 'audited-seam@abc1234 PASS spec=ok standards=ok' });
  const after = await runIn(d, 'ledger', { op: 'digest' });
  assert(!/Landed, unaudited/.test(after), 'the audit line did not clear the flag');

  fs.rmSync(d, { recursive: true, force: true });
  return 'objective rendered, audit clears the flag';
});

// ---------------------------------------------------------------- gate evidence, ids, atomic writes
await checkAsync('a forged green check record is not evidence', async () => {
  const d = configuredRepo('node -e "process.exit(3)"');
  await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'forged',
    out: 'a thing',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['n.md'],
  });
  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).stdout.trim();
  const file = path.join(d, '.stack', 'state', 'checks.json');
  const forge = (results) =>
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), head: headSha, branch: 'main', results }, null, 2));

  forge([]);
  const empty = await runIn(d, 'ready', { id: 'forged', lean: true });
  assert(/NO-GO/.test(empty), `an empty result set at HEAD was gated GO:\n${empty}`);

  forge([{ name: 'fake', command: 'node -e "process.exit(0)"', ok: true, code: 0, ms: 1, tail: '' }]);
  const forged = await runIn(d, 'ready', { id: 'forged', lean: true });
  assert(/NO-GO/.test(forged), `a hand-written green record was gated GO:\n${forged}`);
  assert(/RED/.test(forged), `the real failing check was not named:\n${forged}`);

  fs.rmSync(d, { recursive: true, force: true });
  return 'the gate runs the checks itself';
});

check('a check record must cover every configured check', () => {
  const all = [{ name: 'a' }, { name: 'b' }];
  const green = checkRecordReasons({ results: [{ name: 'a', ok: true }, { name: 'b', ok: true }] }, all);
  assert(!green.length, `a complete green record was refused: ${green.join('; ')}`);
  const partial = checkRecordReasons({ results: [{ name: 'a', ok: true }] }, all);
  assert(/recorded 1 of 2/.test(partial[0] || ''), `a truncated record was not caught: ${JSON.stringify(partial)}`);
  const none = checkRecordReasons({ results: [] }, all);
  assert(/recorded 0 of 2/.test(none[0] || ''), `an empty record was not caught: ${JSON.stringify(none)}`);
  const red = checkRecordReasons({ results: [{ name: 'a', ok: true }, { name: 'b', ok: false }] }, all);
  assert(/RED: b/.test(red[0] || ''), `a red check was not named: ${JSON.stringify(red)}`);
  return 'partial and red are both named';
});

await checkAsync('stderr never becomes a path in a -z stream', async () => {
  const noisy =
    'node -e "process.stdout.write(\'a.md\\0b.md\\0\'); process.stderr.write(\'warning: something\')"';
  const r = await commandAsync(noisy, {});
  const paths = r.out.split('\0').filter(Boolean);
  assert(paths.join(',') === 'a.md,b.md', `stderr became a path in the -z stream: ${JSON.stringify(paths)}`);
  assert(/warning: something/.test(r.err), `stderr was not kept as stderr: ${JSON.stringify(r.err)}`);

  const d = configuredRepo('node -e "process.stderr.write(\'warning: something\')"');
  // A real git call writing to stderr is the failure this guards: GIT_TRACE
  // makes every git command trace, and a merged stream turns the trace into a
  // phantom dirty path.
  const before = process.env.GIT_TRACE;
  process.env.GIT_TRACE = '1';
  let dirty;
  try {
    dirty = snapshot(d).files;
  } finally {
    if (before === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = before;
  }
  assert(!dirty.length, `a git warning on stderr made a clean tree dirty: ${JSON.stringify(dirty)}`);

  await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'stderr noise',
    out: 'a thing',
    check: 'node -e "process.stderr.write(\'warning: something\')"',
    owns: ['**'],
    files: ['n.md'],
  });
  const gate = await runIn(d, 'ready', { id: 'stderr-noise', lean: true });
  assert(/## GO\b/.test(gate), `a check that writes to stderr was gated NO-GO:\n${gate}`);
  const scoped = await runIn(d, 'scope', { id: 'stderr-noise' });
  assert(!/\*\*OUT\*\*/.test(scoped), `a check that writes to stderr dirtied the scope:\n${scoped}`);
  assert(/Surgical|working tree is clean/i.test(scoped), `the scope was not clean on a clean tree:\n${scoped}`);

  fs.rmSync(d, { recursive: true, force: true });
  return 'stdout and stderr stay separate';
});

// ---------------------------------------------------------------- clean
await checkAsync("clean removes only the stack's own leftovers", async () => {
  const d = configuredRepo();
  fs.mkdirSync(path.join(d, '.stack', 'state'), { recursive: true });
  const temp = path.join(d, '.stack', 'state', 'x.tmp');
  fs.writeFileSync(temp, 'half a write');
  fs.writeFileSync(path.join(d, 'foo.log'), 'run output\n');
  fs.writeFileSync(path.join(d, '.stack', 'plugin.log'), 'ready\n');

  const out = await runIn(d, 'clean', { op: 'sweep' });
  assert(!fs.existsSync(temp), 'the stack temp survived the sweep');
  assert(!fs.existsSync(path.join(d, '.stack', 'plugin.log')), "the plugin's own log survived the sweep");
  assert(out.includes('x.tmp') && out.includes('plugin.log'), `the removals were not named:\n${out}`);
  assert(fs.existsSync(path.join(d, 'foo.log')), 'a repo-root log was deleted');

  const report = await runIn(d, 'clean', { op: 'report' });
  assert(report.includes('foo.log'), `junk in the repo root was not named in the report:\n${report}`);
  assert(/What to do/.test(report) && /\.log`/.test(report), `the report gives no suggestion:\n${report}`);
  assert(fs.existsSync(path.join(d, 'foo.log')), 'the report deleted the junk it named');
  assert(!fs.existsSync(temp), 'the report deleted a stack temp');
  fs.rmSync(d, { recursive: true, force: true });
  return 'own temp and log removed, junk named and kept';
});

await checkAsync('clean removes a stale lock and keeps a live one', async () => {
  const d = configuredRepo();
  const lock = path.join(d, '.stack', 'state', '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '');

  const fresh = await runIn(d, 'clean', { op: 'sweep' });
  assert(fs.existsSync(lock), 'a fresh lock was removed');
  assert(/Kept/.test(fresh) && /lock in use/.test(fresh), `a fresh lock was not kept with a reason:\n${fresh}`);

  const stale = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lock, stale, stale);
  const out = await runIn(d, 'clean', { op: 'sweep' });
  assert(!fs.existsSync(lock), 'a lock older than ten minutes survived');
  assert(/lock unused for/.test(out), `the stale lock was not named as stale:\n${out}`);
  fs.rmSync(d, { recursive: true, force: true });
  return 'fresh kept, stale removed';
});

await checkAsync('clean works without git and touches only .stack', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-clean-'));
  fs.mkdirSync(path.join(d, '.stack', 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.stack', 'briefs', 'keep.md'), '# keep\n');
  fs.writeFileSync(path.join(d, '.stack', 'briefs', 'j.tmp'), 'crash\n');
  fs.writeFileSync(path.join(d, 'note.tmp'), 'not mine\n');

  const out = await runIn(d, 'clean', { op: 'sweep' });
  assert(!fs.existsSync(path.join(d, '.stack', 'briefs', 'j.tmp')), 'the stack temp survived');
  assert(fs.existsSync(path.join(d, '.stack', 'briefs', 'keep.md')), 'a real stack file was deleted');
  assert(fs.existsSync(path.join(d, 'note.tmp')), 'a file outside .stack was deleted');
  assert(!fs.existsSync(path.join(d, '.git')), 'clean created a repository');
  assert(/Found but not mine: 1/.test(out), `the outside temp was not reported as not ours:\n${out}`);
  fs.rmSync(d, { recursive: true, force: true });
  return 'no git needed, nothing outside .stack touched';
});

await checkAsync('clean on a pristine project says so plainly', async () => {
  const d = configuredRepo();
  const out = await runIn(d, 'clean', { op: 'sweep' });
  assert(/Nothing to remove/.test(out), `a clean stack did not say so:\n${out}`);
  assert(!/\| Removed \|/.test(out), `an empty table was rendered:\n${out}`);
  assert(fs.existsSync(path.join(d, '.stack', 'config.json')), 'the config was removed');
  fs.rmSync(d, { recursive: true, force: true });
  return 'nothing to remove';
});

await checkAsync('a brief copied over its report is not a report', async () => {
  const d = configuredRepo();
  await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'copied report',
    out: 'a thing',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['n.md'],
  });
  fs.copyFileSync(
    path.join(d, '.stack', 'briefs', 'copied-report.md'),
    path.join(d, '.stack', 'reports', 'copied-report.md'),
  );
  const out = await runIn(d, 'ready', { id: 'copied-report' });
  assert(/NO-GO/.test(out), `a brief copied over its report was accepted:\n${out}`);
  assert(/Outcome|no .*section/i.test(out), `the missing section was not named:\n${out}`);
  fs.rmSync(d, { recursive: true, force: true });
  return 'fenced headings are examples, not sections';
});

await checkAsync("a report in the brief's own example style is a report", async () => {
  const d = configuredRepo();
  await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'template style',
    out: 'a thing',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['n.md'],
  });
  // The headings and their inline descriptions are copied from the template the
  // brief itself prints; the bodies underneath are real.
  fs.writeFileSync(
    path.join(d, '.stack', 'reports', 'template-style.md'),
    [
      '# template style',
      '',
      '## Outcome     what shipped, two or three sentences',
      'Retries stop at three.',
      '',
      '## Evidence    the command and the real output at the head you hand back',
      '`node -e "process.exit(0)"` exit 0.',
      '',
      '## Unverified  every claim you did not check, and why; "none" is a claim',
      'none',
      '',
      '## Scope       paths touched, each inside Owns, or why not',
      '`.stack/reports/template-style.md` only.',
      '',
      '## Lesson      one paragraph the next employee should know',
      'A template the gate rejects is a template that teaches a lie.',
      '',
    ].join('\n'),
  );
  const out = await runIn(d, 'ready', { id: 'template-style' });
  assert(/## GO\b/.test(out), `a report in the brief's own template was refused:\n${out}`);
  fs.rmSync(d, { recursive: true, force: true });
  return "the brief's example headings pass the gate";
});

await checkAsync('a fenced example is never a report section', async () => {
  const d = configuredRepo();
  await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'fenced example',
    out: 'a thing',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['n.md'],
  });
  const reportFile = path.join(d, '.stack', 'reports', 'fenced-example.md');
  const report = (outcome) =>
    [
      '# fenced example',
      '',
      ...outcome,
      '',
      '## Evidence',
      '`node -e "process.exit(0)"` exit 0.',
      '',
      '## Unverified',
      'none',
      '',
      '## Scope',
      '`.stack/**` only.',
      '',
      '## Lesson',
      'An example is not evidence.',
      '',
    ].join('\n');

  // Five real sections, plus a fenced block that repeats a heading: the fence is
  // an example and must be skipped, so this lands.
  fs.writeFileSync(
    reportFile,
    report([
      '## Outcome',
      'Retries stop at three.',
      '',
      '```text',
      '## Outcome     what shipped, two or three sentences',
      'An example body inside a fence.',
      '```',
    ]),
  );
  const go = await runIn(d, 'ready', { id: 'fenced-example' });
  assert(/## GO\b/.test(go), `a report with a fenced example after its real sections was refused:\n${go}`);

  // The discriminating case: the only Outcome body is fenced. A fence-blind
  // parser counts the example as a body and gates GO on it.
  fs.writeFileSync(
    reportFile,
    report([
      '## Outcome',
      '```text',
      '## Outcome     what shipped, two or three sentences',
      'An example body inside a fence.',
      '```',
    ]),
  );
  const no = await runIn(d, 'ready', { id: 'fenced-example' });
  assert(/NO-GO/.test(no), `a fenced example body was accepted as evidence:\n${no}`);
  assert(/outcome/i.test(no), `the empty outcome section was not named:\n${no}`);

  fs.rmSync(d, { recursive: true, force: true });
  return 'a fenced body is not a body';
});

await checkAsync('a brief with no recorded base is refused, not passed', async () => {
  const d = configuredRepo();
  await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'no head', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  const gate = await runIn(d, 'ready', { id: 'no-head', lean: true });
  assert(/## GO/.test(gate), `setup gate failed:\n${gate}`);

  const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  delete index[0].head;
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  const missing = await runIn(d, 'ready', { id: 'no-head', lean: true });
  assert(/NO-GO/.test(missing), 'a brief with no base was gated GO');
  assert(/no base commit/i.test(missing), `the missing base was not named:\n${missing}`);

  index[0].head = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  const unreadable = await runIn(d, 'ready', { id: 'no-head', lean: true });
  assert(/NO-GO/.test(unreadable), 'a range git cannot read was gated GO');
  assert(/could not read the committed range/i.test(unreadable), `the unreadable range was not named:\n${unreadable}`);

  fs.rmSync(d, { recursive: true, force: true });
  return 'no base and bad base both refuse';
});

await checkAsync('brief refuses an id that could leave .stack/briefs', async () => {
  const d = configuredRepo();
  const out = await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'evil seam',
    id: '../../evil',
    out: 'x',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['n.md'],
  });
  assert(/Refused/.test(out), 'a traversal id was accepted');
  assert(/not a seam id/.test(out), `the refusal did not name the reason:\n${out}`);
  assert(!fs.existsSync(path.join(d, '..', 'evil.md')), 'a brief escaped the repository');
  assert(!fs.existsSync(path.join(d, '.stack', 'briefs', 'evil.md')), 'the hostile id was silently sanitised and written');
  fs.rmSync(d, { recursive: true, force: true });
  return 'traversal refused before any write';
});

await checkAsync('swarm refuses an id that could leave .stack/briefs', async () => {
  const d = configuredRepo();
  const out = await runIn(d, 'swarm', {
    seams: [
      { id: '../../evil', title: 'evil', out: 'x', check: 'node -e "process.exit(0)"', files: ['src/a.ts'] },
      { id: 'fine', title: 'fine', out: 'y', check: 'node -e "process.exit(0)"', files: ['src/b.ts'] },
    ],
  });
  assert(/Refused/.test(out), 'a traversal id was accepted by the swarm');
  assert(/not a seam id/.test(out), `the swarm refusal did not name the reason:\n${out}`);
  assert(!fs.existsSync(path.join(d, '..', 'evil.md')), 'a swarm brief escaped the repository');
  const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
  assert(!fs.existsSync(indexFile) || JSON.parse(fs.readFileSync(indexFile, 'utf8')).length === 0, 'the refused swarm wrote an index');
  fs.rmSync(d, { recursive: true, force: true });
  return 'whole swarm refused';
});

await checkAsync('explicit ids are slugged so case cannot fork one seam', async () => {
  const d = configuredRepo();
  const first = await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'retry budget',
    id: 'Retry-Budget',
    out: 'x',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['n.md'],
  });
  assert(/retry-budget\.md/.test(first), `the id was not slugged: ${first.slice(0, 100)}`);
  assert(fs.existsSync(path.join(d, '.stack', 'briefs', 'retry-budget.md')), 'the slugged file is missing');
  // On a case-insensitive filesystem both names open the same file, so the
  // assertion has to be on the exact directory entry, not on a path lookup.
  const entries = fs.readdirSync(path.join(d, '.stack', 'briefs'));
  assert(!entries.includes('Retry-Budget.md'), `the raw id was used as a second file: ${entries.join(', ')}`);

  const second = await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'retry budget two',
    id: 'retry-budget',
    out: 'y',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['n.md'],
  });
  assert(/Brief written/.test(second), `the second brief did not land: ${second.slice(0, 100)}`);
  const index = JSON.parse(fs.readFileSync(path.join(d, '.stack', 'state', 'briefs.json'), 'utf8'));
  assert(index.length === 1, `two records for one file: ${index.map((b) => b.id).join(', ')}`);
  fs.rmSync(d, { recursive: true, force: true });
  return 'one id, one file';
});

await checkAsync('a CRLF ledger still yields its verdicts', async () => {
  const d = configuredRepo();
  await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'crlf seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  const ledger = path.join(d, '.stack', 'ledger.md');
  fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace(/\r?\n/g, '\r\n'));
  await runIn(d, 'ledger', { op: 'log', kind: 'READY', text: 'crlf-seam: GO' });
  const out = await runIn(d, 'brief', { op: 'status', id: 'crlf-seam', status: 'landed' });
  assert(!/Refused/.test(out), `a CRLF ledger lost its verdict:\n${out}`);
  const index = JSON.parse(fs.readFileSync(path.join(d, '.stack', 'state', 'briefs.json'), 'utf8'));
  assert(index[0].status === 'landed', 'the status did not change');
  fs.rmSync(d, { recursive: true, force: true });
  return 'CRLF parsed, landed';
});

await checkAsync('a corrupt brief index is named, not silently emptied', async () => {
  const d = configuredRepo();
  await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'keep me', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
  fs.writeFileSync(indexFile, '{ not json');
  const list = await runIn(d, 'brief', { op: 'list' });
  assert(/unreadable|not valid JSON/i.test(list), `the corrupt index read as an empty list:\n${list}`);
  const created = await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'new seam', out: 'y', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  assert(/Refused/.test(created), 'a new brief overwrote a corrupt index');
  assert(fs.readFileSync(indexFile, 'utf8') === '{ not json', 'the corrupt index was destroyed');
  fs.rmSync(d, { recursive: true, force: true });
  return 'named, refused, preserved';
});

await checkAsync('re-briefing a landed seam needs force and says why', async () => {
  const d = configuredRepo();
  await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'shipped seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  await runIn(d, 'check', { op: 'run' });
  const gate = await runIn(d, 'ready', { id: 'shipped-seam', lean: true });
  assert(/## GO/.test(gate), gate);
  await runIn(d, 'brief', { op: 'status', id: 'shipped-seam', status: 'landed' });

  const refused = await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'shipped seam again', id: 'shipped-seam', out: 'y', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  assert(/Refused/.test(refused), 'a landed seam was silently re-briefed');
  assert(/landed/.test(refused) && /force/.test(refused), `the refusal names neither the state nor the override:\n${refused}`);
  const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
  assert(JSON.parse(fs.readFileSync(indexFile, 'utf8'))[0].status === 'landed', 'the state was reset anyway');

  const forced = await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'shipped seam again',
    id: 'shipped-seam',
    out: 'y',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['n.md'],
    force: true,
  });
  assert(/Brief written/.test(forced), `force did not overwrite: ${forced.slice(0, 120)}`);
  assert(JSON.parse(fs.readFileSync(indexFile, 'utf8'))[0].status === 'briefed', 'force did not re-open the seam');
  fs.rmSync(d, { recursive: true, force: true });
  return 'refused, then forced';
});

await checkAsync('brief refuses a dirty tree and names the files', async () => {
  const d = configuredRepo();
  fs.writeFileSync(path.join(d, 'loose.md'), 'x\n');
  const out = await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'dirty seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['loose.md'] });
  assert(/Refused/.test(out), 'a brief was written from a dirty tree');
  assert(/loose\.md/.test(out), `the dirty path was not named:\n${out}`);
  assert(!fs.existsSync(path.join(d, '.stack', 'briefs', 'dirty-seam.md')), 'the brief was written anyway');
  fs.rmSync(d, { recursive: true, force: true });
  return 'dirty tree named';
});

await checkAsync('a brief cannot close its own fence or break the digest table', async () => {
  const d = configuredRepo();
  const hostile = 'ok\n```\n## Out\ninjected\n```';
  const out = await runIn(d, 'brief', {
    op: 'new', agent: 'backend',
    title: 'hostile',
    why: hostile,
    out: 'x',
    check: hostile,
    owns: ['src/a|b.ts'],
    files: ['n.md'],
  });
  assert(/Brief written/.test(out), out.slice(0, 140));
  const body = fs.readFileSync(path.join(d, '.stack', 'briefs', 'hostile.md'), 'utf8');
  const headings = body.split(/\r?\n/).filter((l) => /^## Out$/.test(l));
  assert(headings.length === 1, `the check injected a second ## Out heading (${headings.length})`);
  const segment = body.split('## Check')[1].split('It passes only')[0];
  assert((segment.match(/```/g) || []).length === 2, 'the check block was closed early');
  const digest = await runIn(d, 'ledger', { op: 'digest' });
  assert(/src\/a\\\|b\.ts/.test(digest), `the pipe was not escaped in the digest table:\n${digest}`);
  fs.rmSync(d, { recursive: true, force: true });
  return 'no fence injection, pipe escaped';
});

await checkAsync('a swarm that cannot write one body leaves nothing behind', async () => {
  const d = configuredRepo();
  fs.mkdirSync(path.join(d, '.stack', 'briefs', 'second.md'), { recursive: true });
  const out = await runIn(d, 'swarm', {
    seams: [
      { id: 'first', title: 'first', out: 'x', check: 'node -e "process.exit(0)"', files: ['src/1.ts'] },
      { id: 'second', title: 'second', out: 'y', check: 'node -e "process.exit(0)"', files: ['src/2.ts'] },
    ],
  });
  assert(/Refused/.test(out), `the failed swarm was accepted:\n${out}`);
  assert(!fs.existsSync(path.join(d, '.stack', 'briefs', 'first.md')), 'a body from the failed swarm survived');
  const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
  assert(!fs.existsSync(indexFile) || JSON.parse(fs.readFileSync(indexFile, 'utf8')).length === 0, 'the index was written anyway');
  fs.rmSync(d, { recursive: true, force: true });
  return 'bodies rolled back, index untouched';
});

await checkAsync('a blocked temp file leaves the brief index intact', async () => {
  const d = configuredRepo();
  await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'atomic seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
  const before = fs.readFileSync(indexFile, 'utf8');
  fs.mkdirSync(`${indexFile}.tmp`);
  const out = await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'second seam', out: 'y', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  assert(/Refused/.test(out), `a failed index write was reported as success:\n${out}`);
  assert(fs.readFileSync(indexFile, 'utf8') === before, 'the index was truncated by the failed write');
  assert(!fs.existsSync(path.join(d, '.stack', 'briefs', 'second-seam.md')), 'the body from the failed write survived');
  fs.rmSync(`${indexFile}.tmp`, { recursive: true, force: true });
  fs.rmSync(d, { recursive: true, force: true });
  return 'index byte-identical, body rolled back';
});

await checkAsync('a held lock blocks a write instead of racing it', async () => {
  const d = configuredRepo();
  await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'locked seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
  const before = fs.readFileSync(indexFile, 'utf8');
  const lock = path.join(d, '.stack', 'state', '.lock');
  fs.writeFileSync(lock, 'held');
  const blocked = await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'blocked seam', out: 'y', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['b.md'] });
  assert(/Refused/.test(blocked) && /acquire/.test(blocked), `a held lock was ignored:\n${blocked}`);
  assert(fs.readFileSync(indexFile, 'utf8') === before, 'the index changed while the lock was held');
  fs.unlinkSync(lock);
  const after = await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'after seam', out: 'z', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['c.md'] });
  assert(/Brief written/.test(after), 'the lock was not released by the failed writer');
  fs.rmSync(d, { recursive: true, force: true });
  return 'waited, refused, then wrote';
});

await checkAsync('logging onto a file with no final newline does not merge entries', async () => {
  const d = tmpRepo();
  fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
  const ledger = path.join(d, '.stack', 'ledger.md');
  fs.writeFileSync(ledger, '# Stack ledger\n\n- 2020-01-01T00:00:00.000Z · NOTE · first');
  await runIn(d, 'ledger', { op: 'log', kind: 'NOTE', text: 'second' });
  const lines = fs.readFileSync(ledger, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('- '));
  assert(lines.length === 2, `entries merged: ${JSON.stringify(lines)}`);
  assert(/· first$/.test(lines[0]), `the first entry was altered: ${lines[0]}`);
  assert(/· second$/.test(lines[1]), `the second entry is wrong: ${lines[1]}`);
  fs.rmSync(d, { recursive: true, force: true });
  return 'newline repaired before append';
});

await checkAsync('seeding writes the stack gitignore and keeps a hand-written one', async () => {
  const d = tmpRepo();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
  assert(seedStack(d).ok, 'seed refused a repo');
  const ignoreFile = path.join(d, '.stack', '.gitignore');
  assert(fs.existsSync(ignoreFile), '.stack/.gitignore was not written');
  const text = fs.readFileSync(ignoreFile, 'utf8');
  assert(/state\//.test(text) && /plugin\.log/.test(text), `the ignore file omits state/ or plugin.log: ${JSON.stringify(text)}`);
  fs.writeFileSync(ignoreFile, 'custom\n');
  seedStack(d);
  assert(fs.readFileSync(ignoreFile, 'utf8') === 'custom\n', 'seeding overwrote a hand-written .gitignore');
  fs.rmSync(d, { recursive: true, force: true });
  return 'state/ and plugin.log ignored';
});

await checkAsync('seeding prunes an old temp and a stale lock, and keeps a live write', async () => {
  const d = tmpRepo();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x' }));
  seedStack(d);
  const state = path.join(d, '.stack', 'state');
  fs.mkdirSync(state, { recursive: true });
  const oldTmp = path.join(state, 'old.tmp');
  const newTmp = path.join(state, 'new.tmp');
  const lock = path.join(state, '.lock');
  fs.writeFileSync(oldTmp, 'half a write\n');
  fs.writeFileSync(newTmp, 'half a write\n');
  fs.writeFileSync(lock, '');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(lock, twoHoursAgo, twoHoursAgo);

  const result = seedStack(d);
  assert(!fs.existsSync(oldTmp), 'a temp older than an hour survived the seed');
  assert(!fs.existsSync(lock), 'a stale lock survived the seed');
  assert(fs.existsSync(newTmp), 'a temp younger than an hour was pruned; it may belong to a write in flight');
  assert(result.removed.includes('.stack/state/old.tmp'), `the prune was not reported: ${JSON.stringify(result.removed)}`);
  fs.rmSync(d, { recursive: true, force: true });
  return 'old temp and stale lock pruned, live write kept';
});

await checkAsync('a corrupt config is signalled and rewritten by seeding', async () => {
  const d = tmpRepo();
  fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
  fs.writeFileSync(path.join(d, '.stack', 'config.json'), '{ not json');
  const result = seedStack(d);
  assert(result.ok, 'seed refused a repo');
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.stack', 'config.json'), 'utf8'));
  assert(Array.isArray(cfg.checks), 'the rewritten config has no checks list');
  assert(Array.isArray(cfg.ownership?.ignore) && cfg.ownership.ignore.includes('.stack/**'), 'the rewritten config lost the ignore list');
  assert(
    result.updated.includes('.stack/config.json') || result.created.includes('.stack/config.json'),
    'the rewrite was not reported',
  );
  fs.rmSync(d, { recursive: true, force: true });
  return 'corrupt config replaced';
});

await checkAsync('the digest finds the objective, open ask, and audit across the whole ledger', async () => {
  const d = configuredRepo();
  await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'deep seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
  await runIn(d, 'check', { op: 'run' });
  assert(/## GO/.test(await runIn(d, 'ready', { id: 'deep-seam', lean: true })), 'setup gate failed');
  await runIn(d, 'brief', { op: 'status', id: 'deep-seam', status: 'landed' });
  await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: 'deep-seam@abc1234 PASS spec=ok standards=ok' });
  await runIn(d, 'ledger', { op: 'log', kind: 'INTAKE', text: 'make the deep ledger honest' });
  await runIn(d, 'ledger', { op: 'log', kind: 'ASK', text: 'D9 · ship it? recommend yes' });
  for (let i = 0; i < 220; i += 1) await runIn(d, 'ledger', { op: 'log', kind: 'NOTE', text: `noise ${i}` });
  const digest = await runIn(d, 'ledger', { op: 'digest' });
  assert(/make the deep ledger honest/.test(digest), 'the objective fell out of the display window');
  assert(/D9 ·/.test(digest), 'the open ask fell out of the display window');
  assert(!/Landed, unaudited/.test(digest), 'the audit fell out of the display window');
  fs.rmSync(d, { recursive: true, force: true });
  return 'objective, ask, audit survive 220 notes';
});

check('the ledger description names every kind the digest reads', () => {
  const description = tool('ledger').description;
  for (const kind of ['INTAKE', 'AUDIT', 'SWARM', 'SEED']) {
    assert(description.includes(kind), `the ledger description omits ${kind}`);
  }
  return 'INTAKE, AUDIT, SWARM, SEED';
});

check('the command tokenizer keeps empty args and tells quoting honestly', () => {
  const empty = parse('node script.js "" --flag');
  assert(empty.length === 4 && empty[2] === '', `an empty argument was dropped: ${JSON.stringify(empty)}`);
  if (process.platform === 'win32') {
    const apostrophe = parse("--grep=don't");
    assert(apostrophe[0] === "--grep=don't", `an apostrophe split the token: ${JSON.stringify(apostrophe)}`);
  }
  const escaped = parse('cmd "say \\"hi\\" \\\\ done"');
  assert(escaped[1] === 'say "hi" \\ done', `escaped quotes were not honoured: ${JSON.stringify(escaped)}`);
  let threw = false;
  try {
    parse('cmd "unterminated');
  } catch {
    threw = true;
  }
  assert(threw, 'an unterminated quote was accepted');
  return 'empty, apostrophe, escapes, throw';
});

check('a quoted .cmd path or %VAR% routes through the shell', () => {
  if (process.platform === 'win32') {
    assert(needsShell('"C:\\Program Files\\tool\\check.cmd" /q'), 'a quoted .cmd path was sent direct');
  }
  assert(needsShell('node -e "process.exit(0)" %TEMP%'), '%VAR% was not sent to the shell');
  assert(!needsShell('node -e "process.exit(0)"'), 'a plain command was sent to the shell');
  return 'quoted .cmd, %VAR%, plain';
});

await checkAsync('scope names both sides of a staged rename', async () => {
  const d = tmpRepo();
  fs.writeFileSync(path.join(d, 'old-name.ts'), 'export const a = 1;\n');
  commitAll(d, 'base');
  spawnSync('git', ['mv', 'old-name.ts', 'new-name.ts'], { cwd: d, windowsHide: true });
  const out = await runIn(d, 'scope', {});
  assert(out.includes('`old-name.ts`'), `the rename source is missing:\n${out}`);
  assert(out.includes('`new-name.ts`'), `the rename destination is missing:\n${out}`);
  fs.rmSync(d, { recursive: true, force: true });
  return 'both paths named';
});

await checkAsync('a check that is a quoted .cmd path with a space still runs', async () => {
  const d = tmpRepo();
  fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
  const cmdPath = path.join(d, 'my check.cmd');
  fs.writeFileSync(cmdPath, '@node -e "process.exit(0)"\r\n');
  fs.writeFileSync(
    path.join(d, '.stack', 'config.json'),
    JSON.stringify({ checks: [{ name: 'cmd', command: `"${cmdPath}"`, timeout: 60000 }] }, null, 2),
  );
  const out = await runIn(d, 'check', { op: 'run' });
  assert(/GREEN/.test(out), `a quoted .cmd path was not run:\n${out}`);
  assert(out.includes('my check.cmd'), 'the command itself is not printed, so nobody can audit it');
  fs.rmSync(d, { recursive: true, force: true });
  return 'quoted .cmd executed';
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

// ---------------------------------------------------------------- agents, routing, handbooks
const agentFiles = fs.readdirSync(path.join(repo, 'agents')).filter((f) => f.endsWith('.md'));
const agentIds = agentFiles.map((f) => f.replace(/\.md$/, '')).sort();
const archetypes = agentIds.filter((id) => id !== 'lead' && id !== 'auditor');
const routing = JSON.parse(fs.readFileSync(path.join(repo, 'routing.json'), 'utf8'));

/** An agent's `permissions` rules from its frontmatter, in file order. */
function agentPermissions(id) {
  const raw = fs.readFileSync(path.join(repo, 'agents', `${id}.md`), 'utf8');
  const frontmatter = raw.slice(4, raw.indexOf('\n---', 3));
  const rule = /^[ \t]*-[ \t]+action:[ \t]*(.+?)[ \t]*\r?\n[ \t]+resource:[ \t]*(.+?)[ \t]*\r?\n[ \t]+effect:[ \t]*(.+?)[ \t]*$/gm;
  const unquote = (value) => value.replace(/^"(.*)"$/, '$1');
  return [...frontmatter.matchAll(rule)].map((m) => ({
    action: unquote(m[1]),
    resource: unquote(m[2]),
    effect: unquote(m[3]),
  }));
}

const TERRA = 'openai/gpt-6.1-terra';
const MUSE = 'opencode-go/muse-spark-1.3-contributor';
const DEEPSEEK = 'opencode-go/deepseek-v4.1-flash';

/** The department handbooks, and exactly which archetypes read each one. */
const HANDBOOKS = {
  'product.md': ['product-manager', 'project-manager'],
  'design.md': ['ui-designer', 'ux-researcher', 'design-system'],
  'engineering.md': ['frontend', 'backend', 'data-engineer', 'tester'],
  'platform.md': ['devops', 'sre', 'release-manager'],
  'quality.md': ['qa', 'security', 'reviewer', 'design-reviewer'],
  'knowledge.md': ['docs', 'technical-writer', 'data-analyst'],
  'research.md': ['researcher', 'scout', 'fact-checker'],
};

check('twenty-four agents exist with valid V2 frontmatter', () => {
  assert(agentFiles.length === 24, `expected 24 agents, got ${agentFiles.length}: ${agentFiles.join(', ')}`);
  for (const id of ['lead', 'auditor', ...Object.values(HANDBOOKS).flat()]) {
    assert(agentIds.includes(id), `missing agent: ${id}.md`);
  }
  const legacy = /\b(tools|temperature|maxSteps|permission)\s*:/;
  for (const f of agentFiles) {
    const raw = fs.readFileSync(path.join(repo, 'agents', f), 'utf8');
    assert(raw.startsWith('---'), `${f} has no frontmatter`);
    const fm = raw.slice(4, raw.indexOf('\n---', 3));
    assert(/^description:/m.test(fm), `${f} has no description`);
    assert(/^mode:/m.test(fm), `${f} has no mode`);
    assert(!legacy.test(fm), `${f} uses a legacy V1 field`);
    const body = raw.split('---').slice(2).join('---');
    assert(body.trim().length > 400, `${f} body is too thin to steer an agent`);
  }
  return `${agentFiles.length} agents`;
});

check('the lead edits only .stack, and the exception comes after the ask', () => {
  const rules = agentPermissions('lead');
  const ask = rules.findIndex((r) => r.action === 'edit' && r.resource === '*' && r.effect === 'ask');
  const tree = rules.findIndex((r) => r.action === 'edit' && r.resource === '**/.stack/**' && r.effect === 'allow');
  const root = rules.findIndex((r) => r.action === 'edit' && r.resource === '**/.stack' && r.effect === 'allow');
  assert(ask >= 0, 'lead.md has no broad edit ask rule');
  assert(tree >= 0, 'lead.md has no **/.stack/** edit allow rule');
  assert(root >= 0, 'lead.md has no **/.stack edit allow rule');
  assert(Math.min(tree, root) > ask, 'the .stack allow rules come before the broad ask; last match wins, so they never apply');
  return 'ask, then **/.stack and **/.stack/**';
});

check('no agent uses the legacy singular permission key', () => {
  const offenders = agentIds.filter((id) => {
    const raw = fs.readFileSync(path.join(repo, 'agents', `${id}.md`), 'utf8');
    return /^permission[ \t]*:/m.test(raw.slice(4, raw.indexOf('\n---', 3)));
  });
  assert(!offenders.length, `the legacy singular permission: key is in: ${offenders.join(', ')}`);
  return `${agentIds.length} agents use permissions:`;
});

check('every non-lead agent ends on a subagent deny', () => {
  const others = agentIds.filter((id) => id !== 'lead');
  for (const id of others) {
    const rules = agentPermissions(id);
    assert(rules.length, `${id}.md has no permission rules`);
    const last = rules[rules.length - 1];
    assert(
      last.action === 'subagent' && last.resource === '*' && last.effect === 'deny',
      `${id}.md ends on ${last.action} ${last.resource} ${last.effect}; a later rule can widen the spawn deny`,
    );
  }
  return `${others.length} agents cannot delegate`;
});

check('every non-lead agent puts its edit exceptions after the broad allow', () => {
  const others = agentIds.filter((id) => id !== 'lead');
  for (const id of others) {
    const edits = agentPermissions(id).filter((r) => r.action === 'edit');
    assert(edits.length, `${id}.md has no edit rule`);
    const last = edits[edits.length - 1];
    assert(
      !(last.resource === '*' && last.effect === 'allow'),
      `${id}.md ends its edit rules on * allow, so every exception written above it is dead`,
    );
  }
  return `${others.length} agents end on an exception`;
});

check('every edit deny names a path the engine can actually send', () => {
  let denies = 0;
  for (const id of agentIds) {
    for (const rule of agentPermissions(id)) {
      if (rule.action !== 'edit' || rule.effect !== 'deny') continue;
      denies += 1;
      assert(
        rule.resource === '*' || rule.resource.startsWith('**/'),
        `${id}.md denies edit to "${rule.resource}" with no **/ prefix; edit resources are absolute, so it never matches`,
      );
    }
  }
  assert(denies > 0, 'no edit deny rule was found; the sweep is not reading the rules');
  return `${denies} denies anchored`;
});

check('every archetype may edit its own handbook', () => {
  for (const id of archetypes) {
    const entry = Object.entries(HANDBOOKS).find(([, ids]) => ids.includes(id));
    assert(entry, `${id}.md is mapped to no handbook`);
    const [handbook] = entry;
    const edits = agentPermissions(id).filter((r) => r.action === 'edit');
    const last = edits[edits.length - 1];
    assert(
      last && last.effect === 'allow' && last.resource.endsWith(handbook),
      `${id}.md has no edit allow for its own handbook references/${handbook} as its last edit rule; a deny below it would win`,
    );
  }
  return `${archetypes.length} archetypes own one handbook each`;
});

check('the permission sweep covers the roster the agent check asserts', () => {
  assert(agentFiles.length === 24, `the roster is ${agentFiles.length} agents, not 24; change the roster assertion and this sweep together`);
  const swept = agentFiles.filter((f) => {
    const raw = fs.readFileSync(path.join(repo, 'agents', f), 'utf8');
    return /^permissions:/m.test(raw.slice(4, raw.indexOf('\n---', 3)));
  }).length;
  assert(swept === agentFiles.length, `the permission sweep reads ${swept} of ${agentFiles.length} agents`);
  return `${swept} of 24 agents carry permissions:`;
});

check('every archetype is a subagent that denies subagent and reads one handbook', () => {
  for (const id of archetypes) {
    const raw = fs.readFileSync(path.join(repo, 'agents', `${id}.md`), 'utf8');
    assert(/^mode:\s*subagent$/m.test(raw), `${id}.md is not mode: subagent`);
    assert(/action:\s*subagent[\s\S]{0,160}effect:\s*deny/.test(raw), `${id}.md does not deny the subagent action`);
    const body = raw.split('---').slice(2).join('---').trim();
    const lines = body.split('\n').length;
    assert(lines <= 30, `${id}.md body is ${lines} lines; the cap is 30`);
    assert(lines >= 18, `${id}.md body is ${lines} lines; too thin to steer`);
    assert(/Load `stacked-employee`/.test(body), `${id}.md does not load stacked-employee`);
    assert(/stacked-soul/.test(body), `${id}.md does not load stacked-soul`);
    const named = Object.keys(HANDBOOKS).filter((h) => body.includes(`references\\${h}`) || body.includes(`references/${h}`));
    assert(named.length === 1, `${id}.md names ${named.length} handbooks (${named.join(', ')}); it reads exactly one`);
  }
  return `${archetypes.length} archetypes cannot delegate`;
});

check('no shipped agent carries a model line', () => {
  for (const f of agentFiles) {
    assert(
      !/^model:/m.test(fs.readFileSync(path.join(repo, 'agents', f), 'utf8')),
      `${f} ships a model: line; routing belongs in routing.json and is applied at install`,
    );
  }
  return 'unpinned in the repository';
});

check('routing.json covers every agent exactly once, and the lead inherits', () => {
  const ids = Object.keys(routing).filter((key) => key !== '_comment').sort();
  assert(ids.length === 24, `routing.json has ${ids.length} ids, expected 24`);
  for (const id of agentIds) assert(ids.includes(id), `routing.json has no entry for ${id}`);
  assert(routing.lead === null, `lead is ${JSON.stringify(routing.lead)}, expected null`);

  const tier = { terra: [], muse: [], deepseek: [] };
  for (const id of ids) {
    const model = routing[id];
    if (model === null) continue;
    if (model === TERRA) tier.terra.push(id);
    else if (model === MUSE) tier.muse.push(id);
    else if (model === DEEPSEEK) tier.deepseek.push(id);
    else throw new Error(`routing.json names an unknown model for ${id}: ${model}`);
  }
  const expectTerra = ['auditor', 'product-manager', 'design-reviewer', 'qa', 'security', 'reviewer', 'researcher', 'scout', 'fact-checker'];
  const expectDeepseek = ['frontend', 'backend', 'data-engineer', 'tester'];
  const expectMuse = [
    'project-manager', 'ui-designer', 'ux-researcher', 'design-system', 'devops',
    'sre', 'release-manager', 'docs', 'technical-writer', 'data-analyst',
  ];
  for (const id of expectTerra) assert(routing[id] === TERRA, `${id} should be terra, is ${routing[id]}`);
  for (const id of expectDeepseek) assert(routing[id] === DEEPSEEK, `${id} should be deepseek, is ${routing[id]}`);
  for (const id of expectMuse) assert(routing[id] === MUSE, `${id} should be muse, is ${routing[id]}`);
  return `terra ${tier.terra.length} · muse ${tier.muse.length} · deepseek ${tier.deepseek.length} · lead inherit`;
});

check('every archetype reads a handbook that exists and is long enough', () => {
  const dir = path.join(repo, 'skills', 'stacked-employee', 'references');
  for (const [file, ids] of Object.entries(HANDBOOKS)) {
    const p = path.join(dir, file);
    assert(fs.existsSync(p), `handbook missing: references/${file}`);
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').length;
    assert(lines > 60, `references/${file} is ${lines} lines; the floor is 60`);
    for (const id of ids) {
      const body = fs.readFileSync(path.join(repo, 'agents', `${id}.md`), 'utf8');
      assert(
        body.includes(`references\\${file}`) || body.includes(`references/${file}`),
        `${id}.md does not name its handbook references/${file}`,
      );
    }
  }
  const mapped = Object.values(HANDBOOKS).flat().sort();
  const gap = archetypes.filter((id) => !mapped.includes(id));
  const extra = mapped.filter((id) => !archetypes.includes(id));
  assert(!gap.length, `archetypes with no handbook: ${gap.join(', ')}`);
  assert(!extra.length, `handbooks claim archetypes that do not exist: ${extra.join(', ')}`);
  return `${Object.keys(HANDBOOKS).length} handbooks cover ${mapped.length} archetypes`;
});

check('the generic seat and the folded archetypes are gone', () => {
  for (const gone of ['employee', 'refactorer', 'debugger', 'builder']) {
    assert(!fs.existsSync(path.join(repo, 'agents', `${gone}.md`)), `agents/${gone}.md is back`);
  }
  return 'employee, refactorer and debugger are not files';
});

check('stacked-lead routes every archetype, and research comes first', () => {
  const lead = fs.readFileSync(path.join(repo, 'skills', 'stacked-lead', 'SKILL.md'), 'utf8');
  assert(/^## Routing$/m.test(lead), 'stacked-lead has no Routing section');
  const rows = [...lead.matchAll(/^\|[^|\n]*\|\s*`([a-z0-9-]+)`\s*\|$/gm)].map((m) => m[1]);
  const missing = archetypes.filter((id) => !rows.includes(id));
  assert(!missing.length, `stacked-lead has no routing row for: ${missing.join(', ')}`);
  assert(rows.length === archetypes.length, `routing table has ${rows.length} rows for ${archetypes.length} archetypes`);
  assert(/`researcher` or `scout` before it is briefed/.test(lead), 'the routing section does not put research before the brief');
  return `${rows.length} rows, one per archetype`;
});

check('OWNER.md holds the standing decisions', () => {
  const p = path.join(repo, 'OWNER.md');
  assert(fs.existsSync(p), 'OWNER.md is missing');
  const text = fs.readFileSync(p, 'utf8');
  assert(/standing decisions/i.test(text), 'OWNER.md does not say "standing decisions"');
  assert(/source hierarchy/i.test(text), 'OWNER.md does not name the source hierarchy');
  assert(/upstream code and docs at the pinned version/i.test(text), 'OWNER.md has no tier 1');
  assert(/upstream wins until a pinned test says otherwise/i.test(text), 'OWNER.md has no precedence rule');
  assert(/money above the standing cap/i.test(text), 'OWNER.md does not carry the money cap');
  return 'standing decisions, source hierarchy, five stops';
});

check('the four autonomy rules are in pls, lead and employee', () => {
  const rules = ['bounded research first', 'carries its source and date', 'names what it looked for', 'routing decision'];
  for (const id of ['stacked-pls', 'stacked-lead', 'stacked-employee']) {
    const text = fs.readFileSync(path.join(repo, 'skills', id, 'SKILL.md'), 'utf8');
    for (const rule of rules) assert(text.toLowerCase().includes(rule), `${id} is missing the rule "${rule}"`);
  }
  for (const id of ['stacked-pls', 'stacked-lead']) {
    assert(/OWNER\.md/.test(fs.readFileSync(path.join(repo, 'skills', id, 'SKILL.md'), 'utf8')), `${id} never names OWNER.md`);
  }
  return 'four rules in three skills, OWNER.md required in pls and lead';
});

check('the stop list is five everywhere, and money is in it', () => {
  const boot = bootstrap();
  assert(/\bfive\b/.test(boot), 'the bootstrap does not say five');
  assert(/money/.test(boot), 'the bootstrap omits the money cap');
  assert(!/four things/i.test(boot), 'the bootstrap still says four things');
  const text = (p) => fs.readFileSync(p, 'utf8');
  const walk = (d) =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) => {
        if (e.name === '.git' || e.name === 'node_modules') return [];
        const p = path.join(d, e.name);
        return e.isDirectory() ? walk(p) : [p];
      })
      .filter((p) => /\.(md|js|mjs)$/.test(p));
  const files = [
    ...walk(path.join(repo, 'agents')),
    ...walk(path.join(repo, 'skills')),
    ...walk(path.join(repo, 'lib')),
    path.join(repo, 'README.md'),
  ];
  const offenders = files.filter((p) => /four things|four stop conditions/i.test(text(p)));
  assert(
    !offenders.length,
    `the stop list is still four in: ${offenders.map((p) => path.relative(repo, p)).join(', ')}`,
  );
  return `bootstrap ${boot.length} chars, five stops, no "four things"`;
});

await checkAsync('a dispatch block names the archetype, its routed model, or unassigned', async () => {
  const d = configuredRepo();
  const assigned = await runIn(d, 'brief', {
    op: 'new',
    agent: 'qa',
    title: 'named seat',
    out: 'a thing',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['n.md'],
  });
  assert(/Agent: qa \(openai\/gpt-6\.1-terra\)/.test(assigned), `the block did not name the archetype and model:\n${assigned}`);

  const unassigned = await runIn(d, 'brief', {
    op: 'new',
    title: 'no seat',
    out: 'a thing',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['m.md'],
  });
  assert(/Agent: unassigned/.test(unassigned), `a seam with no archetype did not print unassigned:\n${unassigned}`);

  const gate = await runIn(d, 'ready', { id: 'no-seat', lean: true });
  assert(/NO-GO/.test(gate), `a seam with no archetype was gated GO:\n${gate}`);
  assert(/archetype/i.test(gate), `the missing archetype was not named:\n${gate}`);

  const bogus = await runIn(d, 'brief', {
    op: 'new',
    agent: 'wizard',
    title: 'bogus seat',
    out: 'a thing',
    check: 'node -e "process.exit(0)"',
    owns: ['**'],
    files: ['o.md'],
  });
  assert(/Refused/.test(bogus), 'an archetype absent from routing.json was accepted');
  assert(!fs.existsSync(path.join(d, '.stack', 'briefs', 'bogus-seat.md')), 'the refused brief was still written');

  fs.rmSync(d, { recursive: true, force: true });
  return 'named, unassigned, refused at the gate';
});

check('the removed CEO seat is gone, not shadowed', () => {
  assert(!fs.existsSync(path.join(repo, 'agents', 'ceo.md')), 'agents/ceo.md is back');
  assert(!fs.existsSync(path.join(repo, 'skills', 'stacked-ceo')), 'skills/stacked-ceo/ is back');
  // Two files must name the deletion: the cleanup list in the installer, and
  // this guard. Every other reference is a ghost seat.
  const allowed = new Set(['scripts/check.mjs', 'scripts/install.mjs']);
  const offenders = [];
  const walk = (d) =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) => {
        if (e.name === '.git' || e.name === 'node_modules') return [];
        const p = path.join(d, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
  for (const file of walk(repo)) {
    const where = path.relative(repo, file).replace(/\\/g, '/');
    if (allowed.has(where)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (/stacked-ceo/.test(text) || /agents[\\/]ceo\.md/.test(text)) offenders.push(where);
  }
  assert(!offenders.length, `the deleted CEO seat is still referenced in: ${offenders.join(', ')}`);
  return 'no ghost seat';
});

const commandFiles = fs.readdirSync(path.join(repo, 'commands')).filter((f) => f.endsWith('.md'));

check('four commands exist and are templates, not code', () => {
  assert(commandFiles.length === 4, `expected 4 commands, got ${commandFiles.length}: ${commandFiles.join(', ')}`);
  for (const f of commandFiles) {
    const raw = fs.readFileSync(path.join(repo, 'commands', f), 'utf8');
    assert(/^---\n[\s\S]*?description:/m.test(raw), `${f} has no description`);
    assert(!/^template:/m.test(raw), `${f} puts template in frontmatter`);
    const body = raw.split('---').slice(2).join('---').trim();
    assert(body.length > 80, `${f} body is empty`);
  }
  return commandFiles.length + ' commands';
});

check('provenance lives in exactly one file', () => {
  const forbidden = /karpathy|gstack|superpowers|garrytan|obra|multica/i;
  const walk = (d) =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) => {
        // `.stack/` is working state: a brief may cite a reference
        // implementation to study without that becoming shipped lineage.
        if (e.name === '.git' || e.name === 'node_modules' || e.name === '.stack') return [];
        const p = path.join(d, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
  const offenders = walk(repo)
    .filter((p) => /\.(md|js|mjs|json)$/.test(p))
    .filter((p) => path.basename(p) !== 'SOURCES.md' && !p.includes('scripts'))
    .filter((p) => forbidden.test(fs.readFileSync(p, 'utf8')))
    .map((p) => path.relative(repo, p));
  assert(offenders.length === 0, `named outside SOURCES.md: ${offenders.join(', ')}`);
  return 'SOURCES.md only';
});

check('README points at SOURCES.md for lineage', () => {
  const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  assert(/SOURCES\.md/.test(readme), 'README never mentions where the lineage is recorded');
  return 'pointer present';
});

// ---------------------------------------------------------------- report
fs.rmSync(dir, { recursive: true, force: true });

const total = pass + failures.length;
process.stdout.write(`\n${pass}/${total} passed\n\n`);
if (failures.length) {
  process.stdout.write('Failed:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.err.message}\n`);
  process.exit(1);
}
process.stdout.write('The plugin does what it says. Install it, then restart OpenCode.\n\n');

