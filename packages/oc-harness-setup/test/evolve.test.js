/**
 * Hermetic tests for the standalone evolve engine. Every I/O seam is injected:
 * no network, no real config dir, no CLI, no doctor script. Files live only in
 * temp dirs under os.tmpdir and are removed after each test.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createEvolve } from '../bin/evolve.mjs';

const TEMPLATES = {
  'skill.md': ['---', 'name: {{id}}', 'description: "{{description}}"', '---', '', '# {{title}}', '', '{{body}}', ''].join('\n'),
  'command.md': ['---', 'description: "{{description}}"', 'agent: orchestrator', 'subagent: false', '---', '', '# {{title}}', '', 'Load the `{{id}}` skill.', '', '{{body}}', ''].join('\n'),
  'agent.md': ['---', 'description: "{{description}}"', 'steps: 40', '---', '', '# {{title}}', '', '{{body}}', ''].join('\n'),
  'playbook.md': ['Entry criteria: {{description}}', '', '### {{title}}', '', 'You own the {{id}} task.', '', '{{body}}', ''].join('\n'),
};

function configText(resources = ['close', 'evolve', 'fast', 'loop', 'search', 'swarm']) {
  return [
    '{',
    '  "permissions": [',
    ...resources.flatMap((r, i) => [
      '    {',
      '      "action": "skill",',
      `      "resource": "${r}",`,
      '      "effect": "allow"',
      `    }${i < resources.length - 1 ? ',' : ''}`,
    ]),
    '  ]',
    '}',
    '',
  ].join('\n');
}

function routerText(names = ['bug-fix']) {
  return [
    '---',
    'name: playbook',
    'description: "router"',
    '---',
    '',
    '# playbook',
    '',
    '| Task | Playbook |',
    '|---|---|',
    ...names.map((n) => `| Fix a reproduced failure | playbooks/${n}.md |`),
    '',
    '## Rule',
    '',
    '1. Match one row.',
    '',
  ].join('\n');
}

function snapshot(base) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[path.relative(base, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8');
    }
  };
  if (existsSync(base)) walk(base);
  return out;
}

function harness(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-evolve-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const pkgRoot = path.join(base, 'pkg');
  const configDir = path.join(base, 'cfg');
  const bodyPath = path.join(base, 'body.md');
  const lines = [];
  const doctorCalls = [];
  const state = { doctorCode: 0, failWrite: null };

  const put = (p, text) => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  for (const [name, text] of Object.entries(TEMPLATES)) {
    put(path.join(pkgRoot, 'templates', name), text);
  }
  put(bodyPath, 'Do the body.');
  put(path.join(configDir, 'opencode.jsonc'), configText());
  put(path.join(configDir, 'skills', 'playbook', 'SKILL.md'), routerText());

  const seams = {
    pkgRoot,
    configDir,
    readText: (p) => readFileSync(p, 'utf8'),
    writeText: (p, text) => {
      if (p === state.failWrite) throw new Error(`EACCES injected write failure: ${p}`);
      put(p, text);
    },
    log: (line) => { lines.push(String(line)); },
    runDoctor: async (dir) => { doctorCalls.push(dir); return state.doctorCode; },
  };

  return {
    base, pkgRoot, configDir, bodyPath, lines, doctorCalls, state, seams,
    evolve: createEvolve(seams),
    put,
    read: (p) => readFileSync(p, 'utf8'),
    has: (p) => existsSync(p),
    snapshot: () => snapshot(base),
  };
}

function options(h, over = {}) {
  return {
    kind: 'command',
    id: 'new-thing',
    title: 'New thing',
    description: 'Use when a new thing arrives.',
    body: h.bodyPath,
    ...over,
  };
}

const under = (h, ...parts) => path.join(h.configDir, ...parts);
const allowCount = (h, id) => (h.read(under(h, 'opencode.jsonc')).match(new RegExp(`"resource": "${id}"`, 'g')) || []).length;

test('command writes only its command file', async (t) => {
  const h = harness(t);
  const code = await h.evolve(options(h, { kind: 'command' }));
  assert.equal(code, 0);
  const target = under(h, 'commands', 'new-thing.md');
  assert.ok(h.has(target), 'command file written');
  assert.ok(!h.has(under(h, 'skills', 'new-thing', 'SKILL.md')), 'no skill');
  assert.ok(!h.has(under(h, 'agents', 'new-thing.md')), 'no agent');
  assert.ok(h.read(target).includes('Do the body.'), 'body rendered');
  assert.deepEqual(h.doctorCalls, [h.configDir], 'doctor called with configDir');
});

test('agent writes only its agent file', async (t) => {
  const h = harness(t);
  const code = await h.evolve(options(h, { kind: 'agent' }));
  assert.equal(code, 0);
  assert.ok(h.has(under(h, 'agents', 'new-thing.md')), 'agent file written');
  assert.ok(!h.has(under(h, 'commands', 'new-thing.md')), 'no command shim');
  assert.ok(!h.has(under(h, 'skills', 'new-thing', 'SKILL.md')), 'no skill');
});

test('playbook writes its file and one router row', async (t) => {
  const h = harness(t);
  const code = await h.evolve(options(h, { kind: 'playbook' }));
  assert.equal(code, 0);
  assert.ok(h.has(under(h, 'playbooks', 'new-thing.md')), 'playbook written');
  const router = h.read(under(h, 'skills', 'playbook', 'SKILL.md'));
  assert.ok(router.includes('| New thing | playbooks/new-thing.md |'), 'plain path cell appended');
  assert.equal((router.match(/playbooks\/new-thing\.md/g) || []).length, 1, 'row once');
});

test('skill writes skill, shim, and one allow entry', async (t) => {
  const h = harness(t);
  const code = await h.evolve(options(h, { kind: 'skill' }));
  assert.equal(code, 0);
  assert.ok(h.has(under(h, 'skills', 'new-thing', 'SKILL.md')), 'skill written');
  assert.ok(h.has(under(h, 'commands', 'new-thing.md')), 'shim written');
  assert.equal(allowCount(h, 'new-thing'), 1, 'allow entry added once');
  assert.ok(h.read(under(h, 'opencode.jsonc')).includes('"action": "skill"'), 'shipped shape kept');
});

test('re-running a skill keeps one allow entry under force', async (t) => {
  const h = harness(t);
  assert.equal(await h.evolve(options(h, { kind: 'skill', force: true })), 0);
  assert.equal(await h.evolve(options(h, { kind: 'skill', force: true })), 0);
  assert.equal(allowCount(h, 'new-thing'), 1, 'no duplicate allow');
});

test('re-running a playbook keeps one router row under force', async (t) => {
  const h = harness(t);
  assert.equal(await h.evolve(options(h, { kind: 'playbook', force: true })), 0);
  assert.equal(await h.evolve(options(h, { kind: 'playbook', force: true })), 0);
  const router = h.read(under(h, 'skills', 'playbook', 'SKILL.md'));
  assert.equal((router.match(/playbooks\/new-thing\.md/g) || []).length, 1, 'no duplicate row');
});

test('dry run prints every write and amend but writes nothing', async (t) => {
  const h = harness(t);
  const before = h.snapshot();
  const code = await h.evolve(options(h, { kind: 'skill', dryRun: true }));
  assert.equal(code, 0);
  assert.deepEqual(h.snapshot(), before, 'no file changed');
  assert.equal(h.doctorCalls.length, 0, 'doctor not called');
  assert.ok(h.lines.includes(`would write ${under(h, 'skills', 'new-thing', 'SKILL.md')}`));
  assert.ok(h.lines.includes(`would write ${under(h, 'commands', 'new-thing.md')}`));
  assert.ok(h.lines.includes(`would amend ${under(h, 'opencode.jsonc')}`));
});

test('bad kind exits 2 and names valid kinds', async (t) => {
  const h = harness(t);
  const code = await h.evolve(options(h, { kind: 'spell' }));
  assert.equal(code, 2);
  assert.ok(h.lines.some((l) => l.includes('skill, command, agent, playbook')), h.lines.join('\n'));
  assert.equal(h.has(under(h, 'commands', 'new-thing.md')), false);
});

test('bad id exits 2', async (t) => {
  const h = harness(t);
  const code = await h.evolve(options(h, { id: 'Bad_Id' }));
  assert.equal(code, 2);
  assert.ok(h.lines.some((l) => l.includes('invalid id')), h.lines.join('\n'));
});

test('existing id without force exits 1 and names the path', async (t) => {
  const h = harness(t);
  const target = under(h, 'commands', 'new-thing.md');
  h.put(target, 'existing content');
  const code = await h.evolve(options(h));
  assert.equal(code, 1);
  assert.ok(h.lines.some((l) => l.includes(target)), h.lines.join('\n'));
  assert.equal(h.read(target), 'existing content', 'no overwrite');
  assert.equal(h.doctorCalls.length, 0);
});

test('write failure rolls back every new file and exits 1', async (t) => {
  const h = harness(t);
  const config = h.read(under(h, 'opencode.jsonc'));
  const skillPath = under(h, 'skills', 'new-thing', 'SKILL.md');
  const shimPath = under(h, 'commands', 'new-thing.md');
  h.state.failWrite = under(h, 'opencode.jsonc');
  const code = await h.evolve(options(h, { kind: 'skill' }));
  assert.equal(code, 1);
  assert.ok(!h.has(skillPath), 'skill removed');
  assert.ok(!h.has(shimPath), 'shim removed');
  assert.equal(h.read(under(h, 'opencode.jsonc')), config, 'config unchanged');
  assert.equal(h.doctorCalls.length, 0, 'doctor not called after failed write');
});

test('write failure restores pre-existing files and exits 1', async (t) => {
  const h = harness(t);
  const skillPath = under(h, 'skills', 'new-thing', 'SKILL.md');
  const shimPath = under(h, 'commands', 'new-thing.md');
  h.put(skillPath, 'old skill');
  h.put(shimPath, 'old shim');
  h.state.failWrite = under(h, 'opencode.jsonc');
  const code = await h.evolve(options(h, { kind: 'skill', force: true }));
  assert.equal(code, 1);
  assert.equal(h.read(skillPath), 'old skill', 'skill restored');
  assert.equal(h.read(shimPath), 'old shim', 'shim restored');
});

test('a doctor exit of 1 is returned to the caller', async (t) => {
  const h = harness(t);
  h.state.doctorCode = 1;
  const code = await h.evolve(options(h, { kind: 'command' }));
  assert.equal(code, 1);
  assert.equal(h.doctorCalls.length, 1);
  assert.ok(h.has(under(h, 'commands', 'new-thing.md')), 'artifact kept; doctor result not swallowed');
});

test('unresolved template token exits 1 and writes nothing', async (t) => {
  const h = harness(t);
  h.put(path.join(h.pkgRoot, 'templates', 'command.md'), TEMPLATES['command.md'] + '\n{{leftover}}\n');
  const before = h.snapshot();
  const code = await h.evolve(options(h, { kind: 'command' }));
  assert.equal(code, 1);
  assert.deepEqual(h.snapshot(), before, 'no file changed');
});

test('omitted body keeps a short TODO marker', async (t) => {
  const h = harness(t);
  const code = await h.evolve(options(h, { body: undefined }));
  assert.equal(code, 0);
  assert.ok(h.read(under(h, 'commands', 'new-thing.md')).includes('TODO: add the procedure.'));
});
