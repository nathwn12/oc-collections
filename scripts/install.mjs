#!/usr/bin/env node
/**
 * Wire oc-stacked into this machine's OpenCode install.
 *
 * The plugin itself is a directory junction, so edits in this repo are live on
 * the next OpenCode restart with no copy step. Agents and commands are small
 * text files that OpenCode reads from disk, so they are copied (junctions per
 * file would need developer mode on Windows).
 *
 *   node scripts/install.mjs            install or update
 *   node scripts/install.mjs --remove   remove everything it added
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const remove = process.argv.includes('--remove');

const configDir =
  process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
const pluginsDir = path.join(configDir, 'plugins');
const agentsDir = path.join(configDir, 'agents');
const commandsDir = path.join(configDir, 'commands');
const linkPath = path.join(pluginsDir, 'oc-stacked');

const say = (s) => process.stdout.write(`${s}\n`);
const ok = (s) => say(`  ok   ${s}`);
const warn = (s) => say(`  warn ${s}`);

function linkDirectory(target, link) {
  if (fs.existsSync(link) || isLink(link)) {
    const stat = fs.lstatSync(link);
    if (stat.isSymbolicLink()) fs.unlinkSync(link);
    else if (stat.isDirectory() && !isLink(link)) {
      const entries = fs.readdirSync(link);
      if (entries.length) {
        warn(`${link} already exists as a real directory with ${entries.length} entries; leaving it alone`);
        return false;
      }
      fs.rmdirSync(link);
    } else fs.unlinkSync(link);
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    // 'junction' is the one link type Windows allows without elevation.
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (err) {
    warn(`could not link ${link} (${err.message}); falling back to a copy`);
    fs.cpSync(target, link, { recursive: true });
    return true;
  }
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    n += 1;
  }
  return n;
}

function clearDir(target) {
  if (!fs.existsSync(target)) return 0;
  const ours = fs
    .readdirSync(target)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => /^(ceo|lead|employee|auditor|stack|stack-check|stack-ready|stack-digest)\.md$/.test(f));
  for (const f of ours) fs.unlinkSync(path.join(target, f));
  return ours.length;
}

if (remove) {
  say('Removing oc-stacked from OpenCode');
  if (fs.existsSync(linkPath) || isLink(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
    else fs.rmSync(linkPath, { recursive: true, force: true });
    ok(`removed ${linkPath}`);
  } else warn('plugin link was not present');
  ok(`removed ${clearDir(agentsDir)} agent file(s) from ${agentsDir}`);
  ok(`removed ${clearDir(commandsDir)} command file(s) from ${commandsDir}`);
  say('\nRestart OpenCode. The plugin is gone; any .stack/ folders in projects are untouched.');
  process.exit(0);
}

say(`Installing oc-stacked\n  repo:   ${repo}\n  config: ${configDir}\n`);

if (!fs.existsSync(path.join(repo, 'index.js'))) {
  say(`No index.js in ${repo}. Run this from the repository, not from a copy of the script.`);
  process.exit(1);
}

if (linkDirectory(repo, linkPath)) ok(`plugin → ${linkPath}`);
ok(`${copyDir(path.join(repo, 'agents'), agentsDir)} agent file(s) → ${agentsDir}`);
ok(`${copyDir(path.join(repo, 'commands'), commandsDir)} command file(s) → ${commandsDir}`);

say(`
Done. Three things happen on next launch:

  1. OpenCode loads the package at
     ${linkPath}
  2. Twelve skills register: stacked, stacked-soul, stacked-ceo, stacked-lead,
     stacked-employee, stacked-audit, stacked-plan, stacked-swarm, stacked-debug,
     stacked-tdd, stacked-review, stacked-ship
  3. Four agents appear: ceo, lead, employee, auditor

Restart OpenCode, then prove it loaded:

  node scripts/check.mjs                      local self-test, no OpenCode needed
  opencode run --print-logs "say OK" 2>&1 | grep -i oc-stacked

First use, in any project:

  /stack <what you want done>
`);

const probe = spawnSync(process.execPath, [path.join(repo, 'scripts', 'check.mjs')], {
  cwd: repo,
  encoding: 'utf8',
});
if (probe.status !== 0) {
  say('\nThe local self-test failed:');
  say(probe.stdout || '');
  say(probe.stderr || '');
  process.exit(probe.status || 1);
}
say(probe.stdout.trim().split('\n').slice(-3).join('\n'));
