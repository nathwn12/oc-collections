// One place that starts a process, so the behaviour is knowable.
//
// `shell: true` on Windows makes Node allocate a console for cmd.exe, and the
// console is what a user sees flash. Every call here instead starts the program
// directly with windowsHide, and only a command that genuinely needs a shell
// gets an explicit `cmd.exe /d /s /c` child, still hidden.
//
// `run`/`shell`/`command` are synchronous because git callers need one answer
// now. Checks use the async twins so a timeout can kill the whole tree while it
// is still alive, which is what keeps a grandchild from holding a port open.
import { spawn, spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';
const TRACE = process.env.OC_STACKED_TRACE === '1';
const MAX_BUFFER = 32 * 1024 * 1024;

function trace(kind, file, args) {
  if (!TRACE) return;
  process.stderr.write(`[oc-stacked] spawn ${kind} ${file} ${args.join(' ').slice(0, 120)}\n`);
}

/**
 * UTF-16LE without a BOM is ASCII text with a NUL in every high byte. That
 * alternating pattern is the signature; a scattered NUL is data, not an
 * encoding (git's `-z` output is NUL-separated and must keep its separators).
 */
function looksUtf16le(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.length < 2) return false;
  let pairs = 0;
  let highZeros = 0;
  for (let i = 1; i < sample.length; i += 2) {
    pairs += 1;
    if (sample[i] === 0) highZeros += 1;
  }
  return pairs > 0 && highZeros / pairs > 0.9;
}

/**
 * Decode a child's output honestly. UTF-16LE is NUL-heavy ASCII, and a UTF-8
 * decode turns it into NUL-separated noise, so the UTF-16 fallbacks strip those
 * NULs. A NUL in UTF-8 output is real data: `git status -z` uses it as the
 * record separator, and dropping it glues every path together.
 */
function decode(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '', 'utf8');
  if (!buf.length) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le').replace(/\u0000/g, '');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le').replace(/\u0000/g, '');
  }
  return looksUtf16le(buf) ? buf.toString('utf16le').replace(/\u0000/g, '') : buf.toString('utf8');
}

function evidence(stdout, stderr, { status, timedOut, overflow, started, error }) {
  // Each stream is decoded on its own. Concatenating them first puts every
  // stderr byte after the trailing NUL of a `git status -z` stream, where a
  // parser reads it as one more path: a git warning would turn a clean tree
  // dirty. `display` is the two streams joined, for a human reading a failed
  // check; it is never parsed.
  const out = decode(stdout).replace(/\s+$/, '');
  const err = decode(stderr).replace(/\s+$/, '');
  const text = `${out}${err}`.replace(/\s+$/, '');
  return {
    ok: !timedOut && !overflow && status === 0,
    status: status ?? null,
    code: timedOut ? 'timeout' : overflow ? 'ENOBUFS' : status,
    out,
    err,
    display: overflow ? `${text}\n[output truncated after ${MAX_BUFFER} bytes]` : text,
    startError: error ? String(error.message || error) : '',
    ms: Date.now() - started,
    truncated: overflow,
    timedOut,
  };
}

/** Kill a process and everything it started. The parent must be alive to do it. */
function killTree(pid) {
  if (!pid) return;
  try {
    if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'buffer' });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone, or no permission: the exit code still tells the truth */
  }
}

/** A single process, no shell, no window, output captured. */
export function run(file, args = [], { cwd, timeout = 20000, env, input } = {}) {
  const started = Date.now();
  trace('direct', file, args);
  const result = spawnSync(file, args, {
    cwd,
    timeout,
    encoding: 'buffer',
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env || process.env,
    maxBuffer: MAX_BUFFER,
    ...(input !== undefined ? { input } : {}),
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (timedOut && WIN) killTree(result.pid);
  return evidence(result.stdout, result.stderr, {
    status: result.status,
    timedOut,
    overflow: result.error?.code === 'ENOBUFS',
    started,
    error: result.error,
  });
}

/**
 * A command string that needs shell syntax (pipes, &&, .cmd shims). We call the
 * shell ourselves rather than letting Node do it, so windowsHide is applied to
 * the process we actually created.
 */
export function shell(command, { cwd, timeout = 180000, env } = {}) {
  const started = Date.now();
  const file = WIN ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  // cmd /s strips the first and last quote of its tail. One extra pair keeps the
  // command's own quotes, and its `&`/`>` characters, intact.
  const args = WIN ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command];
  trace('shell', file, [command]);
  const result = spawnSync(file, args, {
    cwd,
    timeout,
    encoding: 'buffer',
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env || process.env,
    windowsVerbatimArguments: WIN,
    maxBuffer: MAX_BUFFER,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (timedOut && WIN) killTree(result.pid);
  return evidence(result.stdout, result.stderr, {
    status: result.status,
    timedOut,
    overflow: result.error?.code === 'ENOBUFS',
    started,
    error: result.error,
  });
}

/** The async twin of run(): the child stays alive long enough to kill its tree. */
export function runAsync(file, args = [], { cwd, timeout = 20000, env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    trace('spawn', file, args);
    const child = spawn(file, args, {
      cwd,
      env: env || process.env,
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    collect(child, started, timeout, resolve);
  });
}

/** The async twin of shell(). */
export function shellAsync(command, { cwd, timeout = 180000, env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const file = WIN ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const args = WIN ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command];
    trace('spawn-shell', file, [command]);
    const child = spawn(file, args, {
      cwd,
      env: env || process.env,
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: WIN,
    });
    collect(child, started, timeout, resolve);
  });
}

function collect(child, started, timeout, resolve) {
  const stdout = [];
  const stderr = [];
  let size = 0;
  let timedOut = false;
  let overflow = false;
  let settled = false;
  let error = null;

  const stop = () => killTree(child.pid);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeout);

  const sink = (chunks) => (chunk) => {
    if (overflow) return;
    size += chunk.length;
    if (size > MAX_BUFFER) {
      overflow = true;
      stop();
      return;
    }
    chunks.push(chunk);
  };

  child.stdout?.on('data', sink(stdout));
  child.stderr?.on('data', sink(stderr));
  child.on('error', (err) => {
    error = err;
  });
  child.on('close', (status) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(
      evidence(Buffer.concat(stdout), Buffer.concat(stderr), {
        status,
        timedOut,
        overflow,
        started,
        error,
      }),
    );
  });
}

function firstToken(line) {
  const text = String(line).trim();
  if (!text) return '';
  if (text[0] !== '"') return text.split(/\s+/)[0] || '';
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
      out += text[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  return out;
}

/** Does this command need a shell even when we start it ourselves? */
export function needsShell(line) {
  if (/[|&<>]/.test(line)) return true;
  // %VAR% is cmd's expansion, not the child's. Only cmd can expand it.
  if (/%[^%\s]+%/.test(line)) return true;
  const first = firstToken(line);
  return WIN && /\.(cmd|bat)$/i.test(first);
}

/**
 * Split a command line into program and argv. Double quotes group and accept
 * `\"` and `\\`; `""` is a real, empty argument; an unbalanced quote throws so
 * the caller refuses instead of running a guess. A single quote is only a quote
 * where a POSIX shell would treat it as one; on Windows `don't` is one token.
 */
export function parse(line) {
  const text = String(line);
  const out = [];
  let current = '';
  let started = false;
  let quote = null;
  const singleQuotes = !WIN;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote === '"') {
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i += 1;
          continue;
        }
        current += ch;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (ch === '"') {
      quote = '"';
      started = true;
      continue;
    }
    if (singleQuotes && ch === "'") {
      quote = "'";
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote) throw new Error(`unterminated ${quote === '"' ? 'double' : 'single'} quote in: ${text}`);
  if (started) out.push(current);
  return out;
}

function badCommand(err) {
  const message = err?.message || String(err);
  return {
    ok: false,
    status: null,
    code: 'parse',
    out: `${message}\n`,
    err: message,
    display: `${message}\n`,
    startError: message,
    ms: 0,
    truncated: false,
    timedOut: false,
  };
}

/** A direct spawn failed before the program ran: the shell may still know it. */
function failedToStart(result) {
  return result.status === null && /ENOENT|EINVAL|ENOEXEC/.test(result.startError);
}

/**
 * The right way to start a declared command: directly when it is a plain
 * program and arguments, through the shell only when the syntax needs one or
 * the program is a `.cmd` shim. `npm test` needs cmd.exe; `node -e "..."`,
 * `go test ./...` and `python -m pytest` do not.
 */
export function command(line, opts = {}) {
  if (!needsShell(line)) {
    let parts;
    try {
      parts = parse(line);
    } catch (err) {
      return badCommand(err);
    }
    const [file, ...args] = parts;
    if (file) {
      const result = run(file, args, opts);
      if (!failedToStart(result)) return result;
    }
  }
  return shell(line, opts);
}

/** command() for callers that can await: a timeout kills the whole tree. */
export async function commandAsync(line, opts = {}) {
  if (!needsShell(line)) {
    let parts;
    try {
      parts = parse(line);
    } catch (err) {
      return badCommand(err);
    }
    const [file, ...args] = parts;
    if (file) {
      const result = await runAsync(file, args, opts);
      if (!failedToStart(result)) return result;
    }
  }
  return shellAsync(line, opts);
}
