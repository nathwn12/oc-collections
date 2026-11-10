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

function copyDir(from, to, pins) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const text = fs.readFileSync(source, 'utf8');
    const model = pins ? pins[entry.name.replace(/\.md$/, '')] : undefined;
    fs.writeFileSync(target, withModel(text, model));
    n += 1;
  }
  return n;
}

/**
 * The routing lives in one file and is applied to the copy, never to the repo.
 * A missing entry, or `null` for the lead, leaves the agent unpinned so the TUI
 * selection wins.
 */
const routing = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, 'routing.json'), 'utf8'));
  } catch (err) {
    warn(`routing.json could not be read (${err.message}); agents install unpinned`);
    return {};
  }
})();

function withModel(text, model) {
  if (!model) return text;
  const end = text.indexOf('\n---', 3);
  if (!text.startsWith('---') || end < 0) return text;
  const head = text.slice(0, end);
  if (/^model:/m.test(head)) return text;
  const lines = head.split('\n');
  const at = lines.findIndex((line) => /^mode:/.test(line));
  lines.splice(at < 0 ? 1 : at + 1, 0, `model: ${model}`);
  return lines.join('\n') + text.slice(end);
}

/** One line per agent: what it will run on once OpenCode restarts. */
function reportPins() {
  for (const entry of fs.readdirSync(path.join(repo, 'agents')).sort()) {
    if (!entry.endsWith('.md')) continue;
    const id = entry.replace(/\.md$/, '');
    const model = routing[id];
    ok(`${id} = ${model ? model.split('/').pop() : 'inherit'}`);
  }
}

/**
 * Remove only the files this repository actually ships, by exact name, so a
 * user's own `lead.md` or `stack.md` is never swept up with ours.
 */
function removeShipped(from, to) {
  if (!fs.existsSync(from) || !fs.existsSync(to)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const target = path.join(to, entry.name);
    if (!fs.existsSync(target)) continue;
    fs.unlinkSync(target);
    n += 1;
  }
  return n;
}

/**
 * Files an earlier install created that this one no longer ships. The current
 * repo cannot list them — they are deleted — so they are named here, and both
 * `install` and `--remove` prune them. An upgrade must not leave a ghost seat
 * in the TUI.
 */
const OBSOLETE = {
  agents: ['ceo.md', 'stacked-ceo.md', 'employee.md'],
  commands: [],
};

/** Delete obsolete names from a directory this repo owns, by exact name. */
function removeObsolete(dir, names) {
  let n = 0;
  for (const name of names) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) continue;
    fs.unlinkSync(target);
    n += 1;
  }
  return n;
}

if (remove) {
  say('Removing oc-stacked from OpenCode');
  if (fs.existsSync(linkPath) || isLink(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
    else fs.rmSync(linkPath, { recursive: true, force: true });
    ok(`removed ${linkPath}`);
  } else warn('plugin link was not present');
  ok(`removed ${removeShipped(path.join(repo, 'agents'), agentsDir)} agent file(s) from ${agentsDir}`);
  ok(`removed ${removeShipped(path.join(repo, 'commands'), commandsDir)} command file(s) from ${commandsDir}`);
  for (const [key, dir] of Object.entries({ agents: agentsDir, commands: commandsDir })) {
    const n = removeObsolete(dir, OBSOLETE[key]);
    if (n) ok(`removed ${n} obsolete ${key} file(s) that this repo no longer ships`);
  }
  say('\nRestart OpenCode. The plugin is gone; any .stack/ folders in projects are untouched.');
  process.exit(0);
}

say(`Installing oc-stacked\n  repo:   ${repo}\n  config: ${configDir}\n`);

if (!fs.existsSync(path.join(repo, 'index.js'))) {
  say(`No index.js in ${repo}. Run this from the repository, not from a copy of the script.`);
  process.exit(1);
}

if (linkDirectory(repo, linkPath)) ok(`plugin → ${linkPath}`);
ok(`${copyDir(path.join(repo, 'agents'), agentsDir, routing)} agent file(s) → ${agentsDir}`);
reportPins();
ok(`${copyDir(path.join(repo, 'commands'), commandsDir)} command file(s) → ${commandsDir}`);
for (const [key, dir] of Object.entries({ agents: agentsDir, commands: commandsDir })) {
  const n = removeObsolete(dir, OBSOLETE[key]);
  if (n) ok(`pruned ${n} obsolete ${key} file(s) from a previous install`);
}

say(`
Done. Three things happen on next launch:

  1. OpenCode loads the package at
     ${linkPath}
  2. Fifteen skills register: stacked, stacked-soul, stacked-pls,
     stacked-lead, stacked-employee, stacked-audit, stacked-plan,
     stacked-swarm, stacked-debug, stacked-tdd, stacked-review,
     stacked-ship, stacked-deepen, stacked-wizard, stacked-oftb
  3. Twenty-four agents appear: lead, auditor, and twenty-two archetypes
     across seven departments, pinned by routing.json

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

