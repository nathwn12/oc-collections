// The content registry: what exists on disk, decoded into the host's Skill.Info
// shape. Discovery only - the injected text lives in ./bootstrap.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter } from './text.js';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, '..');
export const skillsDir = path.join(packageRoot, 'skills');
export const agentsDir = path.join(packageRoot, 'agents');
export const commandsDir = path.join(packageRoot, 'commands');

/**
 * Every skill, decoded into the host's Skill.Info shape.
 * `SOUL.md` at the package root is the one canonical copy of the four laws and
 * is registered as `stacked-soul`, so the file exists for humans to read and
 * for the model to load, without a duplicate under `skills/`.
 */
export function readSkills() {
  const out = [];

  const soulFile = path.join(packageRoot, 'SOUL.md');
  if (fs.existsSync(soulFile)) {
    const { body } = splitFrontmatter(fs.readFileSync(soulFile, 'utf8'));
    out.push({
      id: 'stacked-soul',
      name: 'SOUL',
      description:
        'The four laws every seat obeys: name the unknown, smallest change, touch only your seam, prove it or say you did not. Load when writing, reviewing, refactoring, or deciding whether work is done.',
      path: soulFile,
      content: body.trimStart(),
    });
  }

  if (!fs.existsSync(skillsDir)) return out;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const { data, body } = splitFrontmatter(fs.readFileSync(file, 'utf8'));
    out.push({
      id: entry.name,
      name: data.name || entry.name,
      description: data.description || '',
      path: file,
      content: body.trimStart(),
    });
  }
  return out;
}
