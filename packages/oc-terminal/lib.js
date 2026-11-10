/**
 * oc-terminal - the Windows spawn guard.
 *
 * The host runs as a compiled Bun binary. A child spawned without
 * `windowsHide` gets a new console; Windows Terminal adopts it, the child
 * exits, and the dead pane stays. This module makes "hidden" the default for
 * every spawn the host process can reach, and resolves a real JavaScript
 * runtime so a plugin never spawns `opencode.exe` to run a `.mjs` file.
 *
 * Two guarantees, in order of strength:
 *
 * 1. `resolveRuntime` / `isJsRuntime` never return the compiled host binary:
 *    only `node` or `bun` may run a JavaScript file.
 * 2. `patchChildProcess` / `patchBun` default every reachable spawn to
 *    `windowsHide: true`. It is a guard for code we do not own; our own callers
 *    pass the flag explicitly as well.
 *
 * Set `OC_TERMINAL_ALLOW_VISIBLE=1` to skip the guard for one deliberate
 * diagnostic. Nothing else re-enables a visible console.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ALLOW_VISIBLE = 'OC_TERMINAL_ALLOW_VISIBLE';
const MARK = Symbol.for('oc-terminal.hidden');
const PATCHED = Symbol.for('oc-terminal.patched');

export const JS_RUNTIME = /^(node|bun)(\.exe)?$/i;

/** A real JavaScript runtime; the compiled host's `opencode.exe` is not one. */
export function isJsRuntime(file) {
  return JS_RUNTIME.test(path.basename(String(file || '')));
}

/**
 * The runtime a JavaScript file should run under. `process.execPath` is
 * `opencode.exe` inside the host, so it is accepted only when it is actually
 * node or bun. The fallback is a PATH-resolved `bun`; a missing runtime fails
 * the spawn and is reported as unknown, never as a second OpenCode.
 */
export function resolveRuntime({
  execPath = process.execPath,
  env = process.env,
  which = typeof Bun !== 'undefined' && typeof Bun.which === 'function' ? Bun.which.bind(Bun) : null,
} = {}) {
  if (isJsRuntime(execPath)) return execPath;
  const override = typeof env?.['OC_TERMINAL_RUNTIME'] === 'string' ? env.OC_TERMINAL_RUNTIME.trim() : '';
  if (override) return override;
  if (typeof which === 'function') {
    const found = which('bun') || which('node');
    if (found) return found;
  }
  return 'bun';
}

/** The one switch that permits a visible console, for a diagnosis only. */
export function visibleAllowed(env = process.env) {
  return env?.[ALLOW_VISIBLE] === '1';
}

/** `windowsHide: true` on Windows, unless the diagnostic switch is set. */
export function hiddenOptions(options = {}, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || visibleAllowed(env)) return { ...options };
  return { ...options, windowsHide: true };
}

export function spawnHidden(file, args = [], options = {}) {
  return spawn(file, args, hiddenOptions(options));
}

export function spawnSyncHidden(file, args = [], options = {}) {
  return spawnSync(file, args, hiddenOptions(options));
}

/**
 * Where the options object sits in a spawn-shaped call. `spawn`/`execFile`
 * accept an optional args array; `exec`/`execSync` do not. A callback in the
 * options slot shifts to the right when a fresh options object is inserted.
 */
function optionsIndex(args) {
  if (Array.isArray(args[1])) return 2;
  if (args[1] && typeof args[1] === 'object') return 1;
  if (args[2] && typeof args[2] === 'object') return 2;
  return 1;
}

function patchFunction(cp, name, opts) {
  const original = cp[name];
  if (typeof original !== 'function' || original[MARK]) return false;
  const wrapped = function (...args) {
    const at = optionsIndex(args);
    const current = args[at];
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      args[at] = hiddenOptions(current, opts);
    } else {
      args.splice(at, 0, hiddenOptions({}, opts));
    }
    return original.apply(this, args);
  };
  try {
    Object.defineProperty(wrapped, 'name', { value: name });
    Object.defineProperty(wrapped, MARK, { value: true });
    cp[name] = wrapped;
  } catch {
    return false;
  }
  return true;
}

/**
 * Patch the reachable `node:child_process` exports. Returns true when at least
 * one function was wrapped now, or the module was already guarded. The mark
 * lives on the wrapper functions, so a hot-reloaded plugin does not double-wrap.
 */
export function patchChildProcess(
  cp = require('node:child_process'),
  { platform = process.platform, env = process.env } = {},
) {
  if (!cp || platform !== 'win32' || visibleAllowed(env)) return false;
  let wrapped = false;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    wrapped = patchFunction(cp, name, { platform, env }) || wrapped;
  }
  try {
    cp[PATCHED] = true;
  } catch {
    /* the wrapper marks are the guard; this symbol is only a hint */
  }
  return wrapped || cp[PATCHED] === true;
}

/** Patch Bun's own spawn twins when the host exposes them. */
export function patchBun(bun = globalThis.Bun, { platform = process.platform, env = process.env } = {}) {
  if (!bun || platform !== 'win32' || visibleAllowed(env)) return false;
  let wrapped = false;
  for (const name of ['spawn', 'spawnSync']) {
    const original = bun[name];
    if (typeof original !== 'function' || original[MARK]) continue;
    const guarded = function (cmd, options) {
      if (options && typeof options === 'object' && !Array.isArray(options)) {
        return original.call(this, cmd, hiddenOptions(options, { platform, env }));
      }
      return original.call(this, cmd, hiddenOptions({}, { platform, env }));
    };
    try {
      Object.defineProperty(guarded, MARK, { value: true });
      bun[name] = guarded;
      wrapped = true;
    } catch {
      /* a frozen Bun namespace is reported as not patched, never fatal */
    }
  }
  try {
    bun[PATCHED] = true;
  } catch {
    /* see above */
  }
  return wrapped || bun[PATCHED] === true;
}

/** Install the guard for this process. Never throws. */
export function install({ cp, bun = globalThis.Bun, platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { patched: false, reason: 'not windows' };
  if (visibleAllowed(env)) return { patched: false, reason: 'visible output allowed' };
  const child = patchChildProcess(cp ?? require('node:child_process'), { platform, env });
  const bunPatched = patchBun(bun, { platform, env });
  return { patched: child || bunPatched, childProcess: child, bun: bunPatched };
}
