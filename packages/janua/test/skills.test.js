import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'janua-cli.js');
const SKILL_PATH = join(here, '..', 'skills', 'terminals', 'SKILL.md');
const SKILL_URI = 'skill://terminals/SKILL.md';
const SKILLS_EXT = 'io.modelcontextprotocol/skills';

test('MCP skills (SEP-2640): capabilities, list, digest, read, unknown uri', async (t) => {
  const client = new Client({ name: 'janua-skills-test', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp'],
    stderr: 'pipe',
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  const caps = client.getServerCapabilities();
  assert.ok(caps, 'server capabilities present');
  assert.ok(caps.resources, 'capabilities.resources present');
  assert.ok(caps.extensions && caps.extensions[SKILLS_EXT], 'skills extension capability present');

  const listed = await client.request({ method: 'skills/list', params: {} }, z.any());
  assert.ok(Array.isArray(listed.skills), 'skills/list returns skills array');
  assert.equal(listed.skills.length, 1, 'one seed skill');
  const skill = listed.skills[0];
  assert.equal(skill.uri, SKILL_URI, 'skill uri');
  assert.equal(skill.name, 'terminals', 'skills/list entry carries a top-level name');
  assert.equal(skill.frontmatter.name, 'terminals', 'frontmatter name');
  assert.equal(typeof skill.frontmatter.description, 'string', 'frontmatter description');
  assert.ok(skill.frontmatter.description.length >= 1 && skill.frontmatter.description.length <= 1024);

  const skillMdResource = skill.resources.find((r) => r.uri === SKILL_URI);
  assert.ok(skillMdResource, 'SKILL.md resource listed');
  const fileBytes = readFileSync(SKILL_PATH);
  const digest = 'sha256:' + createHash('sha256').update(fileBytes).digest('hex');
  assert.equal(skillMdResource.digest, digest, 'SKILL.md digest matches bytes');
  assert.equal(skillMdResource.size, fileBytes.byteLength, 'SKILL.md size matches bytes');

  const read = await client.readResource({ uri: SKILL_URI });
  assert.ok(Array.isArray(read.contents) && read.contents.length > 0, 'resource read contents');
  const content = read.contents[0];
  let returned;
  if (typeof content.text === 'string') {
    returned = Buffer.from(content.text, 'utf8');
  } else {
    returned = Buffer.from(content.blob, 'base64');
  }
  assert.deepEqual(returned, fileBytes, 'resources/read returns SKILL.md bytes');

  const got = await client.request({ method: 'skills/get', params: { uri: SKILL_URI } }, z.any());
  assert.equal(got.skill.uri, SKILL_URI, 'skills/get returns the requested skill');
  assert.equal(got.skill.name, 'terminals', 'skills/get skill carries a top-level name');

  let caught;
  try {
    await client.request({ method: 'skills/get', params: { uri: 'skill://nope/SKILL.md' } }, z.any());
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'unknown uri throws');
  assert.equal(caught.code, -32602, 'unknown uri -> -32602');
});
