#!/usr/bin/env node
/**
 * npm-passkey.mjs - the owner-only npm steps that need a physical passkey.
 *
 * `npm login --auth-type=web`, `npm publish` and `npm trust github` are
 * 2FA-gated: the second factor is a passkey in the owner's browser, with no
 * code to type and no token an agent may use. This script is the procedure.
 *
 * It must run in a visible terminal. It prints a banner before each step,
 * inherits npm's own browser flow, and waits for the process to exit. The
 * owner clicks the passkey; the log records every step and exit code.
 *
 * Usage:
 *   node scripts/npm-passkey.mjs login
 *   node scripts/npm-passkey.mjs publish [--workspace <name>]
 *   node scripts/npm-passkey.mjs trust --package <name> --repo <owner/repo> --file <workflow.yml>
 *   node scripts/npm-passkey.mjs release [--workspace <name>] --package <name> --repo <owner/repo> --file <workflow.yml>
 *
 * Options:
 *   --cwd <dir>    run in this repository (default: the current directory)
 *   --log <file>   log path (default: %TEMP%/oc-npm-passkey-<timestamp>.log)
 *   --dry-run      print the exact sequence; run no npm command
 *
 * Never pass a token. Never run this headless. Never automate the browser.
 * A failure stops the sequence; fix the step and re-run the same command.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const ACTIONS = ['login', 'publish', 'trust', 'release'];
const action = ACTIONS.find((name) => argv.includes(name));
const has = (name) => argv.includes(name);
const value = (name) => {
  const at = argv.indexOf(name);
  if (at < 0) return null;
  const next = argv[at + 1];
  if (!next || next.startsWith('--')) {
    console.error(`${name} needs a value.`);
    process.exit(2);
  }
  return next;
};

const usage = [
  'usage: node scripts/npm-passkey.mjs <login|publish|trust|release> [options]',
  '',
  '  login      npm login --auth-type=web',
  '  publish    npm publish [--workspace <name>]',
  '  trust      npm trust github <package> --file <workflow.yml> --repo <owner/repo> --allow-publish -y',
  '  release    login, then publish, then trust',
  '',
  'options:',
  '  --workspace <name>   the workspace to publish (monorepo only)',
  '  --package <name>     the package to trust (default: the workspace or cwd package)',
  '  --repo <owner/repo>  the GitHub repository for the trust',
  '  --file <release.yml> the workflow file for the trust',
  '  --cwd <dir>          run in this repository (default: the current directory)',
  '  --log <file>         the log path (default: %TEMP%/oc-npm-passkey-<timestamp>.log)',
  '  --dry-run            print the exact sequence; run no npm command',
  '',
  'The owner must click the passkey in the browser. There is no code to type.',
].join('\n');

if (!action) {
  console.error(usage);
  process.exit(2);
}

const cwd = path.resolve(value('--cwd') ?? process.cwd());
const manifestPath = path.join(cwd, 'package.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`no package.json in ${cwd}. Pass --cwd <repository> or run from the package root.`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const workspace = value('--workspace');
const packageName = value('--package') ?? workspace ?? manifest.name;
const repo = value('--repo');
const workflowFile = value('--file');
const logFile =
  value('--log') ?? path.join(os.tmpdir(), `oc-npm-passkey-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const dryRun = has('--dry-run');
fs.mkdirSync(path.dirname(logFile), { recursive: true });

const log = (text) => {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${text}\n`);
  console.log(text);
};

const commands = { login: ['login', '--auth-type=web'] };

if (action === 'publish' || action === 'release') {
  if (!workspace && manifest.private === true) {
    console.error('this package is private. Pass --workspace <name> for a monorepo package.');
    process.exit(2);
  }
  const args = ['publish'];
  if (workspace) args.push('--workspace', workspace);
  if (String(packageName).startsWith('@')) args.push('--access', 'public');
  commands.publish = args;
}

if (action === 'trust' || action === 'release') {
  if (!repo || !workflowFile) {
    console.error('trust needs --repo <owner/repo> and --file <workflow.yml>.');
    process.exit(2);
  }
  if (!/\.ya?ml$/i.test(workflowFile)) {
    console.error('--file must name a workflow ending in .yml or .yaml.');
    process.exit(2);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error('--repo must be owner/repo.');
    process.exit(2);
  }
  commands.trust = [
    'trust',
    'github',
    packageName,
    '--file',
    workflowFile,
    '--repo',
    repo,
    '--allow-publish',
    '-y',
  ];
}

const steps =
  action === 'release'
    ? [
        ['login', commands.login],
        ['publish', commands.publish],
        ['trust', commands.trust],
      ]
    : [[action, commands[action]]];

const run = (label, args) =>
  new Promise((resolve) => {
    log(`\n=== ${label} ===\n$ npm ${args.join(' ')}\nOWNER: click the passkey when the browser asks. This window waits.`);
    if (dryRun) {
      log('DRY RUN: not executed');
      resolve(0);
      return;
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: false,
    });
    child.on('error', (error) => {
      log(`spawn error: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => {
      log(`exit ${code ?? 1}`);
      resolve(code ?? 1);
    });
  });

log(`npm-passkey: action=${action} cwd=${cwd} dry=${dryRun}`);
log(`log: ${logFile}`);

for (const [label, args] of steps) {
  const code = await run(label, args);
  if (code !== 0) {
    log(`STOPPED at ${label}: exit ${code}. Fix the step, then re-run the same command.`);
    process.exit(code);
  }
}
log('DONE: every npm step exited 0.');
