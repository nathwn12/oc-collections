// One place that starts a process, so the behaviour is knowable.
//
// `shell: true` on Windows makes Node allocate a console for cmd.exe, and the
// console is what a user sees flash. Every call here instead starts the program
// directly with windowsHide, and only a command that genuinely needs a shell
// gets an explicit `cmd.exe /d /s /c` child, still hidden.
import { spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';
const TRACE = process.env.OC_STACKED_TRACE === '1';

function trace(kind, file, args) {
  if (!TRACE) return;
  process.stderr.write(`[oc-stacked] spawn ${kind} ${file} ${args.join(' ').slice(0, 120)}\n`);
}

/** A single process, no shell, no window, output captured. */
export function run(file, args = [], { cwd, timeout = 20000, env, input } = {}) {
  const started = Date.now();
  trace('direct', file, args);
  const result = spawnSync(file, args, {
    cwd,
    timeout,
    encoding: 'utf8',
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env || process.env,
    maxBuffer: 32 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  return finish(result, started);
}

/**
 * A command string that needs shell syntax (pipes, &&, .cmd shims). We call the
 * shell ourselves rather than letting Node do it, so windowsHide is applied to
 * the process we actually created.
 */
export function shell(command, { cwd, timeout = 180000, env } = {}) {
  const started = Date.now();
  trace('shell', WIN ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', [command]);
  const [file, args] = WIN
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command]]
    : ['/bin/sh', ['-c', command]];
  const result = spawnSync(file, args, {
    cwd,
    timeout,
    encoding: 'utf8',
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env || process.env,
    windowsVerbatimArguments: WIN,
    maxBuffer: 32 * 1024 * 1024,
  });
  return finish(result, started);
}

function finish(result, started) {
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const out = `${result.stdout || ''}${result.stderr || ''}`.replace(/\s+$/, '');
  return {
    ok: !timedOut && result.status === 0,
    code: timedOut ? 'timeout' : result.status,
    out,
    err: result.error ? String(result.error.message || result.error) : '',
    ms: Date.now() - started,
  };
}

/** Does this command need a shell even when we start it ourselves? */
export function needsShell(command) {
  if (/[|&<>]/.test(command)) return true;
  const first = command.trim().split(/\s+/)[0] || '';
  return WIN && /\.(cmd|bat)$/i.test(first);
}

/**
 * Split a command line into program and argv, honouring single and double
 * quotes. Good enough for the commands a check declares, and it means the
 * common case never touches cmd.exe at all.
 */
export function parse(command) {
  const out = [];
  let current = '';
  let quote = null;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * The right way to start a declared command: directly when it is a plain
 * program and arguments, through the shell only when the syntax needs one or
 * the program is a `.cmd` shim. `npm test` needs cmd.exe; `node -e "..."`,
 * `go test ./...` and `python -m pytest` do not.
 */
export function command(line, opts = {}) {
  if (!needsShell(line)) {
    const [file, ...args] = parse(line);
    if (file) {
      const result = run(file, args, opts);
      if (result.code !== 'ENOENT' && !/ENOENT/.test(result.err)) return result;
    }
  }
  return shell(line, opts);
}
