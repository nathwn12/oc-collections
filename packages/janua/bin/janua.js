#!/usr/bin/env node
// janua: the command a client launches. It resolves the installed version and
// gets out of the way.
//
// A client config that starts `janua` must survive an upgrade, so the process a
// client starts is a thin launcher: it reads the pointer in JANUA_HOME and
// re-runs the CLI inside the version prefix that pointer names
// (`node_modules/@nathwn12/janua/bin/janua-cli.js`) as a child with inherited
// stdio, forwarding signals and the child's exit status. With no pointer to a
// real install (a checkout, a fresh npx download) it runs its own copy directly.
//
// The pointer only ever names that CLI entry, and `readPointer` refuses any other
// target, so the launcher cannot spawn itself and a hand-edited pointer falls
// back to this copy instead of looping.

import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import { pointerBinPath } from '../lib/upgrade.js';

const argv = process.argv.slice(2);
const target = pointerBinPath();

if (target) {
  const child = spawn(process.execPath, [target, ...argv], { stdio: 'inherit' });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        /* already gone: the exit handler reports it */
      }
    });
  }

  child.on('error', (err) => {
    process.stderr.write(`janua: cannot start ${target}: ${err.message}\n`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    // The child's own status is the launcher's status, signals included.
    if (signal) process.exit(128 + (constants.signals[signal] ?? 0));
    process.exit(code ?? 1);
  });
} else {
  const { main } = await import('../lib/cli.js');
  await main(argv);
}
