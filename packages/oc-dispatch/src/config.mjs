// oc-dispatch — read-only view of the host config.
//
// This module never writes. It reads each config source in a documented order
// (lowest wins first, highest last) and reports which one supplied the winning
// `experimental.subagent_depth`. The four sources, low to high: the global
// config dir, the project config, the single file named by OPENCODE_CONFIG, and
// the live config object the host hands to setup. A source that is absent or
// unreadable is skipped, not an error.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const NAMES = ['opencode.jsonc', 'opencode.json'];

// Strip line and block comments outside strings, then trailing commas.
export function stripJsonc(text) {
  const s = String(text ?? '');
  let out = '';
  let i = 0;
  let quote = '';
  let escaped = false;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function configDir(env = {}, home = homedir()) {
  const override = env.OPENCODE_CONFIG_DIR;
  if (typeof override === 'string' && override.trim() && isAbsolute(override.trim())) return override.trim();
  const xdg = env.XDG_CONFIG_HOME;
  return typeof xdg === 'string' && xdg.trim() && isAbsolute(xdg.trim())
    ? join(xdg.trim(), 'opencode')
    : join(home, '.config', 'opencode');
}

const depthOf = (obj) => {
  const d = obj && typeof obj === 'object' ? obj.experimental?.subagent_depth : undefined;
  return Number.isInteger(d) && d >= 0 ? d : null;
};

function readOne(path, read) {
  try {
    const parsed = JSON.parse(stripJsonc(read(path)));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `{ sources, effectiveDepth, winner }`. `sources` lists the sources that were
 * actually read, in precedence order; `winner` is the last one that set a valid
 * depth. No file is created, changed or deleted here.
 */
export function snapshot({ env = {}, home = homedir(), cwd = process.cwd(), ctxConfig = null, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const sources = [];
  let effectiveDepth = null;
  let winner = null;
  const consider = (name, obj) => {
    sources.push(name);
    const depth = depthOf(obj);
    if (depth !== null) {
      effectiveDepth = depth;
      winner = name;
    }
  };

  const dir = configDir(env, home);
  for (const name of NAMES) {
    const obj = readOne(join(dir, name), read);
    if (obj) {
      consider('global', obj);
      break;
    }
  }
  if (!env.OPENCODE_DISABLE_PROJECT_CONFIG) {
    for (const path of [join(cwd, '.opencode', 'opencode.jsonc'), join(cwd, 'opencode.jsonc')]) {
      const obj = readOne(path, read);
      if (obj) {
        consider('project', obj);
        break;
      }
    }
  }
  if (typeof env.OPENCODE_CONFIG === 'string' && env.OPENCODE_CONFIG.trim()) {
    const obj = readOne(env.OPENCODE_CONFIG.trim(), read);
    if (obj) consider('file', obj);
  }
  if (ctxConfig && typeof ctxConfig === 'object') consider('host', ctxConfig);

  return { sources, effectiveDepth, winner };
}
