// Skill discovery and the bootstrap text. Read once, cached for the process.
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

const MARKER = '<STACKED>';
let bootstrapCache = null;

/**
 * The text injected into the first user message of a top-level session.
 * It is the router skill's body plus the host tool mapping, nothing more:
 * every extra paragraph here is paid for on every step of every session.
 */
export function bootstrap() {
  if (bootstrapCache !== null) return bootstrapCache;
  const file = path.join(skillsDir, 'stacked', 'SKILL.md');
  if (!fs.existsSync(file)) {
    bootstrapCache = '';
    return bootstrapCache;
  }
  const { body } = splitFrontmatter(fs.readFileSync(file, 'utf8'));
  bootstrapCache = `${MARKER}

The stacked protocol below is already loaded. Do not load the \`stacked\` skill again; load a rung skill only when you move to that rung.

${body.trim()}

**Host mapping.** When this protocol names an action, use the host's tool:

- Append to the ledger, read it, or rewrite the digest → \`ledger\`
- Write, list, read, or move a seam → \`brief\`
- Run and record the proving commands → \`check\`
- Prove the diff stayed inside a brief → \`scope\`
- Gate a seam for landing → \`ready\`
- Dispatch an employee or auditor → \`subagent\` with \`agent: "stacked-employee"\` or \`"stacked-auditor"\`, \`description\`, \`prompt\`; pass \`sessionID\` to continue one
- Load a rung or discipline skill → \`skill\` with the exact id (\`stacked-lead\`, \`stacked-ceo\`, \`stacked-employee\`, \`stacked-audit\`, \`stacked-soul\`)
- Read, create, edit, delete, search files → \`read\`, \`write\`, \`edit\`, \`shell\`, \`grep\`, \`glob\`
- Build a plan for the owner to read instead of a todo list → write \`.stack/digest.md\` via \`ledger\` op=digest and keep it current

</STACKED>`;
  return bootstrapCache;
}

export { MARKER };
