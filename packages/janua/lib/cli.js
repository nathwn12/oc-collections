// janua's command line.
//
// Two entry points on one binary:
//   - `janua run ...` is the one-shot layer: a command, its output, its exit
//     code, no MCP client and no orchestrator required;
//   - bare `janua` or `janua mcp` is the stdio MCP server, exactly as before,
//     so an existing client config keeps working.
//
// stdout belongs to whichever mode is active: the command's own output for
// `run`, JSON-RPC frames for the server. Diagnostics always go to stderr.

import { createRequire } from 'node:module';
import { SessionManager } from './sessions.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const USAGE = `janua ${version}

Usage:
  janua run [options] -- <command> [args...]
  janua mcp                     start the stdio MCP server (the default)
  janua --version, -v           print the version
  janua --help, -h              print this help

Run options:
  --cwd <dir>        working directory for the command
  --timeout <ms>     give up after this long (default 120000, max 3600000)
  --stdin <text>     write this text to the command stdin immediately
  --max-bytes <n>    cap returned output (default and max 1048576)
  --raw              keep ANSI escape sequences (default: strip them)
  --shell            take the whole command as one shell command line
  --name <name>      name the session, reported in the JSON
  --match <re>       stop early when the output matches this regular expression
  --json             print the whole result as JSON instead of just data

Without --json the command's output is written to stdout unchanged (no added
newline) and the exit status is the command's own; 124 means --timeout ran out
and 2 means a usage or spawn failure.
`;

class UsageError extends Error {}

function writeStdout(text) {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

function writeStderr(text) {
  return new Promise((resolve) => {
    process.stderr.write(text, () => resolve());
  });
}

function optionValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) throw new UsageError(`${flag} needs a value`);
  return value;
}

function integerOption(argv, index, flag) {
  const raw = optionValue(argv, index, flag);
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new UsageError(`${flag} needs an integer, got "${raw}"`);
  return value;
}

// Parse `janua run` arguments. A `--` ends option parsing; without it the first
// token that is not an option starts the command, so the common case needs no
// separator.
function parseRunArgs(argv) {
  const parsed = { args: [] };
  let index = 0;
  let command;

  while (index < argv.length) {
    const token = argv[index];
    if (token === '--') {
      index += 1;
      command = argv[index];
      parsed.args = argv.slice(index + 1);
      break;
    }
    if (token === '-' || !token.startsWith('-')) {
      command = token;
      parsed.args = argv.slice(index + 1);
      break;
    }
    index += 1;
    switch (token) {
      case '--json':
        parsed.json = true;
        break;
      case '--raw':
        parsed.raw = true;
        break;
      case '--shell':
        parsed.shell = true;
        break;
      case '--cwd':
        parsed.cwd = optionValue(argv, index, token);
        index += 1;
        break;
      case '--stdin':
        parsed.stdin = optionValue(argv, index, token);
        index += 1;
        break;
      case '--match':
        parsed.match = optionValue(argv, index, token);
        index += 1;
        break;
      case '--name':
        parsed.name = optionValue(argv, index, token);
        index += 1;
        break;
      case '--timeout':
        parsed.timeoutMs = integerOption(argv, index, token);
        index += 1;
        break;
      case '--max-bytes':
        parsed.maxBytes = integerOption(argv, index, token);
        index += 1;
        break;
      default:
        throw new UsageError(`unknown option ${token}`);
    }
  }

  if (!command) {
    throw new UsageError('no command given: put it after --, for example janua run -- node -v');
  }
  if (parsed.shell && parsed.args.length > 0) {
    throw new UsageError('--shell takes one command line, so quote it: janua run --shell -- "npm run build"');
  }
  parsed.command = command;
  return parsed;
}

async function runCommand(argv) {
  let parsed;
  try {
    parsed = parseRunArgs(argv);
  } catch (err) {
    await writeStderr(`janua: ${err.message}\n\n${USAGE}`);
    return 2;
  }

  const input = { command: parsed.command, args: parsed.args };
  if (parsed.cwd !== undefined) input.cwd = parsed.cwd;
  if (parsed.timeoutMs !== undefined) input.timeoutMs = parsed.timeoutMs;
  if (parsed.stdin !== undefined) input.stdin = parsed.stdin;
  if (parsed.maxBytes !== undefined) input.maxBytes = parsed.maxBytes;
  if (parsed.match !== undefined) input.match = parsed.match;
  if (parsed.name !== undefined) input.name = parsed.name;
  if (parsed.shell) input.shell = true;
  if (parsed.raw) input.stripAnsi = false;

  const manager = new SessionManager();
  try {
    const result = await manager.run(input);
    const output = parsed.json ? `${JSON.stringify(result, null, 2)}\n` : result.data;
    await writeStdout(output);
    if (result.timedOut) return 124;
    return result.exitCode ?? 1;
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'internal_error';
    const message = err && typeof err.message === 'string' ? err.message : String(err);
    await writeStderr(`janua: ${code}: ${message}\n`);
    return 2;
  } finally {
    // A CLI run is one-shot: nothing it spawned can outlive this process, so
    // every session goes whether the run exited, matched, timed out, or failed.
    manager.killAll();
  }
}

// The MCP server is imported lazily so `janua run` does not pay for the MCP
// stack, and its shutdown behaviour is the one the old binary had.
async function startMcp() {
  const [{ StdioServerTransport }, { createServer }] = await Promise.all([
    import('@modelcontextprotocol/server/stdio'),
    import('./server.js'),
  ]);
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
}

export async function main(argv = process.argv.slice(2)) {
  const [first, ...rest] = argv;
  if (first === undefined || first === 'mcp') {
    await startMcp();
    return;
  }
  if (first === '--version' || first === '-v') {
    await writeStdout(`${version}\n`);
    return;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    await writeStdout(USAGE);
    return;
  }
  if (first === 'run') {
    const code = await runCommand(rest);
    // The CLI is one call: the process ends here and every PTY closes with it.
    // stdout has already been flushed by runCommand.
    process.exit(code);
  }
  await writeStderr(`janua: unknown command "${first}"\n\n${USAGE}`);
  process.exitCode = 2;
}
