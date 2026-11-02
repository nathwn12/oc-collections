#!/usr/bin/env node
// janua: a one-shot runner and a terminal you can talk to.
//
// `janua run` writes the command's own output to stdout; bare `janua` (or
// `janua mcp`) owns stdout for JSON-RPC frames. Diagnostics always go to
// stderr, and every MCP session is killed on transport close, SIGINT, SIGTERM
// and normal exit, so no PTY outlives the server.

import { main } from '../lib/cli.js';

await main(process.argv.slice(2));
