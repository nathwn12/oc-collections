// Session registry: one PTY per session id, with a bounded output ring.
//
// Deliberate properties:
//   - a session outlives its child: after exit it stays listed and readable so
//     the exit code and the tail of its output can still be collected;
//   - the cap counts every known session, but exited sessions are purged first,
//     so a long-lived server is not wedged by history;
//   - a session can carry a name, and every lookup accepts either the id or the
//     name, so a caller can keep a stable handle instead of a UUID;
//   - `run` drives one fresh PTY to completion in a single call: spawn, write
//     stdin, read in short slices, stop on exit, match or timeout;
//   - nothing here throws a raw node-pty error across the boundary: spawn and
//     write failures become typed JanuaError codes.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { spawn as spawnPty } from '@lydell/node-pty';
import { OutputRing } from './ring.js';
import { stripAnsi, escapeSequenceEnd, incompleteEscapeStart } from './ansi.js';
import {
  ERROR_CODES,
  JanuaError,
  describeCause,
  invalidArgs,
  sessionNotFound,
} from './errors.js';

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
// The same bound pty_spawn's schema enforces on a terminal dimension.
export const MAX_DIMENSION = 1000;
export const DEFAULT_MAX_SESSIONS = 32;
export const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

// One-shot run bounds. timeoutMs is the whole call (spawn, stdin, read), and
// maxBytes is both the default and the ceiling of the returned data, so a run
// can never hand back more than the ring retains.
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const MAX_RUN_TIMEOUT_MS = 3_600_000;
export const MAX_RUN_BYTES = 1024 * 1024;
// A run reads in short slices so a match or a timeout is noticed promptly
// instead of after one long blocking read.
export const RUN_SLICE_MS = 250;
const RUN_READ_CHUNK = MAX_RUN_BYTES;
// How much of the already-read text a match pattern is tested against. The
// pattern must be able to span chunk boundaries; a match needing more context
// than this is beyond what any prompt or marker would ask for.
const RUN_SCAN_WINDOW = 1024 * 1024;

export const MAX_NAME_CHARS = 64;
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// maxBytes is the read's data contract, but a character or escape sequence can
// straddle its end, and a sequence can start on the window's first byte (a
// ConPTY opens every session with escape-only chunks). A read is allowed to
// reach past maxBytes only to finish that one straddling piece, never to the
// rest of the buffer, and this is how far that reach may go. A sequence that
// is still unfinished at this ceiling is returned as literal text (the whole
// overage, bounded here) and the cursor advances, rather than widening to the
// rest of the buffer. 64 KiB is far more than any terminal control sequence
// needs and small enough that a read can never hand the caller a buffered
// megabyte by accident. It is user-visible, so pty_read's description and
// docs/GUIDE.md state it too.
export const MAX_SEQUENCE_OVERAGE_BYTES = 64 * 1024;

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

function envInt(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

// Windows environment names are case-insensitive, so an override must replace
// the existing key whatever its case: otherwise the child would see two PATHs
// and the one it reads is not necessarily the one resolution searched.
function mergeEnv(extra) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (process.platform === 'win32') {
      const upper = key.toUpperCase();
      for (const existing of Object.keys(env)) {
        if (existing !== key && existing.toUpperCase() === upper) delete env[existing];
      }
    }
    env[key] = value;
  }
  return env;
}

function envValue(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

// Windows lookup is case-insensitive, so `statSync` finds `node.exe` through the
// candidate `node.EXE` and the candidate is left carrying PATHEXT's casing,
// which is not the casing the directory holds. The resolved path is reported to
// callers and compared as text, so return the name as it is on disk; a
// directory that cannot be listed falls back to the candidate, which still
// names the same file.
function onDiskName(directory, candidate) {
  const wanted = basename(candidate).toLowerCase();
  try {
    const actual = readdirSync(directory).find((entry) => entry.toLowerCase() === wanted);
    if (actual !== undefined) return join(directory, actual);
  } catch {
    // unreadable directory: the candidate names the same file
  }
  return candidate;
}

// The first file on PATH that answers to `command`, in PATHEXT order, the way
// cmd.exe finds it. A name that already carries a PATHEXT extension is looked
// up as-is; anything else gets each extension appended in turn.
function findOnPath(command, env) {
  const pathValue = envValue(env, 'PATH');
  if (!pathValue) return null;
  const extensions = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT)
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const lower = command.toLowerCase();
  const suffixes = extensions.some((entry) => lower.endsWith(entry.toLowerCase()))
    ? ['']
    : extensions;
  for (const entry of pathValue.split(';')) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${command}${suffix}`);
      try {
        if (statSync(candidate).isFile()) return onDiskName(directory, candidate);
      } catch {
        // not here, try the next extension or directory
      }
    }
  }
  return null;
}

// One argument as cmd.exe reads it on a /c line: quoted when it holds anything
// the line would otherwise split or interpret, with an embedded `"` doubled.
function quoteForCmd(value) {
  const text = String(value);
  if (text === '') return '""';
  if (!/[\s"&|<>^()]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Turn a tool's command and args into what node-pty is handed.
 *
 * POSIX passes through untouched. On Windows a bare name is resolved against
 * PATH x PATHEXT, because CreateProcess does not consult PATHEXT: `npm`,
 * `npx`, `pnpm`, `yarn` and `tsc` are .cmd batch shims, and CreateProcess
 * fails on them with error code 2. A batch shim runs through `cmd /d /s /c`
 * with the whole line passed as node-pty's pre-escaped CommandLine string, so
 * node-pty does not re-escape the quotes with backslashes that cmd does not
 * understand. An .exe/.com resolves to its absolute path and runs directly.
 *
 * `^` is refused on the batch path: cmd consumes it even inside quotes, so an
 * argument carrying one cannot be passed through a shim intact.
 */
export function resolveSpawn(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const direct = { file: command, args, viaShell: false, resolved: null };
  if (platform !== 'win32') return direct;
  if (/[\\/]/.test(command)) return direct;

  const resolved = findOnPath(command, env);
  if (!resolved) return direct;
  const extension = extname(resolved).toLowerCase();
  if (!BATCH_EXTENSIONS.has(extension)) {
    return { file: resolved, args, viaShell: false, resolved };
  }

  if (args.some((arg) => arg.includes('^'))) {
    throw invalidArgs(
      `${command} is a batch shim and an argument contains "^", which cmd consumes even inside quotes; `
      + 'run it through a cmd.exe session instead',
    );
  }
  const comspec = envValue(env, 'COMSPEC') || 'cmd.exe';
  const line = [quoteForCmd(resolved), ...args.map(quoteForCmd)].join(' ');
  return {
    // The outer pair is the one cmd /s strips; what is left is the quoted
    // command and its quoted arguments, exactly as a shell would have built it.
    file: comspec,
    args: `/d /s /c "${line}"`,
    viaShell: true,
    resolved,
  };
}

export const MAX_DESCRIPTION_CHARS = 200;
export const KILL_TIMEOUT_MS = 2000;
const KILL_POLL_MS = 50;

// A description is a memory aid for a later reader, not a gate: it is optional,
// defaults to the session title, and only the upper bound is enforced. The
// "5-10 words" guidance lives in the tool schema, where advice belongs.
function resolveDescription(description, fallback) {
  if (description === undefined || description === null) return fallback;
  if (typeof description !== 'string') throw invalidArgs('description must be a string');
  const text = description.trim();
  if (text === '') throw invalidArgs('description must not be empty when given; omit it to use the title');
  if (text.length > MAX_DESCRIPTION_CHARS) {
    throw invalidArgs(
      `description must be at most ${MAX_DESCRIPTION_CHARS} characters, got ${text.length}`,
    );
  }
  return text;
}

function resolveCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === '') return process.cwd();
  if (typeof cwd !== 'string') throw invalidArgs('cwd must be a string');
  let stats;
  try {
    stats = statSync(cwd);
  } catch {
    throw invalidArgs(`cwd does not exist: ${cwd}`);
  }
  if (!stats.isDirectory()) throw invalidArgs(`cwd is not a directory: ${cwd}`);
  return cwd;
}

// A session name is a stable handle a caller can remember: a letter or digit
// first, then letters, digits, dot, underscore and dash, 1..64 characters.
export function resolveName(name) {
  if (name === undefined || name === null) return null;
  if (typeof name !== 'string') throw invalidArgs('name must be a string');
  if (!NAME_PATTERN.test(name)) {
    throw invalidArgs(
      `name must be 1-${MAX_NAME_CHARS} characters matching ${NAME_PATTERN.source}`
      + ` (a letter or digit first, then letters, digits, ".", "_" or "-"), got ${describeCause(name)}`,
    );
  }
  return name;
}

function boolOption(name, value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidArgs(`${name} must be a boolean`);
  return value;
}

function resolveRunTimeout(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return DEFAULT_RUN_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RUN_TIMEOUT_MS) {
    throw invalidArgs(
      `timeoutMs must be an integer between 1 and ${MAX_RUN_TIMEOUT_MS}, got ${describeCause(timeoutMs)}`,
    );
  }
  return timeoutMs;
}

function resolveRunMaxBytes(maxBytes) {
  if (maxBytes === undefined || maxBytes === null) return MAX_RUN_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RUN_BYTES) {
    throw invalidArgs(
      `maxBytes must be an integer between 1 and ${MAX_RUN_BYTES}, got ${describeCause(maxBytes)}`,
    );
  }
  return maxBytes;
}

// shell:true means the caller already wrote a command line, so args must be
// empty. POSIX gets /bin/sh -c; Windows gets cmd /d /s /c with the line passed
// as one pre-escaped CommandLine string, the same way a batch shim is started,
// because node-pty would otherwise backslash-escape the embedded quotes.
function shellPlan(command, env) {
  if (process.platform !== 'win32') {
    return { file: '/bin/sh', args: ['-c', command], viaShell: false, resolved: null };
  }
  const comspec = envValue(env, 'COMSPEC') || 'cmd.exe';
  return {
    file: comspec,
    args: `/d /s /c "${command}"`,
    viaShell: true,
    resolved: null,
  };
}

// The longest prefix of `text` whose UTF-8 encoding fits in maxBytes, cut on a
// character boundary. The ring already hands back whole characters; this is
// for the one cut run's own maxBytes makes, so a capped reply never ends in
// U+FFFD.
function takeUtf8Prefix(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

// Keep a bounded tail of the run's output for pattern matching, so a very
// chatty command cannot grow the matcher's memory without limit.
function appendScanWindow(scan, text) {
  if (text === '') return scan;
  const next = scan + text;
  return next.length > RUN_SCAN_WINDOW ? next.slice(-RUN_SCAN_WINDOW) : next;
}

// A resize dimension: an omitted one keeps the size in force, so a caller that
// only widens a TUI does not have to restate its height. Anything given must be
// the same 1..1000 integer pty_spawn's schema accepts.
function resolveDimension(name, given, current) {
  if (given === undefined || given === null) return current;
  if (!Number.isInteger(given) || given < 1 || given > MAX_DIMENSION) {
    throw invalidArgs(`${name} must be an integer between 1 and ${MAX_DIMENSION}, got ${describeCause(given)}`);
  }
  return given;
}

// node-pty keeps a worker thread draining the ConPTY console socket after the
// child exits, which pins the Node event loop open. Disposing it (a private
// field, guarded) is what lets a short-lived process or a test runner exit
// once its sessions are gone. Failure here is not fatal: the session is already
// finished, so it is swallowed.
function releasePtyInternals(term) {
  const worker = term?._agent?._conoutSocketWorker;
  if (worker && typeof worker.dispose === 'function') {
    try {
      worker.dispose();
    } catch {
      // already gone
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminate(term, signal) {
  // node-pty throws "Signals not supported on windows." when a signal argument
  // is passed, so Windows is always killed the only way it supports.
  if (process.platform === 'win32') {
    // Killing a child that already died makes node-pty fork its console-list
    // helper, which fails to attach and prints noise on stderr while holding a
    // 5 s timer. The native exit callback still arrives on its own, so a dead
    // pid is left alone.
    if (!isProcessAlive(term.pid)) return;
    // taskkill /T ends the whole tree in one step; node-pty's own Windows kill
    // enumerates console processes through that helper and, from a process with
    // piped stdio (every MCP server), waits out its 5 s timeout first. The PTY
    // exit event still fires from the native callback, so node-pty's kill stays
    // as a fallback for anything taskkill refuses.
    const result = spawnSync('taskkill', ['/pid', String(term.pid), '/T', '/F'], { encoding: 'utf8' });
    if (result.status === 0) return;
    // A pid that is already gone still looks alive to process.kill(pid, 0)
    // while ConPTY holds its handle. That is the one failure that must not fall
    // through: node-pty's own kill would fork its helper and print an
    // AttachConsole error for a child whose exit event is already on its way.
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase();
    if (output.includes('not found') || output.includes('not running')) return;
    term.kill();
    return;
  }
  term.kill(signal ?? 'SIGTERM');
}

export const MAX_MATCH_PATTERN = 200;

// A poll, not a busy wait: the event loop must stay free for the PTY's own exit
// callback while the kill is being confirmed.
async function waitForGone(isGone, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isGone()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }
}

// A match pattern is a regular expression source, compiled once per read so a
// bad one is a typed invalid_args naming the problem, never a SyntaxError
// escaping across the tool boundary.
function compileMatch(match) {
  if (match === undefined || match === null) return null;
  if (typeof match !== 'string') {
    throw invalidArgs('match must be a string holding a regular expression');
  }
  if (match === '') throw invalidArgs('match must not be empty');
  if (match.length > MAX_MATCH_PATTERN) {
    throw invalidArgs(`match must be at most ${MAX_MATCH_PATTERN} characters, got ${match.length}`);
  }
  try {
    return new RegExp(match);
  } catch (err) {
    throw invalidArgs(`match is not a valid regular expression: ${describeCause(err)}`);
  }
}

// A resize requested before the terminal reports ready is held on the session
// rather than handed to node-pty: on Windows node-pty queues it and replays it
// from inside its own socket callback, where a child that exited in the meantime
// throws with nothing above it to catch, which would take the whole server down.
// Replaying it here can only ever fail quietly, because there is no caller left
// to answer and a child that has gone has no terminal to resize.
function flushResize(session) {
  const pending = session.pendingResize;
  session.pendingResize = null;
  if (!pending || session.exited) return;
  try {
    session.term.resize(pending.cols, pending.rows);
  } catch {
    // the child went away between the queue and its first byte
  }
}

function waitForChange(session, ms) {
  return new Promise((resolve) => {
    const done = () => {
      session.waiters.delete(done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    session.waiters.add(done);
  });
}

export class SessionManager {
  #sessions = new Map();
  #maxSessions;
  #maxBufferBytes;

  constructor(options = {}) {
    this.#maxSessions = options.maxSessions ?? envInt('JANUA_MAX_SESSIONS', DEFAULT_MAX_SESSIONS);
    this.#maxBufferBytes = options.maxBufferBytes
      ?? envInt('JANUA_MAX_BUFFER_BYTES', DEFAULT_MAX_BUFFER_BYTES);
  }

  get maxSessions() {
    return this.#maxSessions;
  }

  get maxBufferBytes() {
    return this.#maxBufferBytes;
  }

  spawn(input = {}) {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) throw invalidArgs('command must be a non-empty string');
    if (input.args !== undefined && !Array.isArray(input.args)) {
      throw invalidArgs('args must be an array of strings');
    }
    const args = (input.args ?? []).map((arg) => String(arg));
    const cwd = resolveCwd(input.cwd);
    const name = resolveName(input.name);
    const reuse = boolOption('reuse', input.reuse) !== false;
    let stale = null;

    if (name !== null) {
      const existing = this.#byName(name);
      if (existing) {
        if (!existing.exited) {
          if (!reuse) {
            throw invalidArgs(
              `name_taken: "${name}" is already used by live session ${existing.sessionId}; `
              + 'kill it first or omit reuse:false',
            );
          }
          // A live name is a handle to the session that already has it: a
          // caller that lost the id gets the same terminal back, not a second
          // copy of the program.
          return {
            sessionId: existing.sessionId,
            pid: existing.pid,
            title: existing.title,
            name,
            reused: true,
          };
        }
        // An exited session does not keep its name: the new session takes it,
        // and the old one stays readable under its id. The name is only
        // released once the new session exists, so a failed spawn leaves the
        // old one intact.
        stale = existing;
      }
    }

    const title = (typeof input.title === 'string' && input.title.trim()) || basename(command) || command;
    const description = resolveDescription(input.description, title);
    const session = this.#create({
      command,
      args,
      cwd,
      name,
      env: input.env,
      cols: input.cols ?? DEFAULT_COLS,
      rows: input.rows ?? DEFAULT_ROWS,
      title,
      description,
    });
    if (stale) stale.name = null;
    return {
      sessionId: session.sessionId,
      pid: session.pid,
      title: session.title,
      name: session.name,
      reused: false,
    };
  }

  // One call for a command whose output is wanted once: spawn a fresh PTY,
  // write optional stdin immediately, then read in short slices until the child
  // exits, `match` appears, or timeoutMs runs out. On match or timeout the tree
  // is killed unless keep is true, so a run never leaves a program behind by
  // accident. maxBytes caps the returned data while the loop keeps draining, so
  // `bytes` still reports everything the command produced.
  async run(input = {}) {
    const startedAt = Date.now();
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) throw invalidArgs('command must be a non-empty string');
    if (input.args !== undefined && !Array.isArray(input.args)) {
      throw invalidArgs('args must be an array of strings');
    }
    const args = (input.args ?? []).map((arg) => String(arg));
    const shell = boolOption('shell', input.shell) === true;
    if (shell && args.length > 0) {
      throw invalidArgs('with shell:true the whole command line goes in command; args must be empty');
    }
    const cwd = resolveCwd(input.cwd);
    const timeoutMs = resolveRunTimeout(input.timeoutMs);
    const maxBytes = resolveRunMaxBytes(input.maxBytes);
    const keepAnsi = boolOption('stripAnsi', input.stripAnsi) === false;
    const keep = boolOption('keep', input.keep) === true;
    if (input.stdin !== undefined && typeof input.stdin !== 'string') {
      throw invalidArgs('stdin must be a string');
    }
    const pattern = compileMatch(input.match);
    const name = resolveName(input.name);
    let stale = null;

    if (name !== null) {
      const existing = this.#byName(name);
      if (existing) {
        if (!existing.exited) {
          throw invalidArgs(
            `name_taken: "${name}" is already used by live session ${existing.sessionId}; `
            + 'run never reuses a live session, so pick another name or kill that one',
          );
        }
        stale = existing;
      }
    }

    const label = shell ? command.split(/\s+/)[0] : basename(command);
    const title = name ?? label ?? command;
    const description = `one-shot: ${label}`.slice(0, MAX_DESCRIPTION_CHARS);
    const session = this.#create({
      command,
      args,
      cwd,
      name,
      shell,
      env: input.env,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      title,
      description,
    });
    if (stale) stale.name = null;

    try {
      if (typeof input.stdin === 'string' && input.stdin !== '') {
        try {
          // No added newline: the caller decided the exact bytes, including
          // whether a prompt should see Enter.
          session.term.write(input.stdin);
        } catch (err) {
          throw new JanuaError(
            ERROR_CODES.PTY_WRITE_FAILED,
            `could not write stdin to session ${session.sessionId}: ${describeCause(err)}`,
          );
        }
      }

      const deadline = startedAt + timeoutMs;
      let cursor = session.ring.base;
      let data = '';
      let dataBytes = 0;
      let truncated = false;
      let dropped = 0;
      let scan = '';
      let matched = false;
      let timedOut = false;

      for (;;) {
        const remaining = deadline - Date.now();
        const waitMs = remaining > 0 ? Math.min(RUN_SLICE_MS, remaining) : 0;
        const reply = await this.read(session.sessionId, {
          cursor,
          maxBytes: RUN_READ_CHUNK,
          waitMs,
          stripAnsi: !keepAnsi,
        });
        cursor = reply.cursor;
        dropped += reply.dropped;
        if (reply.truncated) truncated = true;

        if (reply.data !== '') {
          if (pattern !== null) scan = appendScanWindow(scan, reply.data);
          const produced = Buffer.byteLength(reply.data, 'utf8');
          if (dataBytes < maxBytes) {
            const room = maxBytes - dataBytes;
            const piece = produced <= room ? reply.data : takeUtf8Prefix(reply.data, room);
            data += piece;
            dataBytes += Buffer.byteLength(piece, 'utf8');
            if (piece.length !== reply.data.length) truncated = true;
          } else {
            truncated = true;
          }
        }

        if (pattern !== null && pattern.test(scan)) {
          matched = true;
          break;
        }
        if (reply.exited) {
          // The child is gone: take whatever is still buffered past the
          // cursor, then return. A read that filled its chunk leaves more.
          if (cursor < session.ring.total) continue;
          break;
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
      }

      if (!keep && (matched || timedOut)) {
        // At most one answer was asked for, so nothing should keep running
        // behind a session nobody will talk to.
        await this.kill(session.sessionId);
      }

      return {
        data,
        exitCode: session.exitCode,
        timedOut,
        matched: pattern === null ? true : matched,
        sessionId: session.sessionId,
        name: session.name,
        cursor,
        dropped,
        bytes: session.ring.total,
        truncated,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (!keep) {
        try {
          await this.kill(session.sessionId);
        } catch {
          // the failure being reported is the one worth keeping
        }
      }
      throw err;
    }
  }

  // The one place that reserves a slot, starts the PTY and registers the
  // session. spawn and run differ only in what they do before and after it.
  #create(input) {
    this.#purgeExited();
    if (this.#sessions.size >= this.#maxSessions) {
      throw new JanuaError(
        ERROR_CODES.TOO_MANY_SESSIONS,
        `session limit reached (${this.#maxSessions}); kill a session with pty_kill before spawning another`,
      );
    }

    const env = mergeEnv(input.env);
    const plan = input.shell
      ? shellPlan(input.command, env)
      : resolveSpawn(input.command, input.args, { env });
    const sessionId = randomUUID();

    let term;
    try {
      term = spawnPty(plan.file, plan.args, {
        cols: input.cols,
        rows: input.rows,
        cwd: input.cwd,
        env,
      });
    } catch (err) {
      // The searched-for name is always in the message, and the resolved path
      // too when PATH turned the name into something else.
      const target = plan.resolved ? `${input.command} (resolved to ${plan.resolved})` : input.command;
      throw new JanuaError(
        ERROR_CODES.SPAWN_FAILED,
        `could not start ${target}: ${describeCause(err)}`,
      );
    }

    const session = {
      sessionId,
      term,
      pid: term.pid,
      name: input.name ?? null,
      title: input.title,
      command: input.command,
      args: input.args,
      description: input.description,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      createdAt: new Date().toISOString(),
      exited: false,
      exitCode: null,
      ring: new OutputRing(this.#maxBufferBytes),
      waiters: new Set(),
      pendingResize: null,
    };

    term.onData((chunk) => {
      // The first chunk is also what makes a Windows terminal ready for a resize,
      // so a geometry change asked for before it is applied here.
      if (session.pendingResize) flushResize(session);
      session.ring.append(chunk);
      this.#notify(session);
    });
    term.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = typeof exitCode === 'number' ? exitCode : null;
      releasePtyInternals(term);
      this.#notify(session);
    });

    this.#sessions.set(sessionId, session);
    return session;
  }

  write(sessionId, data, newline = true) {
    const session = this.#get(sessionId);
    if (typeof data !== 'string') throw invalidArgs('data must be a string');
    if (session.exited) {
      throw new JanuaError(
        ERROR_CODES.PTY_WRITE_FAILED,
        `session ${sessionId} has exited (exit code ${session.exitCode}); nothing is listening`,
      );
    }
    try {
      session.term.write(newline ? `${data}\r` : data);
    } catch (err) {
      throw new JanuaError(
        ERROR_CODES.PTY_WRITE_FAILED,
        `write to session ${sessionId} failed: ${describeCause(err)}`,
      );
    }
    return { ok: true };
  }

  // Change the geometry of a running terminal. node-pty handles both halves of
  // what a TUI needs: on POSIX it ioctls TIOCSWINSZ, which makes the kernel send
  // SIGWINCH to the foreground process group, and on Windows it resizes the
  // ConPTY pseudo console, which is what the child's console APIs then read.
  // The reply is the geometry now in force, so a resize that names only one
  // dimension still tells the caller both. A Windows terminal that has not
  // produced its first byte yet takes the size as soon as it does (flushResize).
  resize(sessionId, input = {}) {
    const session = this.#get(sessionId);
    if ((input.cols === undefined || input.cols === null)
      && (input.rows === undefined || input.rows === null)) {
      throw invalidArgs(
        `give cols, rows, or both: an omitted dimension keeps the current one, `
        + `but a resize with neither has nothing to apply (session is ${session.cols}x${session.rows})`,
      );
    }
    const cols = resolveDimension('cols', input.cols, session.cols);
    const rows = resolveDimension('rows', input.rows, session.rows);
    // Checked before the call: node-pty refuses a pty that has already exited,
    // and on Windows it raises that from inside its own queued callback, where
    // it would escape as an unhandled throw instead of a typed tool error.
    if (session.exited) {
      throw new JanuaError(
        ERROR_CODES.PTY_RESIZE_FAILED,
        `session ${sessionId} has exited (exit code ${session.exitCode}); there is no terminal left to resize`,
      );
    }
    try {
      // `_isReady` is node-pty's private Windows flag, and it is the only way to
      // tell "this runs now" from "this gets queued inside the dependency". It
      // is read as exactly false so a renamed internal can only fall back to the
      // old behaviour, never to a crash.
      if (session.term._isReady === false) {
        session.pendingResize = { cols, rows };
      } else {
        session.term.resize(cols, rows);
      }
    } catch (err) {
      throw new JanuaError(
        ERROR_CODES.PTY_RESIZE_FAILED,
        `resize of session ${sessionId} to ${cols}x${rows} failed: ${describeCause(err)}`,
      );
    }
    // Tracked rather than read back from term.cols: a resize held until the
    // terminal reports ready has not reached it yet, so the getter would still
    // show the old size while the new one is queued.
    session.cols = cols;
    session.rows = rows;
    return { ok: true, cols, rows };
  }

  async read(sessionId, options = {}) {
    const session = this.#get(sessionId);
    const maxBytes = options.maxBytes ?? 8000;
    const waitMs = Math.min(Math.max(0, options.waitMs ?? 0), 10000);
    const requested = Number.isInteger(options.cursor) ? options.cursor : session.ring.base;
    if (requested < 0) throw invalidArgs('cursor must be a non-negative byte offset');

    const pattern = compileMatch(options.match);
    const raw = options.stripAnsi === false;
    const deadline = Date.now() + waitMs;
    for (;;) {
      while (session.ring.total <= requested && !session.exited && Date.now() < deadline) {
        await waitForChange(session, deadline - Date.now());
      }

      const reply = this.#readReply(session, requested, maxBytes, raw);
      const atDeadline = Date.now() >= deadline;
      const result = {
        data: reply.data,
        cursor: reply.cursor,
        exited: session.exited,
        exitCode: session.exitCode,
        dropped: reply.dropped,
        matched: pattern === null ? true : pattern.test(reply.data),
        incomplete: reply.incomplete === true,
        truncated: reply.truncated === true,
      };

      if (pattern !== null) {
        // A pattern turns the read into a wait for the prompt itself, on the
        // same wait path: it returns when the text from the caller's cursor
        // matches, the child exits, the deadline passes, or the window is full
        // and the pattern is not in it — the caller then reads on from the
        // returned cursor, so a pattern past the window is not silently lost.
        // A tail held before an unfinished character is not a full window: its
        // remaining bytes can still complete the pattern, so keep waiting.
        const windowFull = reply.cursor < session.ring.total && !reply.incomplete;
        if (result.matched || result.exited || atDeadline || windowFull) return result;
        await waitForChange(session, deadline - Date.now());
        continue;
      }

      // A ConPTY opens with escape-only chunks (mode set, focus reporting), so
      // the bytes arrive while the visible text has not. Returning "" there
      // reads as a silent terminal, so a stripped read keeps waiting from the
      // same absolute cursor until something visible lands, the child exits, or
      // the deadline passes. It only waits when nothing is buffered past the
      // returned cursor: a reply that consumed escapes while more output is
      // already buffered lets the caller read on immediately. A raw read still
      // returns the first bytes, escapes and all.
      if (raw || result.data !== '' || (reply.cursor < session.ring.total && !reply.incomplete)
        || result.exited || atDeadline) {
        return result;
      }
      await waitForChange(session, deadline - Date.now());
    }
  }

  // One bounded reply from `from`, with escape handling:
  //   - a trailing unfinished escape sequence is never returned as text: the
  //     cursor stays on its first byte until the sequence arrives whole;
  //   - a window that is nothing but one unfinished sequence is widened only
  //     as far as that sequence needs, never to the rest of the buffer;
  //   - escape-only windows are skipped inside the same reply so a stripped
  //     read still returns visible text instead of a silent empty chunk, but
  //     the raw reach stops at maxBytes + MAX_SEQUENCE_OVERAGE_BYTES.
  // `cursor` is the absolute byte offset of the end of what it consumed.
  #readReply(session, from, maxBytes, raw) {
    const limit = Math.min(
      session.ring.total,
      from + maxBytes + MAX_SEQUENCE_OVERAGE_BYTES,
    );
    const atEnd = session.exited;
    let cursor = from;
    let data = '';
    let dropped = 0;
    let incomplete = false;
    let truncated = false;

    for (;;) {
      const room = limit - cursor;
      // A cursor past the end is clamped to the end, the way the ring reads
      // it: leaving it beyond total would make every later read wait for a
      // stream that already finished.
      if (room <= 0) {
        return { data, cursor: Math.min(cursor, session.ring.total), dropped, incomplete, truncated };
      }
      const width = Math.min(maxBytes, room);
      if (!(width >= 1)) return { data, cursor, dropped, incomplete, truncated };
      let slice = session.ring.read(cursor, width, { atEnd });
      if (cursor === from) dropped = slice.dropped;
      let text = slice.data.toString('utf8');
      let heldBack = raw ? -1 : incompleteEscapeStart(text);

      // The window fits inside one escape sequence: no data can come out of it
      // and re-reading the same window would return the same nothing. Widen to
      // the end of that one sequence, doubling the reach, and stop at the
      // ceiling. A ConPTY's opening chunk hits this on the first read of every
      // session, which is why the old widen-to-the-end handed back the buffer.
      if (!raw && heldBack === 0 && slice.end < session.ring.total) {
        let end = slice.end;
        let step = Math.max(16, end - cursor);
        while (end < limit) {
          end = Math.min(limit, end + step);
          step *= 2;
          slice = session.ring.read(cursor, end - cursor, { atEnd });
          text = slice.data.toString('utf8');
          const sequenceEnd = escapeSequenceEnd(text, 0);
          if (sequenceEnd !== -1) {
            // Cut exactly at the sequence end: bytes past it belong to the next
            // read and are not part of this one's overage.
            const width = Buffer.byteLength(text.slice(0, sequenceEnd), 'utf8');
            slice = session.ring.read(cursor, width, { atEnd });
            text = slice.data.toString('utf8');
            break;
          }
        }
        heldBack = incompleteEscapeStart(text);
      }

      if (raw) {
        return {
          data: data + text,
          cursor: slice.end,
          dropped,
          incomplete: slice.incomplete,
          truncated: slice.truncated,
        };
      }

      if (session.exited) {
        // Nothing more can arrive, so a fragment frozen here is truncated, not
        // split: flush it (the ring ends on a whole character) and advance,
        // rather than strand the cursor on bytes that will never complete. An
        // unfinished escape sequence at the very end has no final byte to
        // honour, so its bytes are dropped instead of emitted as literal ESC
        // text; a raw read (above) still returns them.
        const tail = incompleteEscapeStart(text);
        data += stripAnsi(text, { dropIncompleteTail: true });
        if (slice.truncated || tail !== -1) truncated = true;
        cursor = slice.end;
        if (data !== '' || cursor >= limit) return { data, cursor, dropped, incomplete, truncated };
        continue;
      }

      if (heldBack === -1) {
        data += stripAnsi(text);
        cursor = slice.end;
        incomplete = slice.incomplete;
        // An escape-only window carries nothing for the caller; skip it inside
        // the same reply so one read still returns visible text. The ceiling
        // caps how far that can go, and the next read resumes from the cursor.
        // A tail held before an unfinished character is not skippable: the
        // cursor cannot move past it, so return the typed condition instead.
        if (data !== '' || cursor >= limit || incomplete) {
          return { data, cursor, dropped, incomplete, truncated };
        }
        continue;
      }

      if (heldBack > 0) {
        // Return the visible text before the unfinished sequence and leave the
        // cursor on the sequence's first byte: its bytes were never returned.
        // When everything before it was escape-only, there is nothing to
        // return yet, so skip on to where the sequence starts and let the
        // widen above decode it whole.
        const visible = text.slice(0, heldBack);
        const prefix = stripAnsi(visible);
        const nextCursor = slice.start + Buffer.byteLength(visible, 'utf8');
        if (data + prefix === '' && slice.end < session.ring.total) {
          cursor = nextCursor;
          continue;
        }
        return {
          data: data + prefix,
          cursor: nextCursor,
          dropped,
          incomplete: slice.incomplete || data + prefix === '',
          truncated,
        };
      }

      // heldBack === 0 after the widen: the sequence did not finish inside the
      // ceiling. A run this long is not a control sequence a terminal would
      // honour, so flush it as text and let the cursor move rather than spin on
      // it; the reply stays bounded by maxBytes + MAX_SEQUENCE_OVERAGE_BYTES.
      // `limit < total` is what proves the ceiling, not the stream's tail, is
      // what stopped the widen: at the tail the sequence is held below.
      if (limit < session.ring.total) {
        data += stripAnsi(text);
        return { data, cursor: slice.end, dropped, incomplete, truncated };
      }

      // The buffer itself ends inside the sequence and nothing more has
      // arrived: hold the cursor at its first byte so the next read re-decodes
      // it whole. Any text skipped before it is still returned; with no text,
      // the caller waits for the tail rather than reading the same window.
      return { data, cursor, dropped, incomplete: true, truncated };
    }
  }

  async kill(sessionId, signal = 'SIGTERM') {
    const session = this.#get(sessionId);
    if (session.exited) {
      return { ok: true, exited: true, exitCode: session.exitCode, pid: session.pid };
    }
    try {
      terminate(session.term, signal);
    } catch (err) {
      throw new JanuaError(
        ERROR_CODES.INTERNAL,
        `kill of session ${sessionId} failed: ${describeCause(err)}`,
      );
    }
    // Reporting ok after asking is not the same as reporting a dead program.
    // Confirm it, and when the pid survives say so with the fallback to use.
    const gone = await waitForGone(
      () => session.exited || !isProcessAlive(session.pid),
      KILL_TIMEOUT_MS,
      KILL_POLL_MS,
    );
    if (gone) {
      return { ok: true, exited: true, exitCode: session.exitCode, pid: session.pid };
    }
    const fallback = process.platform === 'win32'
      ? `kill it yourself with taskkill /pid ${session.pid} /T /F`
      : `send SIGKILL to ${session.pid} yourself`;
    return {
      ok: false,
      exited: false,
      exitCode: null,
      pid: session.pid,
      error: `${ERROR_CODES.PTY_KILL_FAILED}: process ${session.pid} is still alive `
        + `${KILL_TIMEOUT_MS} ms after the kill request; ${fallback}, or close it from its own UI`,
    };
  }

  // Newest last, one page at a time. total counts every session known, so a
  // client can tell a full page from the end of the list; nextOffset is null on
  // the last page.
  list(options = {}) {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw invalidArgs(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw invalidArgs('offset must be an integer >= 0');
    }
    const all = [...this.#sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      name: session.name ?? null,
      pid: session.pid,
      title: session.title,
      command: session.command,
      args: [...session.args],
      cwd: session.cwd,
      // The description exists so a later read makes sense on its own; a list
      // that withheld it, the args and the geometry forced a second call to
      // recall what a session was.
      description: session.description,
      cols: session.cols,
      rows: session.rows,
      exited: session.exited,
      exitCode: session.exitCode,
      bytes: session.ring.total,
      createdAt: session.createdAt,
    }));
    const sessions = all.slice(offset, offset + limit);
    const nextOffset = offset + sessions.length < all.length ? offset + sessions.length : null;
    return { sessions, total: all.length, nextOffset };
  }

  killAll() {
    for (const session of this.#sessions.values()) {
      if (session.exited) continue;
      try {
        terminate(session.term);
      } catch {
        // shutting down: a session that refuses to die must not block the rest
      }
    }
  }

  #get(reference) {
    if (typeof reference !== 'string' || reference === '') {
      throw invalidArgs('sessionId must be a session id or a session name');
    }
    const direct = this.#sessions.get(reference);
    if (direct) return direct;
    const named = this.#byName(reference);
    if (named) return named;
    throw sessionNotFound(reference);
  }

  // Names are unique among live sessions by construction, so the first match
  // is the only one; the scan tolerates an old exited holder only to report it
  // when no live one exists.
  #byName(name) {
    for (const session of this.#sessions.values()) {
      if (session.name === name) return session;
    }
    return null;
  }

  #notify(session) {
    for (const waiter of [...session.waiters]) waiter();
  }

  #purgeExited() {
    if (this.#sessions.size < this.#maxSessions) return;
    for (const [id, session] of this.#sessions) {
      if (session.exited) this.#sessions.delete(id);
    }
  }
}
