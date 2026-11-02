// MCP server surface: exactly seven tools.
//
// run / pty_spawn / pty_write / pty_read / pty_resize / pty_kill / pty_list.
// Every handler funnels through wrap(), so a throw becomes a typed tool error
// and never escapes into the JSON-RPC transport.

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SessionManager } from './sessions.js';
import { toolFailure, toolSuccess } from './errors.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const INSTRUCTIONS = [
  'janua runs commands once and gives you persistent interactive terminals.',
  'Use run for a command whose output you want once: it runs with pipes by default (tty: true gives it a PTY),',
  'optionally writes stdin, and returns when the command exits, the match pattern appears, or timeoutMs passes',
  '(killing the tree unless keep is true).',
  'Use pty_spawn for long-lived work you will talk to over several calls (dev servers, REPLs, anything that',
  'prompts), and give it a name to address the session by that name later. Keep the returned sessionId or name,',
  'read with pty_read using the cursor it returns so output is never duplicated, write with pty_write, resize',
  'with pty_resize when a full-screen program finds the terminal too small, and pty_kill when done. Every',
  'sessionId input also accepts a session name.',
].join(' ');

/** Wrap a handler so success is a payload and every throw is a typed tool error. */
function wrap(handler) {
  return async (args) => {
    try {
      return toolSuccess(await handler(args));
    } catch (err) {
      return toolFailure(err);
    }
  };
}

// Hints say what a tool does to the world, so a client can decide what to
// auto-approve: none of these reach the network, only pty_kill destroys state,
// and only pty_read can be repeated for the same answer.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// Output schemas mirror the payloads exactly, so structuredContent is declared
// rather than merely sent and clients can rely on the fields. v2 wants a schema
// object here, not a raw shape: a bare { field: z.string() } record is the
// deprecated form and is only auto-wrapped for inputSchema.
const SPAWN_OUTPUT = z.object({
  sessionId: z.string().describe('Session id to pass to the other tools.'),
  pid: z.number().describe('Process id of the program in the terminal.'),
  title: z.string().describe('Label shown by pty_list.'),
  name: z.string().nullable().describe('Name given at spawn, or null when the session is anonymous.'),
  reused: z.boolean().describe('True when the name already belonged to a live session and that session was returned instead of a new one.'),
});
// run is one call for one command: it returns the command's output and exit
// code, and says whether the answer came from a match or ran out of time.
const RUN_OUTPUT = z.object({
  data: z.string().describe('Output the command produced, stripped of ANSI sequences unless stripAnsi is false.'),
  exitCode: z.number().nullable().describe('Exit code once the program has exited, otherwise null.'),
  timedOut: z.boolean().describe('True when timeoutMs ran out before the program exited or match appeared.'),
  matched: z.boolean().describe('True when match was given and the output matched it, or when no match was given.'),
  sessionId: z.string().describe('Session id the command ran under; pass it or name to pty_read/pty_write/pty_kill when keep is true.'),
  name: z.string().nullable().describe('Name given at run, or null.'),
  cursor: z.number().describe('Byte offset to pass to pty_read to continue after the returned data.'),
  dropped: z.number().describe('Bytes the buffer discarded before this run could read them.'),
  bytes: z.number().describe('Total bytes the command produced, including bytes beyond maxBytes.'),
  truncated: z.boolean().describe('True when maxBytes cut the returned data, so the command produced more.'),
  durationMs: z.number().describe('Wall-clock milliseconds the whole call took.'),
});
// pty_write only carries read fields when waitMs > 0, so every one of them is
// optional: a caller that just types gets {ok}, a caller that waits gets the
// answer in the same round trip.
const WRITE_OUTPUT = z.object({
  ok: z.boolean().describe('True when the call did what it says.'),
  data: z.string().optional().describe('Output read after the write; present only when waitMs > 0.'),
  cursor: z.number().optional().describe('Byte offset to pass to the next read; present only when waitMs > 0.'),
  exited: z.boolean().optional().describe('Whether the program has exited; present only when waitMs > 0.'),
  exitCode: z.number().nullable().optional().describe('Exit code once exited, otherwise null; present only when waitMs > 0.'),
  dropped: z.number().optional().describe('Bytes the buffer discarded before this read; present only when waitMs > 0.'),
  matched: z.boolean().optional().describe('Whether the text matched `match`; present only when waitMs > 0.'),
  incomplete: z.boolean().optional().describe('True when the bytes at cursor end inside a UTF-8 character that has not fully arrived; wait and read again from the same cursor (present only when waitMs > 0).'),
  truncated: z.boolean().optional().describe('True when the child exited inside a UTF-8 character or escape sequence; its remaining bytes can never arrive (present only when waitMs > 0).'),
});
const RESIZE_OUTPUT = z.object({
  ok: z.boolean().describe('True when the size was applied.'),
  cols: z.number().describe('Terminal columns now in force.'),
  rows: z.number().describe('Terminal rows now in force.'),
});
const KILL_OUTPUT = z.object({
  ok: z.boolean().describe('True when the program is gone.'),
  exited: z.boolean().describe('Whether the process is actually gone, confirmed after the kill.'),
  exitCode: z.number().nullable().describe('Exit code once the child reported one, otherwise null.'),
  pid: z.number().describe('Process id that was terminated.'),
  error: z.string().optional().describe('Typed failure with the fallback to use; present only when ok is false.'),
});
const READ_OUTPUT = z.object({
  data: z.string().describe('Output from cursor onward.'),
  cursor: z.number().describe('Byte offset to pass to the next read.'),
  exited: z.boolean().describe('Whether the program has exited.'),
  exitCode: z.number().nullable().describe('Exit code once exited, otherwise null.'),
  dropped: z.number().describe('Bytes the buffer discarded before this read.'),
  matched: z.boolean().describe('True when match was given and the text matched, or when no match was given.'),
  incomplete: z.boolean().describe('True when the bytes at cursor end inside a UTF-8 character that has not fully arrived: read again from the same cursor once its bytes land.'),
  truncated: z.boolean().describe('True when the child exited inside a UTF-8 character or escape sequence, so its remaining bytes can never arrive.'),
});
const SESSION_SHAPE = {
  sessionId: z.string(),
  name: z.string().nullable().describe('Name given at spawn, or null.'),
  pid: z.number(),
  title: z.string(),
  command: z.string(),
  args: z.array(z.string()).describe('Arguments the program was started with.'),
  cwd: z.string().describe('Working directory the program was started in.'),
  description: z.string().describe('What the session is for, as given at spawn.'),
  cols: z.number().describe('Terminal columns (0 for a pipe session).'),
  rows: z.number().describe('Terminal rows (0 for a pipe session).'),
  pipe: z.boolean().describe('True when the session runs with pipes and has no terminal to resize.'),
  exited: z.boolean(),
  exitCode: z.number().nullable(),
  bytes: z.number(),
  createdAt: z.string(),
};
const LIST_OUTPUT = z.object({
  sessions: z.array(z.object(SESSION_SHAPE)).describe('This page, newest last.'),
  total: z.number().describe('Sessions known in total, not just this page.'),
  nextOffset: z.number().nullable().describe('Offset of the next page, or null on the last one.'),
});

export function createServer(options = {}) {
  const manager = options.manager ?? new SessionManager();
  const server = new McpServer(
    { name: 'janua', version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'run',
    {
      title: 'Run a one-shot command',
      description:
        'Run a command once and return when it exits, when match appears in its output, or when timeoutMs '
        + 'passes: {data, exitCode, timedOut, matched, sessionId, name, cursor, dropped, bytes, truncated, '
        + 'durationMs}. Runs with pipes by default, which is much faster than a PTY; tty: true gives the '
        + 'command a real terminal for an interactive program that prompts or draws a TUI. stdout and stderr '
        + 'are merged in arrival order. stdin (a string, no newline added) is written immediately. maxBytes caps '
        + 'data (default and maximum 1048576) and truncated: true means the command produced more. On match or '
        + 'timeout the process tree is killed unless keep is true; with keep the session stays addressable by '
        + 'sessionId or name for pty_read, pty_write and pty_kill. shell: true takes command as one platform '
        + 'command line (cmd.exe /d /s /c on Windows, /bin/sh -c elsewhere) and requires args to be empty. Use '
        + 'this for commands whose output you want once; use pty_spawn for long-lived work you will talk to '
        + 'over several calls.',
      inputSchema: z.object({
        command: z.string().describe('Executable to run: a name resolved on PATH, an absolute path, or — with shell: true — one command line.'),
        args: z.array(z.string()).optional().describe('Arguments for command, one array entry each. Must be empty when shell is true.'),
        cwd: z.string().optional().describe('Working directory for the command. Must exist. Defaults to the server process cwd.'),
        env: z.record(z.string(), z.string()).optional().describe('Extra environment variables, merged over the server environment.'),
        stdin: z.string().optional().describe('Text written to the command stdin immediately after spawn, with no newline added.'),
        timeoutMs: z.number().int().min(1).max(3600000).optional().describe('Give up after this many milliseconds (default 120000, max 3600000).'),
        maxBytes: z.number().int().min(1).max(1048576).optional().describe('Maximum bytes of data to return (default 1048576); the rest is drained and reported in bytes with truncated: true.'),
        stripAnsi: z.boolean().optional().describe('Remove ANSI escape sequences from data (default true).'),
        match: z.string().optional().describe('Regular expression (at most 200 characters) that ends the run early when the output matches it.'),
        shell: z.boolean().optional().describe('Run command as one platform command line through cmd.exe /d /s /c on Windows or /bin/sh -c elsewhere (default false).'),
        tty: z.boolean().optional().describe('Use a PTY for an interactive command (default false: one-shot runs use pipes and are faster).'),
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional().describe('Optional session name (1-64 characters: letter or digit first, then letters, digits, ".", "_" or "-"). A live name is refused rather than reused.'),
        keep: z.boolean().optional().describe('Leave the session running on match or timeout instead of killing the tree (default false).'),
      }),
      outputSchema: RUN_OUTPUT,
      annotations: MUTATING,
    },
    wrap(async (args) => manager.run(args)),
  );

  server.registerTool(
    'pty_spawn',
    {
      title: 'Spawn interactive terminal',
      description:
        'Start a program in a persistent pseudo-terminal and return {sessionId, pid, title, name, reused}. '
        + 'The program keeps running until pty_kill or its own exit; nothing is run through a shell, '
        + 'so command and args are passed exactly as given. On Windows a bare name is resolved through '
        + 'PATH and PATHEXT, and a .cmd/.bat shim (npm, npx, pnpm, yarn, tsc) runs through cmd /c with its '
        + 'arguments quoted. Give a name to address the session by name later; a live name returns that same '
        + 'session with reused: true unless reuse is false, which is invalid_args. Use this for anything you '
        + 'need to talk to (dev servers, REPLs, installers that prompt), not for commands whose output you want once.',
      inputSchema: z.object({
        command: z.string().describe('Executable to run: a name resolved on PATH, or an absolute path. No shell string.'),
        args: z.array(z.string()).optional().describe('Arguments for command, one array entry each.'),
        cwd: z.string().optional().describe('Working directory for the program. Must exist. Defaults to the server process cwd.'),
        env: z.record(z.string(), z.string()).optional().describe('Extra environment variables, merged over the server environment.'),
        cols: z.number().int().min(1).max(1000).optional().describe('Terminal columns (default 80).'),
        rows: z.number().int().min(1).max(1000).optional().describe('Terminal rows (default 24).'),
        title: z.string().optional().describe('Short label for this session, shown by pty_list. Defaults to the command name.'),
        description: z.string().optional().describe('What this session is for, in 5-10 words, so a later read of pty_list makes sense on its own. Optional (defaults to the title) and at most 200 characters.'),
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional().describe('Optional stable name (1-64 characters: letter or digit first, then letters, digits, ".", "_" or "-"). Every sessionId input accepts it too.'),
        reuse: z.boolean().optional().describe('When name is already used by a live session, return that session instead of spawning (default true). false makes it invalid_args with name_taken.'),
      }),
      outputSchema: SPAWN_OUTPUT,
      annotations: MUTATING,
    },
    wrap(async (args) => manager.spawn(args)),
  );

  server.registerTool(
    'pty_write',
    {
      title: 'Write to terminal',
      description:
        'Send keystrokes to a running session. newline (default true) appends a line ending: a carriage return '
        + 'to a PTY session, which is what a shell or prompt is waiting for, or a newline to a pipe session '
        + 'from run, because a pipe has no terminal translation. Returns {ok}. Give waitMs (and optionally '
        + 'match, with the same '
        + 'semantics as pty_read) to read the answer in the same call: the response then also carries '
        + '{data, cursor, exited, exitCode, dropped, matched, incomplete, truncated}. Without waitMs nothing '
        + 'is read, so a caller that expects output must either pass waitMs here or call pty_read next.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session id or name: the id pty_spawn or run returned, or the name given at spawn.'),
        data: z.string().describe('Text to send. Escape sequences such as \\u0003 (Ctrl+C) are sent literally.'),
        newline: z.boolean().optional().describe('Append a carriage return after data (default true).'),
        waitMs: z.number().int().min(0).max(10000).optional().describe('After writing, wait up to this many milliseconds for a reply and return it (default 0: write only).'),
        match: z.string().optional().describe('Regular expression (at most 200 characters) to wait for after writing; needs waitMs > 0.'),
        cursor: z.number().int().min(0).optional().describe('Byte offset to read from after writing. Omit to read from the start of the buffer.'),
        maxBytes: z.number().int().min(1).max(1048576).optional().describe('Maximum bytes to return after writing (default 8000).'),
        stripAnsi: z.boolean().optional().describe('Remove ANSI escape sequences from the reply (default true). The cursor still counts raw bytes.'),
      }),
      outputSchema: WRITE_OUTPUT,
      annotations: MUTATING,
    },
    wrap(async ({ sessionId, data, newline, waitMs, match, cursor, maxBytes, stripAnsi }) => {
      const written = manager.write(sessionId, data, newline ?? true);
      if (!waitMs) return written;
      const read = await manager.read(sessionId, { cursor, maxBytes, waitMs, match, stripAnsi });
      return { ...written, ...read };
    }),
  );

  server.registerTool(
    'pty_read',
    {
      title: 'Read terminal output',
      description:
        'Read output from a session, starting at cursor, and return {data, cursor, exited, exitCode, dropped, '
        + 'matched, incomplete, truncated}. '
        + 'Pass the cursor from the previous read to get only new output; omit it to read from the oldest byte '
        + 'still buffered. maxBytes bounds the returned data. A read may exceed it to finish the one UTF-8 '
        + 'character or escape sequence that straddles the end, and it stops widening at maxBytes + 65536 '
        + 'bytes: if an escape sequence is still unfinished there, the whole 65536-byte overage is returned '
        + 'as literal text and the cursor advances. The overage is never more than 65536 bytes. '
        + 'dropped > 0 means the ring buffer discarded that many bytes before this read. '
        + 'incomplete: true means the bytes at cursor end inside a UTF-8 character still in flight: wait and '
        + 'read again from that cursor rather than assuming the character is lost. truncated: true means the '
        + 'child exited inside a UTF-8 character or escape sequence, so the rest can never arrive. '
        + 'waitMs waits for the session to produce output (or exit) before returning; with stripAnsi '
        + 'a chunk holding only escape sequences does not count, so the read keeps waiting for visible text. '
        + 'match is a regular expression that makes the read wait until the text from cursor matches it, or the '
        + 'session exits, or waitMs runs out, then reports matched: false on timeout — so a non-zero waitMs is what '
        + 'makes match useful.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session id or name: the id pty_spawn or run returned, or the name given at spawn.'),
        cursor: z.number().int().min(0).optional().describe('Byte offset from the previous read. Omit to read from the start of the buffer.'),
        maxBytes: z.number().int().min(1).max(1048576).optional().describe('Maximum bytes to return (default 8000).'),
        waitMs: z.number().int().min(0).max(10000).optional().describe('Wait up to this many milliseconds for new output (default 0).'),
        stripAnsi: z.boolean().optional().describe('Remove ANSI escape sequences from data (default true). The cursor still counts raw bytes.'),
        match: z.string().optional().describe('Regular expression (at most 200 characters) the text from cursor must match before the read returns; with stripAnsi false it matches the raw text.'),
      }),
      outputSchema: READ_OUTPUT,
      annotations: READ_ONLY,
    },
    wrap(async ({ sessionId, cursor, maxBytes, waitMs, stripAnsi, match }) =>
      manager.read(sessionId, {
        cursor,
        maxBytes: maxBytes ?? 8000,
        waitMs: waitMs ?? 0,
        stripAnsi: stripAnsi ?? true,
        match,
      })),
  );

  server.registerTool(
    'pty_resize',
    {
      title: 'Resize terminal',
      description:
        'Change the size of a running session\'s terminal, so a full-screen program stops being pinned to the '
        + 'geometry it was spawned with. cols and rows are integers 1..1000; give both, or give one and the other '
        + 'keeps the size in force. The program is told at once: on POSIX it receives SIGWINCH, on Windows the '
        + 'ConPTY itself is resized, so a TUI redraws at the new size instead of staying at the old one. Returns '
        + '{ok, cols, rows} for the size now in force, which pty_list also reports. A call naming neither dimension '
        + 'is invalid_args; resizing a session whose program has already exited is pty_resize_failed, and so is a '
        + 'pipe session from run, which has no terminal (rerun it with tty: true when it needs a PTY).',
      inputSchema: z.object({
        sessionId: z.string().describe('Session id or name: the id pty_spawn or run returned, or the name given at spawn.'),
        cols: z.number().int().min(1).max(1000).optional().describe('Terminal columns to apply. Omit to keep the current columns; at least one of cols and rows is required.'),
        rows: z.number().int().min(1).max(1000).optional().describe('Terminal rows to apply. Omit to keep the current rows; at least one of cols and rows is required.'),
      }),
      outputSchema: RESIZE_OUTPUT,
      annotations: MUTATING,
    },
    wrap(async ({ sessionId, cols, rows }) => manager.resize(sessionId, { cols, rows })),
  );

  server.registerTool(
    'pty_kill',
    {
      title: 'Kill terminal',
      description:
        'Terminate a session\'s program and confirm it is gone: returns {ok, exited, exitCode, pid}. '
        + 'exited is the state observed after the kill, not the request, so ok:false with an error naming the pid '
        + 'means the process survived and the message carries the fallback. Idempotent: killing an already-exited '
        + 'session returns ok:true, exited:true. The session stays listed with its exit code so its last output '
        + 'can still be read.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session id or name: the id pty_spawn or run returned, or the name given at spawn.'),
        signal: z.string().optional().describe('POSIX signal name (default SIGTERM). Ignored on Windows, where the process tree is terminated.'),
      }),
      outputSchema: KILL_OUTPUT,
      annotations: DESTRUCTIVE,
    },
    wrap(async ({ sessionId, signal }) => manager.kill(sessionId, signal ?? 'SIGTERM')),
  );

  server.registerTool(
    'pty_list',
    {
      title: 'List terminals',
      description:
        'List sessions this server knows about, newest last, one page at a time: sessionId, name, pid, title, '
        + 'command, args, cwd, description, cols, rows, pipe, exited, exitCode, bytes emitted, and createdAt. name is '
        + 'the name given at spawn (or null). cols and rows are the size in force now, so a session resized with '
        + 'pty_resize reports the new geometry here; pipe is true for a run session with no terminal, and its '
        + 'cols and rows are 0. Returns {sessions, total, nextOffset}: total counts every '
        + 'session known, and nextOffset is null on the last page. Use it to recover a session id or name you lost, '
        + 'or to recall what an existing session was for.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Sessions to return (default 50, max 200).'),
        offset: z.number().int().min(0).optional().describe('Sessions to skip from the oldest (default 0).'),
      }),
      outputSchema: LIST_OUTPUT,
      annotations: READ_ONLY,
    },
    wrap(async ({ limit, offset }) => manager.list({ limit, offset })),
  );

  return { server, manager };
}
