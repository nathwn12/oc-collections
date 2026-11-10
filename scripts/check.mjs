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

process.stdout.write('\noc-stacked self-test\n\n');

// ---------------------------------------------------------------- module shape
const mod = await import(new URL('../index.js', import.meta.url));
const plugin = mod.default;
const { readSkills, bootstrap, MARKER } = await import(new URL('../lib/skills.js', import.meta.url));
const { toolDefinitions } = await import(new URL('../lib/tools.js', import.meta.url));
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

check('thirteen skills register', () => {
  assert(skills.length === 13, `expected 13, got ${skills.length}: ${skills.map((s) => s.id).join(', ')}`);
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

check('bootstrap is cached, marked, and small', () => {
  const a = bootstrap();
  const b = bootstrap();
  assert(a === b, 'bootstrap is rebuilt on every call (cache miss)');
  assert(a.startsWith(MARKER), 'bootstrap does not start with its marker');
  assert(a.includes('</STACKED>'), 'bootstrap has no closing marker');
  assert(a.length < 9000, `bootstrap is ${a.length} chars; it is paid for on every step`);
  assert(a.includes('stacked-lead') || a.includes('LEAD'), 'bootstrap does not name the rungs');
  assert(a.length < 3200, `bootstrap is ${a.length} chars; it is paid for on every step`);
  return `${a.length} chars`;
});

// ---------------------------------------------------------------- tools
const dir = tmpRepo();
const tools = toolDefinitions({ dir });

check('six tools are defined', () => {
  assert(tools.length === 6, `expected 6, got ${tools.length}`);
  const names = tools.map((t) => t.name);
  for (const required of ['ledger', 'brief', 'swarm', 'check', 'scope', 'ready']) {
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
  const out = await run('brief', { op: 'new', title: 'half a seam', out: 'something', owns: ['src/**'] });
  assert(/Refused/i.test(out), 'a brief without a check was accepted');
  assert(!fs.existsSync(path.join(dir, '.stack', 'briefs', 'half-a-seam.md')), 'the refused brief was still written');
  return 'no check, no brief';
});

await checkAsync('brief writes a contract that names the check', async () => {
  const out = await run('brief', {
    op: 'new',
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

await checkAsync('check refuses to claim green when HEAD moved after the run', async () => {
  fs.writeFileSync(path.join(dir, 'src', 'webhook.ts'), 'export const x = 2;\n');
  spawnSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', 'move head'], {
    cwd: dir,
    windowsHide: true,
  });
  const out = await run('ready', { id: 'retry-budget' });
  assert(/NO-GO/.test(out), 'a stale check was accepted');
  assert(/Re-run at the head|HEAD is/i.test(out), 'staleness was not named');
  return 'stale check refused';
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
      op: 'new',
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
      op: 'new',
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
    op: 'new',
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
  const refused = await run('brief', { op: 'status', id: 'retry-budget', status: 'landed' });
  assert(/Refused/.test(refused), 'a NO-GO seam was marked landed');
  assert(/RED/.test(refused), 'the last verdict was not quoted');
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
    op: 'new',
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
    op: 'new',
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
    op: 'new',
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
  await runIn(d, 'brief', { op: 'new', title: 'audited seam', out: 'a thing', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
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

// ---------------------------------------------------------------- agents, commands, provenance
const agentFiles = fs.readdirSync(path.join(repo, 'agents')).filter((f) => f.endsWith('.md'));

check('four agents exist with valid V2 frontmatter', () => {
  assert(agentFiles.length === 4, `expected 4 agents, got ${agentFiles.length}: ${agentFiles.join(', ')}`);
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
  return agentFiles.length + ' agents';
});

check('each seat is pinned to the right model', () => {
  const expected = {
    'stacked-ceo.md': 'opencode-go/muse-spark-1.3-contributor',
    'stacked-lead.md': 'opencode-go/muse-spark-1.3-contributor',
    'stacked-employee.md': 'opencode-go/deepseek-v4.1-flash',
    'stacked-auditor.md': 'openai/gpt-6.1-terra',
  };
  for (const [file, model] of Object.entries(expected)) {
    const raw = fs.readFileSync(path.join(repo, 'agents', file), 'utf8');
    const line = raw.match(/^model:\s*(.+)$/m);
    assert(line, `${file} has no model line`);
    assert(line[1].trim() === model, `${file} is ${line[1].trim()}, expected ${model}`);
  }
  return 'muse · deepseek · terra';
});

check('no agent lets an employee dispatch a subagent', () => {
  const raw = fs.readFileSync(path.join(repo, 'agents', 'stacked-employee.md'), 'utf8');
  assert(/action:\s*subagent[\s\S]{0,120}effect:\s*deny/.test(raw), 'stacked-employee.md does not deny the subagent action');
  return 'employee cannot delegate';
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
        if (e.name === '.git' || e.name === 'node_modules') return [];
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
