#!/usr/bin/env node
/**
 * oc-terminal - the CLI.
 *
 *   oc-terminal runtime
 *   oc-terminal exec -- <command> [args...]
 *
 * Direct spawn only: no shell shim. `exec` is the hidden path a
 * script can use when it cannot import the plugin.
 */
import { resolveRuntime, spawnSyncHidden } from './lib.js';

const [, , command, ...rest] = process.argv;

if (command === 'runtime') {
  console.log(resolveRuntime());
  process.exit(0);
}

if (command === 'exec') {
  const split = rest.indexOf('--');
  const argv = split >= 0 ? rest.slice(split + 1) : rest;
  if (argv.length === 0) {
    console.error('usage: oc-terminal exec -- <command> [args...]');
    process.exit(2);
  }
  const result = spawnSyncHidden(argv[0], argv.slice(1), { stdio: 'inherit' });
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

console.error('usage: oc-terminal <runtime|exec -- command ...>');
process.exit(2);
