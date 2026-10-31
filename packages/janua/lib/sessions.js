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
import { basename } from 'node:path';
import { spawn as spawnPty } from '@lydell/node-pty';
import { OutputRing } from './ring.js';
import { stripAnsi } from './ansi.js';
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

function envInt(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function assertDescription(description) {
  const words = typeof description === 'string'
    ? description.trim().split(/\s+/).filter(Boolean)
    : [];
  if (words.length < 5 || words.length > 10) {
    throw invalidArgs(
      `description must be 5-10 words saying what the session is for, got ${words.length}`,
    );
  }
  return description.trim();
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
    const description = assertDescription(input.description);
    const cwd = resolveCwd(input.cwd);
    const cols = input.cols ?? DEFAULT_COLS;
    const rows = input.rows ?? DEFAULT_ROWS;

    this.#purgeExited();
    if (this.#sessions.size >= this.#maxSessions) {
      throw new JanuaError(
        ERROR_CODES.TOO_MANY_SESSIONS,
        `session limit reached (${this.#maxSessions}); kill a session with pty_kill before spawning another`,
      );
    }

    const title = (typeof input.title === 'string' && input.title.trim()) || basename(command) || command;
    const env = { ...process.env, ...(input.env ?? {}) };
    const sessionId = randomUUID();

    let term;
    try {
      term = spawnPty(command, args, { cols, rows, cwd, env });
    } catch (err) {
      throw new JanuaError(
        ERROR_CODES.SPAWN_FAILED,
        `could not start ${command}: ${describeCause(err)}`,
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

    const deadline = Date.now() + waitMs;
    while (session.ring.total <= requested && !session.exited && Date.now() < deadline) {
      await waitForChange(session, deadline - Date.now());
    }

    const slice = session.ring.read(requested, maxBytes);
    const text = slice.data.toString('utf8');
    return {
      data: options.stripAnsi === false ? text : stripAnsi(text),
      cursor: slice.end,
      exited: session.exited,
      exitCode: session.exitCode,
      dropped: slice.dropped,
    };
  }

  kill(sessionId, signal = 'SIGTERM') {
    const session = this.#get(sessionId);
    if (session.exited) return { ok: true };
    try {
      terminate(session.term, signal);
    } catch (err) {
      throw new JanuaError(
        ERROR_CODES.INTERNAL,
        `kill of session ${sessionId} failed: ${describeCause(err)}`,
      );
    }
    return { ok: true };
  }

  list() {
    return [...this.#sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      pid: session.pid,
      title: session.title,
      command: session.command,
      exited: session.exited,
      exitCode: session.exitCode,
      bytes: session.ring.total,
      createdAt: session.createdAt,
    }));
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
