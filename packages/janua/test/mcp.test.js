import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'janua.js');
const TOOL_NAMES = ['pty_kill', 'pty_list', 'pty_read', 'pty_spawn', 'pty_write'];
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
    args: [BIN],
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

  const killed = await client.callTool({
    name: 'pty_kill',
    arguments: { sessionId: spawnPayload.sessionId },
  });
  console.log(`pty_kill -> ${textOf(killed)}`);
  assert.deepEqual(JSON.parse(textOf(killed)), { ok: true });

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

  const listedAfter = await client.callTool({ name: 'pty_list', arguments: {} });
  const sessions = JSON.parse(textOf(listedAfter)).sessions;
  console.log(`pty_list -> ${JSON.stringify(sessions)}`);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, spawnPayload.sessionId);

  const missing = await client.callTool({
    name: 'pty_read',
    arguments: { sessionId: MISSING_ID },
  });
  console.log(`pty_read(bogus) -> isError=${missing.isError} text=${JSON.stringify(textOf(missing))}`);
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /session_not_found/);
});
