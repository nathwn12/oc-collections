/**
 * The fallback CLI, the command tokenizer, shell routing, and .cmd paths.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, needsShell } from '../../lib/exec.js';

export async function register(ctx) {
  const { check, checkAsync, assert, repo, tmpRepo, runIn } = ctx;

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
    // `init` detects `npm run test`, and `npm` is environment-sensitive inside a
    // temp repo (-4058). The subject here is the CLI gate, not the npm shim, so
    // the config is replaced with a direct command before the run.
    fs.writeFileSync(
      path.join(d, '.stack', 'config.json'),
      JSON.stringify({ checks: [{ name: 'ok', command: 'node -e "process.exit(0)"', timeout: 30000 }] }, null, 2),
    );
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
}
