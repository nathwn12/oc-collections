// MCP server surface: exactly five tools.
//
// pty_spawn / pty_write / pty_read / pty_kill / pty_list.
// Every handler funnels through wrap(), so a throw becomes a typed tool error
// and never escapes into the JSON-RPC transport.

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionManager } from './sessions.js';
import { toolFailure, toolSuccess } from './errors.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const INSTRUCTIONS = [
  'janua gives you persistent interactive terminals. Use pty_spawn for programs you need to talk to over time',
  '(dev servers, REPLs, anything that prompts), not for one-shot commands. Keep the returned sessionId, read with',
  'pty_read using the cursor it returns so output is never duplicated, write with pty_write, and pty_kill when done.',
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

export function createServer(options = {}) {
  const manager = options.manager ?? new SessionManager();
  const server = new McpServer(
    { name: 'janua', version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'pty_spawn',
    {
      title: 'Spawn interactive terminal',
      description:
        'Start a program in a persistent pseudo-terminal and return {sessionId, pid, title}. '
        + 'The program keeps running until pty_kill or its own exit; nothing is run through a shell, '
        + 'so command and args are passed exactly as given. Use this for anything you need to talk to '
        + '(dev servers, REPLs, installers that prompt), not for commands whose output you want once.',
      inputSchema: {
        command: z.string().describe('Executable to run: a name resolved on PATH, or an absolute path. No shell string.'),
        args: z.array(z.string()).optional().describe('Arguments for command, one array entry each.'),
        cwd: z.string().optional().describe('Working directory for the program. Must exist. Defaults to the server process cwd.'),
        env: z.record(z.string(), z.string()).optional().describe('Extra environment variables, merged over the server environment.'),
        cols: z.number().int().min(1).max(1000).optional().describe('Terminal columns (default 80).'),
        rows: z.number().int().min(1).max(1000).optional().describe('Terminal rows (default 24).'),
        title: z.string().optional().describe('Short label for this session, shown by pty_list. Defaults to the command name.'),
        description: z.string().describe('5-10 words saying what this session is for, so a later read makes sense on its own.'),
      },
    },
    wrap(async (args) => manager.spawn(args)),
  );

  server.registerTool(
    'pty_write',
    {
      title: 'Write to terminal',
      description:
        'Send keystrokes to a running session. newline (default true) appends a carriage return, which is what '
        + 'a shell or prompt is waiting for. Output produced in response is not returned here: read it with pty_read.',
      inputSchema: {
        sessionId: z.string().describe('Session id returned by pty_spawn.'),
        data: z.string().describe('Text to send. Escape sequences such as \\u0003 (Ctrl+C) are sent literally.'),
        newline: z.boolean().optional().describe('Append a carriage return after data (default true).'),
      },
    },
    wrap(async ({ sessionId, data, newline }) => manager.write(sessionId, data, newline ?? true)),
  );

  server.registerTool(
    'pty_read',
    {
      title: 'Read terminal output',
      description:
        'Read output from a session, starting at cursor, and return {data, cursor, exited, exitCode, dropped}. '
        + 'Pass the cursor from the previous read to get only new output; omit it to read from the oldest byte '
        + 'still buffered. dropped > 0 means the ring buffer discarded that many bytes before this read. '
        + 'waitMs waits for the session to produce new output (or exit) before returning.',
      inputSchema: {
        sessionId: z.string().describe('Session id returned by pty_spawn.'),
        cursor: z.number().int().min(0).optional().describe('Byte offset from the previous read. Omit to read from the start of the buffer.'),
        maxBytes: z.number().int().min(1).max(1048576).optional().describe('Maximum bytes to return (default 8000).'),
        waitMs: z.number().int().min(0).max(10000).optional().describe('Wait up to this many milliseconds for new output (default 0).'),
        stripAnsi: z.boolean().optional().describe('Remove ANSI escape sequences from data (default true). The cursor still counts raw bytes.'),
      },
    },
    wrap(async ({ sessionId, cursor, maxBytes, waitMs, stripAnsi }) =>
      manager.read(sessionId, {
        cursor,
        maxBytes: maxBytes ?? 8000,
        waitMs: waitMs ?? 0,
        stripAnsi: stripAnsi ?? true,
      })),
  );

  server.registerTool(
    'pty_kill',
    {
      title: 'Kill terminal',
      description:
        'Terminate a session\'s program. Idempotent: killing an already-exited session returns ok. '
        + 'The session stays listed with its exit code so its last output can still be read.',
      inputSchema: {
        sessionId: z.string().describe('Session id returned by pty_spawn.'),
        signal: z.string().optional().describe('POSIX signal name (default SIGTERM). Ignored on Windows, where the process tree is terminated.'),
      },
    },
    wrap(async ({ sessionId, signal }) => manager.kill(sessionId, signal ?? 'SIGTERM')),
  );

  server.registerTool(
    'pty_list',
    {
      title: 'List terminals',
      description:
        'List every session this server knows about, newest last: sessionId, pid, title, command, exited, '
        + 'exitCode, bytes emitted, and createdAt. Use it to recover a session id you lost.',
      inputSchema: {},
    },
    wrap(async () => ({ sessions: manager.list() })),
  );

  return { server, manager };
}
