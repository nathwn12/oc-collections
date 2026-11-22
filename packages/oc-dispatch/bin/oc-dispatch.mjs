#!/usr/bin/env node
// oc-dispatch — the offline CLI.
//
// Four verbs, no running server: `status` reads the policy, `off` writes mode
// off into routing.json with a backup, `init` previews or applies the plugin
// entry and depth through the same setup seam the plugin uses, and `doctor`
// reports config precedence and the depth that won. Every IO seam is injectable
// so the pure part of each verb is tested without touching a real config.
import {
  copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configDir, snapshot } from '../src/config.mjs';
import { loadPolicy, TIERS, validate } from '../src/policy.mjs';
import { apply as applySetup, preview as previewSetup } from '../src/setup.mjs';

export const INSTALL = 'github:nathwn12/oc-collections#main::path:packages/oc-dispatch';
const ROUTING = fileURLToPath(new URL('../routing.json', import.meta.url));

/** Replace only the mode value, leaving comments and every other key intact. */
export function offPolicy(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'config-not-object' };
    const changed = String(text).replace(/("mode"\s*:\s*)"[^"]*"/, '$1"off"');
    const verdict = loadPolicy(changed);
    if (verdict.errors.length > 0) return { ok: false, reason: verdict.errors[0] };
    return { ok: true, text: changed };
  } catch {
    return { ok: false, reason: 'routing-invalid' };
  }
}

function backupWrite(target, text, io) {
  const backup = `${target}.bak`;
  const temp = `${target}.tmp-${process.pid}`;
  try {
    if (!io.exists(backup)) io.copy(target, backup);
  } catch {
    return { ok: false, reason: 'backup-failed' };
  }
  try {
    io.write(temp, text);
    io.rename(temp, target);
    return { ok: true, backup };
  } catch {
    try {
      io.write(target, text);
    } catch {
      return { ok: false, reason: 'rollback-failed' };
    }
    try {
      io.remove(temp);
    } catch {
      /* a stray temp beside a restored target is harmless */
    }
    return { ok: false, reason: 'write-rolled-back' };
  }
}

export async function main(argv = [], deps = {}) {
  const [verb, ...flags] = argv;
  const env = deps.env ?? {};
  const home = deps.home ?? homedir();
  const read = deps.read ?? ((p) => readFileSync(p, 'utf8'));
  const io = {
    read,
    write: deps.write ?? ((p, d) => writeFileSync(p, d)),
    rename: deps.rename ?? renameSync,
    copy: deps.copy ?? copyFileSync,
    exists: deps.exists ?? existsSync,
    remove: deps.remove ?? unlinkSync,
  };
  const routingPath = deps.routingPath ?? ROUTING;
  const configPath = deps.configPath ?? join(configDir(env, home), 'opencode.jsonc');
  const banked = Array.isArray(deps.banked) ? deps.banked : [];
  const lines = [];
  const say = (line) => lines.push(String(line));
  const finish = (code, data = {}) => ({ code, data, text: lines.length ? lines.join('\n') + '\n' : '' });

  try {
    if (verb === 'status') {
      const loaded = loadPolicy(read(routingPath));
      const policy = loaded.policy;
      const data = {
        mode: policy.mode,
        tiers: TIERS.filter((t) => policy.tiers?.[t]),
        banked,
        catalogCachePath: policy.caps?.catalogCachePath ?? env.OC_DISPATCH_CATALOG_CACHE ?? null,
      };
      say(`mode: ${data.mode}`);
      say(`tiers: ${data.tiers.join(', ')}`);
      say(`banked: ${data.banked.length ? data.banked.join(', ') : 'none'}`);
      say(`catalog cache: ${data.catalogCachePath ?? 'none'}`);
      return finish(0, data);
    }

    if (verb === 'off') {
      const changed = offPolicy(read(routingPath));
      if (!changed.ok) {
        say(`off failed: ${changed.reason}`);
        return finish(1, { reason: changed.reason });
      }
      const written = backupWrite(routingPath, changed.text, io);
      if (!written.ok) {
        say(`off failed: ${written.reason}`);
        return finish(1, written);
      }
      say('mode: off');
      say(`backup: ${written.backup}`);
      return finish(0, { mode: 'off', backup: written.backup });
    }

    if (verb === 'init') {
      const view = snapshot({ env, home, read });
      const depth = view.effectiveDepth ?? 1;
      const planned = previewSetup({ target: configPath, entry: INSTALL, depth, read });
      if (!planned.ok) {
        say(`init failed: ${planned.reason}`);
        return finish(1, { reason: planned.reason });
      }
      say(`target: ${configPath}`);
      say(`entry: ${INSTALL}`);
      say(`depth: ${depth}`);
      if (flags.includes('--dry-run')) {
        say('dry run: no file written');
        return finish(0, { ...planned, dryRun: true });
      }
      if (!flags.includes('--yes')) {
        say('not applied; pass --yes to write');
        return finish(0, { ...planned, applied: false });
      }
      const applied = applySetup({ target: configPath, entry: INSTALL, depth, read, env, ...io });
      say(applied.ok ? `applied: ${applied.path}` : `init failed: ${applied.reason}`);
      return finish(applied.ok ? 0 : 1, applied);
    }

    if (verb === 'doctor') {
      const view = snapshot({ env, home, read });
      const loaded = loadPolicy(read(routingPath));
      const verdict = validate(loaded.policy);
      const data = { ...view, policyOk: verdict.ok, errors: verdict.errors };
      say(`sources: ${view.sources.join(' > ') || 'none'}`);
      say(`winner: ${view.winner ?? 'none'}`);
      say(`depth: ${view.effectiveDepth ?? 'none'}`);
      say(`policy: ${verdict.ok ? 'valid' : verdict.errors[0]}`);
      const bad = !verdict.ok || view.winner === null;
      if (flags.includes('--check') && bad) return finish(1, data);
      return finish(0, data);
    }

    say(`unknown verb: ${verb ?? '(none)'}`);
    say('usage: oc-dispatch status | off | init [--dry-run|--yes] | doctor [--check]');
    return finish(2);
  } catch (err) {
    say(`error: ${String(err?.message ?? err)}`);
    return finish(1, { error: String(err?.message ?? err) });
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = await main(process.argv.slice(2));
  process.stdout.write(result.text);
  process.exitCode = result.code;
}
