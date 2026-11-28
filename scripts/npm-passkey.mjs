#!/usr/bin/env node
/**
 * npm-passkey.mjs - the owner-only npm steps that need a physical passkey.
 *
 * `npm login --auth-type=web`, `npm publish` and `npm trust github` are
 * 2FA-gated: the second factor is a passkey in the owner's browser, with no
 * code to type and no token an agent may use. This script is the procedure.
 *
 * It prints a banner before each step, inherits npm's own browser flow and
 * waits for the process to exit. The owner clicks the passkey; the log records
 * every step and exit code. Nobody types or stores a code.
 *
 * Order matters for a name the registry does not have yet: a trusted publisher
 * is configured on an existing package, so the first release of a new name is
 * publish, then trust - never trust first.
 *
 * Usage:
 *   node scripts/npm-passkey.mjs login
 *   node scripts/npm-passkey.mjs publish [--workspace <name>] [--version <x.y.z>] [--window]
 *   node scripts/npm-passkey.mjs trust --package <name> --repo <owner/repo> --file <workflow.yml> [--window]
 *   node scripts/npm-passkey.mjs release [--workspace <name>] [--version <x.y.z>] --package <name> --repo <owner/repo> --file <workflow.yml> [--window]
 *
 * Options:
 *   --window       open a separate console window that runs the steps and stays
 *                  open, then exit here; the caller watches --log instead
 *   --version <x.y.z>  publish this version instead of the manifest's, then
 *                  put the manifest back. Use it to fill a version whose tag
 *                  already exists after a failed OIDC publish.
 *   --cwd <dir>    run in this repository (default: the current directory)
 *   --log <file>   log path (default: %TEMP%/oc-npm-passkey-<timestamp>.log)
 *   --dry-run      print the exact sequence; run no npm command
 *
 * Never pass a token. Never run this headless. Never automate the browser.
 * A failure stops the sequence; fix the step and re-run the same command.
 */
import { spawn, spawnSync } from 'node:child_process';
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
  '  publish    npm publish [--workspace <name>] [--version <x.y.z>]',
  '  trust      npm trust github <package> --file <workflow.yml> --repo <owner/repo> --allow-publish -y',
  '  release    login, then publish, then trust',
  '',
  'options:',
  '  --workspace <name>   the workspace to publish (monorepo only)',
  '  --package <name>     the package to trust (default: the workspace or cwd package)',
  '  --version <x.y.z>    publish this version, then restore the manifest',
  '  --repo <owner/repo>  the GitHub repository for the trust',
  '  --file <release.yml> the workflow file for the trust',
  '  --window             run the steps in a separate console window and exit',
  '  --cwd <dir>          run in this repository (default: the current directory)',
  '  --log <file>         the log path (default: %TEMP%/oc-npm-passkey-<timestamp>.log)',
  '  --dry-run            print the exact sequence; run no npm command',
  '',
  'A new name is published before it is trusted: npm configures a trusted',
  'publisher on a package that already exists, so OIDC cannot create one.',
  '',
  'The owner must click the passkey in the browser. There is no code to type.',
].join('\n');

if (!action) {
  console.error(usage);
  process.exit(2);
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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
const targetVersion = value('--version');
const windowMode = has('--window');
const dryRun = has('--dry-run');
const logFile =
  value('--log') ?? path.join(os.tmpdir(), `oc-npm-passkey-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
fs.mkdirSync(path.dirname(logFile), { recursive: true });

const log = (text) => {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${text}\n`);
  console.log(text);
};

if (targetVersion && !SEMVER.test(targetVersion)) {
  log(`--version must be x.y.z, got ${targetVersion}.`);
  process.exit(2);
}

const npmBin = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

// Read-only registry lookup: the published version, or null when the registry
// has no such package or version.
const registryVersion = (spec) => {
  const result = spawnSync(npmBin(), ['view', spec, 'version', '--json'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) return null;
  const raw = (result.stdout ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  } catch {
    return null;
  }
};

const workspaceManifest = (name) => {
  const root = path.join(cwd, 'packages');
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root)) {
    const file = path.join(root, entry, 'package.json');
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.name === name) return { file, manifest: parsed };
  }
  return null;
};

const publishing = action === 'publish' || action === 'release';
const publishTarget = publishing
  ? workspace
    ? workspaceManifest(workspace)
    : { file: manifestPath, manifest }
  : null;

if (publishing && workspace && !publishTarget) {
  console.error(`no workspace named ${workspace} under packages/.`);
  process.exit(2);
}
if (publishing && !workspace && manifest.private === true) {
  console.error('this package is private. Pass --workspace <name> for a monorepo package.');
  process.exit(2);
}

const publishVersion = targetVersion ?? publishTarget?.manifest.version;

const commands = { login: ['login', '--auth-type=web'] };

if (publishing) {
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

const steps = [];
if (action === 'release') steps.push(['login', commands.login]);
if (publishing) steps.push(['publish', commands.publish]);
if (action === 'trust' || action === 'release') steps.push(['trust', commands.trust]);

// --window: hand the whole sequence to a separate console so the owner can
// click the passkey there while the caller only reads the log.
if (windowMode) {
  const forwarded = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--window') continue;
    if (argv[i] === '--log') {
      i += 1;
      continue;
    }
    forwarded.push(argv[i]);
  }
  forwarded.push('--log', logFile);
  const quote = (text) => `"${text}"`;
  const cmdFile = path.join(os.tmpdir(), `oc-npm-passkey-window-${Date.now()}.cmd`);
  const cmdLines = [
    '@echo off',
    'title npm-passkey',
    `${quote(process.execPath)} ${[process.argv[1], ...forwarded].map(quote).join(' ')}`,
    'echo.',
    'echo This window stays open so the result can be read. Press any key to close.',
    'pause >nul',
  ];
  fs.writeFileSync(cmdFile, `${cmdLines.join('\r\n')}\r\n`);
  // `start` is the launcher that actually creates a visible console from a
  // process that has none: Start-Process from Windows PowerShell exits 0 and
  // silently launches nothing here, and conhost needs a console to host.
  const launcher = spawn('cmd.exe', ['/c', 'start', '', '/D', cwd, 'cmd.exe', '/c', cmdFile], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  launcher.on('error', (error) => {
    log(`could not open the console window: ${error.message}. Re-run without --window in a terminal.`);
    process.exit(1);
  });
  launcher.unref();
  log(`opened a separate console window for ${action}; it waits for the passkey click`);
  log(`log: ${logFile}`);
  log(`window command: ${cmdFile}`);
  process.exit(0);
}

let restoreManifest = null;

const pinVersion = () => {
  if (!targetVersion) return;
  if (dryRun) {
    log(`would pin ${path.relative(cwd, publishTarget.file)} to ${targetVersion}, then restore it`);
    return;
  }
  const original = fs.readFileSync(publishTarget.file, 'utf8');
  restoreManifest = () => fs.writeFileSync(publishTarget.file, original);
  const next = { ...publishTarget.manifest, version: targetVersion };
  fs.writeFileSync(
    publishTarget.file,
    `${JSON.stringify(next, null, 2)}${original.endsWith('\n') ? '\n' : ''}`
  );
  log(`pinned ${path.relative(cwd, publishTarget.file)} to ${targetVersion}; it is restored after the publish`);
};

const unpinVersion = () => {
  if (!restoreManifest) return;
  restoreManifest();
  restoreManifest = null;
};

const run = (label, args) =>
  new Promise((resolve) => {
    log(`\n=== ${label} ===\n$ npm ${args.join(' ')}\nOWNER: click the passkey when the browser asks. This window waits.`);
    if (dryRun) {
      log('DRY RUN: not executed');
      resolve(0);
      return;
    }
    const child = spawn(npmBin(), args, {
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

// The registry is eventually consistent: a publish that returned 0 can take a
// few seconds to answer. Wait for the exact version instead of trusting the
// exit code alone.
const waitForRegistry = async (name, version) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (registryVersion(`${name}@${version}`) === version) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
};

log(`npm-passkey: action=${action} cwd=${cwd} dry=${dryRun}`);
log(`log: ${logFile}`);

if (publishing && !dryRun) {
  const published = registryVersion(`${packageName}@${publishVersion}`);
  if (published) {
    log(`STOPPED: ${packageName}@${publishVersion} is already on the registry. Pick the next version.`);
    process.exit(1);
  }
  if (!registryVersion(packageName)) {
    log(`note: ${packageName} is not on the registry yet, so this is its first publish and the trust follows it.`);
  }
}

for (const [label, args] of steps) {
  if (label === 'publish') pinVersion();
  if (label === 'trust' && !dryRun && !registryVersion(packageName)) {
    unpinVersion();
    log(`STOPPED at trust: ${packageName} is not on the registry. npm configures a trusted publisher on a package that already exists, so publish it once first.`);
    process.exit(1);
  }
  const code = await run(label, args);
  if (label === 'publish') {
    unpinVersion();
    if (code === 0 && !dryRun && !(await waitForRegistry(packageName, publishVersion))) {
      log(`STOPPED after publish: the registry does not serve ${packageName}@${publishVersion}. Do not configure the trust; investigate the publish first.`);
      process.exit(1);
    }
    if (code === 0 && !dryRun) log(`verified on the registry: ${packageName}@${publishVersion}`);
  }
  if (code !== 0) {
    unpinVersion();
    log(`STOPPED at ${label}: exit ${code}. Fix the step, then re-run the same command.`);
    process.exit(code);
  }
}
log('DONE: every npm step exited 0.');
