#!/usr/bin/env node
/**
 * The plugin's own proving check. No OpenCode required, no network, no deps.
 *
 * It answers one question: if a user installed this today, would the thing that
 * loads actually work? Every assertion here is a way the plugin has failed or
 * could fail silently in a host.
 *
 *   node scripts/check.mjs
 *
 * The runner owns the counters, the coloured lines, the exit code, and the
 * fixtures more than one subject needs. Each subject lives in its own module
 * beside this one and exports `register(ctx)`; this file calls them in order.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolDefinitions } from '../../lib/tools.js';

import * as agents from './agents.mjs';
import * as content from './content.mjs';
import * as state from './state.mjs';
import * as exec from './exec.mjs';
import * as git from './git.mjs';
import * as tools from './tools.mjs';
import * as gate from './gate.mjs';
import * as plugin from './plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    pass += 1;
    process.stdout.write(`  pass  ${name}${detail ? `  (${detail})` : ''}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    process.stdout.write(`  pass  ${name}${detail ? `  (${detail})` : ''}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-'));
  spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['config', 'user.email', 'check@local'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['config', 'user.name', 'check'], { cwd: dir, windowsHide: true });
  return dir;
}

function commitAll(dir, message) {
  spawnSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', message], {
    cwd: dir,
    windowsHide: true,
  });
}

/** A repo with one committed, passing check: the fixture every gate test needs. */
function configuredRepo(command = 'node -e "process.exit(0)"') {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, '.stack'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.stack', 'config.json'),
    JSON.stringify({ checks: [{ name: 'ok', command, timeout: 60000 }] }, null, 2),
  );
  commitAll(dir, 'seed config');
  return dir;
}

/** Run one tool against a repository other than the caller's own fixture. */
async function runIn(otherDir, name, input) {
  const def = toolDefinitions({ dir: otherDir }).find((t) => t.name === name);
  const result = await def.execute(input, {});
  const content = typeof result === 'string' ? result : result?.content;
  assert(typeof content === 'string' && content.length, `${name} returned no content in ${otherDir}`);
  return content;
}

process.stdout.write('\noc-stacked self-test\n\n');

const ctx = { check, checkAsync, assert, repo, tmpRepo, commitAll, configuredRepo, runIn };
await agents.register(ctx);
await content.register(ctx);
await state.register(ctx);
await exec.register(ctx);
await git.register(ctx);
await tools.register(ctx);
await gate.register(ctx);
await plugin.register(ctx);

const total = pass + failures.length;
process.stdout.write(`\n${pass}/${total} passed\n\n`);
if (failures.length) {
  process.stdout.write('Failed:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.err.message}\n`);
  process.exit(1);
}
process.stdout.write('The plugin does what it says. Install it, then restart OpenCode.\n\n');
