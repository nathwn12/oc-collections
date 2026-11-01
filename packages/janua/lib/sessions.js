// Session registry: one PTY per session id, with a bounded output ring.
//
// Deliberate properties:
//   - a session outlives its child: after exit it stays listed and readable so
//     the exit code and the tail of its output can still be collected;
//   - the cap counts every known session, but exited sessions are purged first,
//     so a long-lived server is not wedged by history;
//   - nothing here throws a raw node-pty error across the boundary: spawn and
//     write failures become typed JanuaError codes.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
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
export const DEFAULT_MAX_SESSIONS = 16;
export const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

// maxBytes is the read's data contract, but a character or escape sequence can
// straddle its end, and a sequence can start on the window's first byte (a
// ConPTY opens every session with escape-only chunks). A read is allowed to
// reach past maxBytes only to finish that one straddling piece, never to the
// rest of the buffer, and this is how far that reach may go. 64 KiB is far
// more than any terminal control sequence needs and small enough that a read
// can never hand the caller a buffered megabyte by accident. It is
// user-visible, so pty_read's description and docs/GUIDE.md state it too.
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
        if (statSync(candidate).isFile()) return candidate;
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
    const cols = input.cols ?? DEFAULT_COLS;
    const rows = input.rows ?? DEFAULT_ROWS;
    const title = (typeof input.title === 'string' && input.title.trim()) || basename(command) || command;
    const description = resolveDescription(input.description, title);

    this.#purgeExited();
    if (this.#sessions.size >= this.#maxSessions) {
      throw new JanuaError(
        ERROR_CODES.TOO_MANY_SESSIONS,
        `session limit reached (${this.#maxSessions}); kill a session with pty_kill before spawning another`,
      );
    }

    const env = mergeEnv(input.env);
    const plan = resolveSpawn(command, args, { env });
    const sessionId = randomUUID();

    let term;
    try {
      term = spawnPty(plan.file, plan.args, { cols, rows, cwd, env });
    } catch (err) {
      // The searched-for name is always in the message, and the resolved path
      // too when PATH turned the name into something else.
      const target = plan.resolved ? `${command} (resolved to ${plan.resolved})` : command;
      throw new JanuaError(
        ERROR_CODES.SPAWN_FAILED,
        `could not start ${target}: ${describeCause(err)}`,
      );
    }

    const session = {
      sessionId,
      term,
      pid: term.pid,
      title,
      command,
      args,
      description,
      cwd,
      cols,
      rows,
      createdAt: new Date().toISOString(),
      exited: false,
      exitCode: null,
      ring: new OutputRing(this.#maxBufferBytes),
      waiters: new Set(),
    };

    term.onData((chunk) => {
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
    return { sessionId, pid: session.pid, title };
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
      };

      if (pattern !== null) {
        // A pattern turns the read into a wait for the prompt itself, on the
        // same wait path: it returns when the text from the caller's cursor
        // matches, the child exits, the deadline passes, or the window is full
        // and the pattern is not in it — the caller then reads on from the
        // returned cursor, so a pattern past the window is not silently lost.
        const windowFull = reply.cursor < session.ring.total;
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
    let cursor = from;
    let data = '';
    let dropped = 0;

    for (;;) {
      const room = limit - cursor;
      // A cursor past the end is clamped to the end, the way the ring reads
      // it: leaving it beyond total would make every later read wait for a
      // stream that already finished.
      if (room <= 0) return { data, cursor: Math.min(cursor, session.ring.total), dropped };
      const width = Math.min(maxBytes, room);
      if (!(width >= 1)) return { data, cursor, dropped }; // a zero-width read cannot advance
      let slice = session.ring.read(cursor, width);
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
          slice = session.ring.read(cursor, end - cursor);
          text = slice.data.toString('utf8');
          const sequenceEnd = escapeSequenceEnd(text, 0);
          if (sequenceEnd !== -1) {
            // Cut exactly at the sequence end: bytes past it belong to the next
            // read and are not part of this one's overage.
            const width = Buffer.byteLength(text.slice(0, sequenceEnd), 'utf8');
            slice = session.ring.read(cursor, width);
            text = slice.data.toString('utf8');
            break;
          }
        }
        heldBack = incompleteEscapeStart(text);
      }

      if (raw) return { data: data + text, cursor: slice.end, dropped };

      if (session.exited) {
        // Nothing more can arrive, so a fragment frozen here is truncated, not
        // split: flush it (the ring ends on a whole character) and advance,
        // rather than strand the cursor on bytes that will never complete.
        data += stripAnsi(text);
        cursor = slice.end;
        if (data !== '' || cursor >= limit) return { data, cursor, dropped };
        continue;
      }

      if (heldBack === -1) {
        data += stripAnsi(text);
        cursor = slice.end;
        // An escape-only window carries nothing for the caller; skip it inside
        // the same reply so one read still returns visible text. The ceiling
        // caps how far that can go, and the next read resumes from the cursor.
        if (data !== '' || cursor >= limit) return { data, cursor, dropped };
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
          incomplete: data + prefix === '',
        };
      }

      // heldBack === 0 after the widen: the sequence did not finish inside the
      // ceiling. A run this long is not a control sequence a terminal would
      // honour, so flush it as text and let the cursor move rather than spin on
      // it; the reply stays bounded by maxBytes + MAX_SEQUENCE_OVERAGE_BYTES.
      if (slice.end < session.ring.total) {
        data += stripAnsi(text);
        return { data, cursor: slice.end, dropped };
      }

      // The buffer itself ends inside the sequence and nothing more has
      // arrived: hold the cursor at its first byte so the next read re-decodes
      // it whole. Any text skipped before it is still returned; with no text,
      // the caller waits for the tail rather than reading the same window.
      return { data, cursor, dropped, incomplete: data === '' };
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

  #get(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) throw sessionNotFound(sessionId);
    return session;
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
