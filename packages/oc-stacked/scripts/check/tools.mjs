/**
 * The seven tools and the refusals that keep a brief honest: a missing check,
 * a shared file, a traversal id, a dirty tree, a fence closed early.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toolDefinitions } from '../../lib/tools.js';

export async function register(ctx) {
  const { check, checkAsync, assert, tmpRepo, configuredRepo, runIn } = ctx;

  // The eight tools, and one committed fixture the brief/ledger chain mutates.
  const dir = tmpRepo();
  const tools = toolDefinitions({ dir });

  check('eight tools are defined', () => {
    assert(tools.length === 8, `expected 8, got ${tools.length}`);
    const names = tools.map((t) => t.name);
    for (const required of ['ledger', 'brief', 'swarm', 'check', 'scope', 'ready', 'clean', 'close']) {
      assert(names.includes(required), `missing tool: ${required}`);
    }
    return names.join(', ');
  });

  check('close exposes its three ops and names lesson as required for run', () => {
    const close = tools.find((t) => t.name === 'close');
    assert(close, 'the close tool is not defined');
    const op = close.input.properties.op;
    assert(op && op.type === 'string', 'close.op is not a string');
    const ops = Array.isArray(op.enum) ? [...op.enum].sort().join(',') : '';
    assert(ops === 'preflight,run,show', `close.op is ${ops || '(no enum)'}, not run|preflight|show`);
    const lesson = close.input.properties.lesson;
    assert(lesson && lesson.type === 'string', 'close has no lesson property');
    assert(/required for op=run/i.test(lesson.description || ''), `close.lesson does not say when it is required: ${lesson.description}`);
    assert(Array.isArray(close.input.required) && close.input.required.includes('op'), 'close does not require op');
    return 'run, preflight, show';
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

  const tool = (name) => tools.find((t) => t.name === name);

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
    const out = await runIn(dir, 'brief', { op: 'new', agent: 'backend', title: 'half a seam', out: 'something', owns: ['src/**'] });
    assert(/Refused/i.test(out), 'a brief without a check was accepted');
    assert(!fs.existsSync(path.join(dir, '.stack', 'briefs', 'half-a-seam.md')), 'the refused brief was still written');
    return 'no check, no brief';
  });

  await checkAsync('brief writes a contract that names the check', async () => {
    const out = await runIn(dir, 'brief', {
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

  fs.rmSync(dir, { recursive: true, force: true });
}
