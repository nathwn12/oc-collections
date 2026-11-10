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
 * The injected text. It is a projection of the `stacked` skill, not a copy: the
 * always-on subset (rungs, loop, autonomy, disjointness, tools), about a third
 * of the skill body. Every extra paragraph here is paid for on every step of
 * every session, and the full protocol is one `skill` call away.
 */
export function bootstrap() {
  if (bootstrapCache !== null) return bootstrapCache;
  if (!fs.existsSync(path.join(skillsDir, 'stacked', 'SKILL.md'))) {
    bootstrapCache = '';
    return bootstrapCache;
  }
  bootstrapCache = `${MARKER}

The stacked protocol is loaded. Do not load \`stacked\` again; load a rung only when you move to that rung.
Shelf: stacked-pls, stacked-plan, stacked-swarm, stacked-debug, stacked-tdd, stacked-review, stacked-ship, stacked-deepen — load on match.

**Rungs.** LEAD decides everything reversible: cuts seams, writes briefs, dispatches, reconciles, lands, keeps the digest. Asks the owner only for the five stops. Never takes a seam it dispatched; never lands on a worker's word alone.
EMPLOYEE works one seam from one brief: build, prove with the named check, write the report. Never merges, never pushes a shared branch, never widens scope, never dispatches.
AUDIT gives the verdict on work it did not write: PASS / PASS WITH NOTES / FAIL. Never edits.

**Loop.** intake → rank → brief → dispatch → reconcile → land → digest → audit.
- intake: restate the objective in one sentence; log \`ledger\` kind=INTAKE.
- rank: every genuinely disjoint seam, up to ten; park the rest with a reason.
- brief: Out, Check, Owns, exact Files. \`brief\` refuses a hole. More than one seam → \`swarm\`, which refuses a shared file.
- dispatch: one employee per seam, all in one response; the prompt is the brief path and the report path, nothing else.
- reconcile: read the report first, then \`scope\`, \`check\`, the diff, \`ready\`.
- land: one commit, plain words, the check output in the body. Marking it landed needs a recorded GO.
- digest: \`ledger\` op=digest every turn. It renders the objective, needs-you, new, in progress, stalls.
- audit: a context that wrote none of it. Record it: \`ledger\` kind=AUDIT "<id>@<sha> PASS|FAIL".

**Autonomy.** A reversible decision inside the working tree is yours. Act, log \`RULING · what - why - cost\`, keep moving. Only five things stop the stack: an irreversible act, money above the standing cap, a security-sensitive act, an outward side effect that norms say you ask about, or a request with no path. For those, write an \`ASK\` line and stop. A plan needs no approval; the check is the approval.

**Disjoint means no two workers edit the same file.** Same branch, folder, or package is fine.

Answer for action: next step first, five items max, no preamble or recap.

**State** is \`.stack/\`: ledger, digest, briefs, reports, state/checks.json, config.json. Trust it and \`git log\` over recollection.

**Tools:** \`ledger\`, \`brief\`, \`swarm\`, \`check\`, \`scope\`, \`ready\`. **Dispatch:** \`subagent\` with the archetype the brief names (22 in 7 departments); verdict: \`auditor\`; load a skill: \`skill\`.
</STACKED>`;
  return bootstrapCache;
}

export { MARKER };

