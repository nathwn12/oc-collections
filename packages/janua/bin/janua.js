#!/usr/bin/env node
// janua: a terminal you can talk to, over MCP stdio.
//
// stdout belongs to the JSON-RPC frames and nothing else; diagnostics go to
// stderr. Every session is killed on transport close, SIGINT, SIGTERM and
// normal exit, so no PTY outlives the server.

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../lib/server.js';

const { server, manager } = createServer();

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  manager.killAll();
  process.exit(code);
}

process.on('exit', () => manager.killAll());
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// The client closing stdin is the normal end of a stdio MCP session: without
// this the PTY handles would keep the process alive after the transport dies.
process.stdin.on('end', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));

const transport = new StdioServerTransport();
await server.connect(transport);
