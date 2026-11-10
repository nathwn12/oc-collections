#!/usr/bin/env node
// The fallback CLI. It exists because the gate has to work when the plugin does
// not load: no OpenCode, no host, no agent. It parses argv, calls the same
// functions in lib/, prints, and exits. If a decision ever lands here, it is a
// bug: the behaviour belongs in lib/tools.js with the plugin's tools.
import path from 'node:path';
import { toolDefinitions } from '../lib/tools.js';

const USAGE = `stack — the gate without the plugin

  node bin/stack.js check init | run | show
  node bin/stack.js ready --id <seam> [--lean]
  node bin/stack.js clean [--op sweep | report]
  node bin/stack.js ledger digest

Options:
  --dir <path>   the repository to operate on (default: the working directory)
  --help         this text

Exit codes: 0 success, 1 refusal or failure, 2 bad usage.
Every command runs the same code the plugin's tools run.`;

function usageError(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

let dir = process.cwd();
const flags = { op: undefined, id: undefined, lean: false };
const positional = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const value = () => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) usageError(`${arg} needs a value`);
    i += 1;
    return next;
  };
  if (arg === '--dir') dir = value();
  else if (arg === '--id') flags.id = value();
  else if (arg === '--op') flags.op = value();
  else if (arg === '--lean') flags.lean = true;
  else if (arg.startsWith('-')) usageError(`unknown option: ${arg}`);
  else positional.push(arg);
}

const [command, sub] = positional;
if (positional.length > 2) usageError(`too many arguments: ${positional.join(' ')}`);

/** Resolve the tools against the target repository, exactly as the plugin does. */
const tools = toolDefinitions({ dir: path.resolve(dir) });
const call = async (name, input) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const result = await tool.execute(input, {});
  return typeof result === 'string' ? result : result?.content || '';
};

const FAILED = /^(NO-GO|RED|Refused)\b/m;

let text;
if (command === 'check') {
  if (!['init', 'run', 'show'].includes(sub)) usageError('check takes init, run or show');
  text = await call('check', { op: sub });
} else if (command === 'ready') {
  if (sub) usageError('ready takes no positional argument; use --id');
  if (!flags.id) usageError('ready needs --id <seam>');
  text = await call('ready', { id: flags.id, lean: flags.lean });
} else if (command === 'clean') {
  const op = flags.op || 'sweep';
  if (!['sweep', 'report'].includes(op)) usageError('--op takes sweep or report');
  text = await call('clean', { op });
} else if (command === 'ledger') {
  if (sub !== 'digest') usageError('ledger takes digest');
  text = await call('ledger', { op: 'digest' });
} else {
  usageError(`unknown command: ${command}`);
}

process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
process.exit(FAILED.test(text) ? 1 : 0);
