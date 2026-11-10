/**
 * Porcelain -z output, rename pairing, and the committed range the gate reads.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandAsync } from '../../lib/exec.js';
import { snapshot } from '../../lib/git.js';

export async function register(ctx) {
  const { checkAsync, assert, tmpRepo, commitAll, configuredRepo, runIn } = ctx;

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
}
