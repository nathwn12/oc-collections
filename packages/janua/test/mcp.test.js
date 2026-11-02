import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'janua.js');
const TOOL_NAMES = ['pty_kill', 'pty_list', 'pty_read', 'pty_resize', 'pty_spawn', 'pty_write', 'run'];
const MISSING_ID = '22222222-2222-2222-2222-222222222222';

function textOf(result) {
  return (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

test('MCP handshake: tools/list, then spawn, read and kill over stdio', async (t) => {
  const client = new Client({ name: 'janua-test', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp'],
    stderr: 'pipe',
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  console.log(`tools/list -> ${names.join(', ')}`);
  assert.deepEqual(names, TOOL_NAMES);

  // Every tool declares its output shape and its effect on the world, so a
  // client can validate structuredContent and decide what to auto-approve.
  for (const tool of listed.tools) {
    assert.ok(tool.outputSchema, `${tool.name} must declare an outputSchema`);
    assert.equal(typeof tool.annotations, 'object', `${tool.name} must carry annotations`);
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} must not claim the open web`);
  }
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.pty_read.annotations.readOnlyHint, true);
  assert.equal(byName.pty_list.annotations.readOnlyHint, true);
  assert.equal(byName.pty_spawn.annotations.readOnlyHint, false);
  assert.equal(byName.pty_write.annotations.readOnlyHint, false);
  assert.equal(byName.pty_resize.annotations.readOnlyHint, false);
  assert.equal(byName.pty_resize.annotations.destructiveHint, false);
  assert.equal(byName.pty_kill.annotations.destructiveHint, true);
  assert.equal(byName.pty_spawn.annotations.destructiveHint, false);
  assert.equal(byName.run.annotations.readOnlyHint, false, 'run starts a process, so it is not read-only');
  assert.equal(byName.run.annotations.openWorldHint, false);
  assert.deepEqual(
    byName.pty_list.outputSchema.required?.sort(),
    ['nextOffset', 'sessions', 'total'],
  );
  console.log(`pty_kill annotations -> ${JSON.stringify(byName.pty_kill.annotations)}`);

  const spawned = await client.callTool({
    name: 'pty_spawn',
    arguments: {
      command: process.execPath,
      args: ['-e', "process.stdout.write('JANUA_MCP_OK'); setInterval(() => {}, 1000)"],
      description: 'handshake smoke test child process',
    },
  });
  const spawnPayload = JSON.parse(textOf(spawned));
  console.log(`pty_spawn -> ${JSON.stringify(spawnPayload)}`);
  assert.equal(spawned.isError, undefined);
  assert.ok(spawnPayload.sessionId);
  assert.equal(spawnPayload.name, null, 'an unnamed spawn reports a null name');
  assert.equal(spawnPayload.reused, false);

  let data = '';
  let cursor;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !data.includes('JANUA_MCP_OK')) {
    const read = await client.callTool({
      name: 'pty_read',
      arguments: { sessionId: spawnPayload.sessionId, cursor, waitMs: 500 },
    });
    const readPayload = JSON.parse(textOf(read));
    cursor = readPayload.cursor;
    data += readPayload.data;
    console.log(`pty_read -> cursor=${readPayload.cursor} exited=${readPayload.exited} data=${JSON.stringify(readPayload.data)}`);
  }
  assert.match(data, /JANUA_MCP_OK/);

  // The running session can be resized over the wire, and the reply states the
  // geometry in force: one dimension given, the other keeps its spawn-time size.
  const resized = await client.callTool({
    name: 'pty_resize',
    arguments: { sessionId: spawnPayload.sessionId, cols: 100 },
  });
  const resizePayload = JSON.parse(textOf(resized));
  console.log(`pty_resize -> ${JSON.stringify(resizePayload)}`);
  assert.deepEqual(resizePayload, { ok: true, cols: 100, rows: 24 });
  assert.deepEqual(resized.structuredContent, resizePayload, 'structuredContent must match the payload');

  const killed = await client.callTool({
    name: 'pty_kill',
    arguments: { sessionId: spawnPayload.sessionId },
  });
  console.log(`pty_kill -> ${textOf(killed)}`);
  const killPayload = JSON.parse(textOf(killed));
  assert.equal(killPayload.ok, true);
  assert.equal(killPayload.exited, true, 'pty_kill must report the state it confirmed, not the request');
  assert.equal(killPayload.pid, spawnPayload.pid);

  let stopped = { exited: false, exitCode: null, cursor };
  const killDeadline = Date.now() + 10000;
  while (!stopped.exited && Date.now() < killDeadline) {
    stopped = JSON.parse(textOf(await client.callTool({
      name: 'pty_read',
      arguments: { sessionId: spawnPayload.sessionId, cursor: stopped.cursor ?? cursor, waitMs: 1000 },
    })));
  }
  console.log(`pty_read(after kill) -> exited=${stopped.exited} exitCode=${stopped.exitCode}`);
  assert.equal(stopped.exited, true);

  const listedAfter = await client.callTool({ name: 'pty_list', arguments: { limit: 10 } });
  const page = JSON.parse(textOf(listedAfter));
  console.log(`pty_list -> ${JSON.stringify(page)}`);
  assert.equal(page.sessions.length, 1);
  assert.equal(page.total, 1);
  assert.equal(page.nextOffset, null);
  assert.equal(page.sessions[0].sessionId, spawnPayload.sessionId);
  assert.equal(page.sessions[0].name, null, 'pty_list must carry the name, null when unnamed');
  assert.equal(typeof page.sessions[0].description, 'string', 'pty_list must return the description');
  assert.equal(page.sessions[0].description, 'handshake smoke test child process');
  assert.deepEqual(page.sessions[0].args, ['-e', "process.stdout.write('JANUA_MCP_OK'); setInterval(() => {}, 1000)"]);
  assert.equal(page.sessions[0].cols, 100, 'pty_list must report the columns pty_resize applied');
  assert.equal(page.sessions[0].rows, 24, 'the dimension the resize left alone must not move');
  assert.equal(typeof page.sessions[0].cwd, 'string');
  assert.deepEqual(listedAfter.structuredContent, page, 'structuredContent must match the payload');

  const missing = await client.callTool({
    name: 'pty_read',
    arguments: { sessionId: MISSING_ID },
  });
  console.log(`pty_read(bogus) -> isError=${missing.isError} text=${JSON.stringify(textOf(missing))}`);
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /session_not_found/);
  assert.equal(
    missing.structuredContent,
    undefined,
    'a typed failure must not carry a payload that contradicts the output schema',
  );
});

test('pty_write with waitMs and match returns the answer in the same call', async (t) => {
  const client = new Client({ name: 'janua-test', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    stderr: 'pipe',
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  const spawned = JSON.parse(textOf(await client.callTool({
    name: 'pty_spawn',
    arguments: {
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.on('data', (d) => "
        + "process.stdout.write('ECHO:' + d.toString().trim() + '\\r\\nPROMPT> '));"
        + 'setInterval(() => {}, 1000);',
      ],
      description: 'echo a line then print a prompt',
    },
  })));

  // Without waitMs the call is write-only, and says only that much.
  const bare = JSON.parse(textOf(await client.callTool({
    name: 'pty_write',
    arguments: { sessionId: spawned.sessionId, data: 'no-wait' },
  })));
  console.log(`pty_write(no wait) -> ${JSON.stringify(bare)}`);
  assert.deepEqual(Object.keys(bare), ['ok'], 'without waitMs the payload stays {ok}');

  // With waitMs and match the reply arrives here, not in a second call. The
  // pattern is the program's echo of *this* line: waiting on 'PROMPT>' would be
  // satisfied by the prompt the previous write already produced, and the read
  // would return before the answer it is meant to wait for.
  const answered = JSON.parse(textOf(await client.callTool({
    name: 'pty_write',
    arguments: { sessionId: spawned.sessionId, data: 'hello', waitMs: 5000, match: 'ECHO:hello' },
  })));
  console.log(`pty_write(wait) -> ${JSON.stringify(answered)}`);
  assert.equal(answered.ok, true);
  assert.equal(answered.matched, true, 'the prompt must arrive in the write that asked for it');
  assert.match(answered.data, /ECHO:hello/, 'the write payload must carry the answer');
  assert.equal(typeof answered.cursor, 'number');
  assert.equal(typeof answered.exited, 'boolean');
  assert.equal(typeof answered.dropped, 'number');

  await client.callTool({ name: 'pty_kill', arguments: { sessionId: spawned.sessionId } });
});

test('run executes a one-shot command over MCP', async (t) => {
  const client = new Client({ name: 'janua-test', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    stderr: 'pipe',
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  const ran = await client.callTool({
    name: 'run',
    arguments: {
      command: process.execPath,
      args: ['-e', "process.stdout.write('MCP_RUN_OK'); process.exit(5)"],
      timeoutMs: 15000,
    },
  });
  const payload = JSON.parse(textOf(ran));
  console.log(`run -> ${JSON.stringify(payload)}`);
  assert.equal(ran.isError, undefined);
  assert.match(payload.data, /MCP_RUN_OK/);
  assert.equal(payload.exitCode, 5);
  assert.equal(payload.timedOut, false);
  assert.equal(payload.matched, true);
  assert.equal(payload.name, null);
  assert.equal(payload.truncated, false);
  assert.equal(typeof payload.bytes, 'number');
  assert.equal(typeof payload.durationMs, 'number');
  assert.deepEqual(ran.structuredContent, payload, 'structuredContent must match the payload');
});

test('named sessions: list, read/write/kill by name, reuse, and takeover after exit', async (t) => {
  const client = new Client({ name: 'janua-test', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    stderr: 'pipe',
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  const NAME = 'echo-named';
  const ECHO = "process.stdin.on('data', (d) => "
    + "process.stdout.write('ECHO:' + d.toString().trim() + '\\r\\nPROMPT> '));"
    + 'setInterval(() => {}, 1000);';

  const first = JSON.parse(textOf(await client.callTool({
    name: 'pty_spawn',
    arguments: {
      command: process.execPath,
      args: ['-e', ECHO],
      name: NAME,
      description: 'named echo session for name lookups',
    },
  })));
  assert.equal(first.name, NAME);
  assert.equal(first.reused, false);

  const listed = JSON.parse(textOf(await client.callTool({ name: 'pty_list', arguments: { limit: 10 } })));
  assert.equal(listed.sessions[0].name, NAME, 'pty_list must return the name');

  // Read and write accept the name in place of a session id.
  const written = JSON.parse(textOf(await client.callTool({
    name: 'pty_write',
    arguments: { sessionId: NAME, data: 'by-name', waitMs: 5000, match: 'PROMPT>' },
  })));
  assert.equal(written.matched, true, 'a write addressed by name must reach the session');
  assert.match(written.data, /ECHO:by-name/);

  const readByName = JSON.parse(textOf(await client.callTool({
    name: 'pty_read',
    arguments: { sessionId: NAME, cursor: written.cursor, waitMs: 100 },
  })));
  assert.equal(typeof readByName.cursor, 'number');

  // A second spawn with a live name returns the same terminal, not a copy.
  const reused = JSON.parse(textOf(await client.callTool({
    name: 'pty_spawn',
    arguments: { command: process.execPath, args: ['-e', ECHO], name: NAME },
  })));
  assert.equal(reused.sessionId, first.sessionId);
  assert.equal(reused.pid, first.pid);
  assert.equal(reused.reused, true);

  const denied = await client.callTool({
    name: 'pty_spawn',
    arguments: {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      name: NAME,
      reuse: false,
    },
  });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /invalid_args/);
  assert.match(textOf(denied), /name_taken/);

  const killed = JSON.parse(textOf(await client.callTool({
    name: 'pty_kill',
    arguments: { sessionId: NAME },
  })));
  assert.equal(killed.ok, true);
  assert.equal(killed.pid, first.pid);

  // ConPTY reports the exit a moment after the kill: wait for it, then the
  // name must be free for the next spawn.
  let stopped = JSON.parse(textOf(await client.callTool({
    name: 'pty_read',
    arguments: { sessionId: NAME, waitMs: 1000 },
  })));
  const deadline = Date.now() + 10000;
  while (!stopped.exited && Date.now() < deadline) {
    stopped = JSON.parse(textOf(await client.callTool({
      name: 'pty_read',
      arguments: { sessionId: NAME, cursor: stopped.cursor, waitMs: 1000 },
    })));
  }
  assert.equal(stopped.exited, true);

  const replacement = JSON.parse(textOf(await client.callTool({
    name: 'pty_spawn',
    arguments: {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      name: NAME,
    },
  })));
  assert.notEqual(replacement.sessionId, first.sessionId);
  assert.equal(replacement.reused, false);
  assert.equal(
    JSON.parse(textOf(await client.callTool({ name: 'pty_list', arguments: { limit: 10 } })))
      .sessions.filter((session) => session.name === NAME).length,
    1,
    'only the replacement holds the name',
  );

  await client.callTool({ name: 'pty_kill', arguments: { sessionId: replacement.sessionId } });
});
