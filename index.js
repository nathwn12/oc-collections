/**
 * oc-stacked — the three-rung agent stack for OpenCode.
 *
 * V2 (2.0.4+): `default.setup(ctx)` registers skills and tools natively and
 * injects the bootstrap through the `context`, `compaction`, and `generate`
 * session hooks, so every request shape carries the same cached prefix.
 *
 * V1: the named export `StackedPlugin` adds the skills directory to the live
 * config and injects through `experimental.chat.messages.transform`. Tools are
 * a V2 facility; V1 keeps skills and the bootstrap.
 *
 * No dependencies, no network, no MCP. A failure in any one registration is
 * contained so a bad schema can never take down the host's plugin generation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootstrap, MARKER, readSkills, skillsDir } from './lib/skills.js';
import { toolDefinitions } from './lib/tools.js';
import { seedStack } from './lib/state.js';

const DEBUG = process.env.OC_STACKED_DEBUG === '1';
const note = (...parts) => {
  const line = `[oc-stacked] ${parts.join(' ')}`;
  if (DEBUG) console.error(line);
};

/** Project root for this plugin instance. Falls back to the process cwd. */
function rootOf(ctx, fallback) {
  return (
    ctx?.location?.directory ||
    ctx?.location?.project?.canonical ||
    ctx?.directory ||
    fallback ||
    process.cwd()
  );
}

/** A top-level session gets the bootstrap; a child session gets its brief. */const childCache = new Map();
async function isChild(ctx, sessionID) {
  if (!sessionID) return false;
  if (childCache.has(sessionID)) return childCache.get(sessionID);
  try {
    if (typeof ctx?.session?.get !== 'function') return false;
    const session = await ctx.session.get({ sessionID });
    const record = session?.data ?? session;
    if (!record || typeof record !== 'object' || record.id !== sessionID) return false;
    const is = typeof record.parentID === 'string' && record.parentID.length > 0;
    if (childCache.size > 512) childCache.clear();
    childCache.set(sessionID, is);
    return is;
  } catch {
    return false; // fail open: injection is harmless, a missing injection is not
  }
}

async function registerSkills(ctx) {
  const skills = readSkills();
  if (!skills.length) {
    note('no skills found beside the plugin');
    return 0;
  }
  let added = 0;
  try {
    await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        try {
          editor.add(skill);
          added += 1;
        } catch (err) {
          note(`skill "${skill.id}" rejected by the host:`, err?.message || err);
        }
      }
    });
  } catch (err) {
    note('skill registration failed:', err?.message || err);
  }
  note(`registered ${added}/${skills.length} skills`);
  return added;
}

async function registerTools(ctx, dir) {
  if (typeof ctx?.tool?.transform !== 'function') return 0;
  const definitions = toolDefinitions({ dir });
  let added = 0;
  try {
    await ctx.tool.transform((editor) => {
      try {
        if (typeof editor.namespace === 'function') {
          editor.namespace({
            name: 'stack',
            description: 'The stacked workbench: memory, seam briefs, proving checks, scope audits, and the landing gate.',
          });
        }
      } catch {
        /* namespace is cosmetic; tools still register */
      }
      for (const def of definitions) {
        try {
          editor.add({
            name: def.name,
            description: def.description,
            input: def.input,
            options: { namespace: 'stack', codemode: true },
            execute: def.execute,
          });
          added += 1;
        } catch (err) {
          // Retry without options: some hosts reject an unknown option key.
          try {
            editor.add({ name: def.name, description: def.description, input: def.input, execute: def.execute });
            added += 1;
          } catch (inner) {
            note(`tool "${def.name}" rejected by the host:`, inner?.message || inner);
          }
        }
      }
    });
  } catch (err) {
    note('tool registration failed:', err?.message || err);
  }
  note(`registered ${added}/${definitions.length} tools`);
  return added;
}

async function inject(event, ctx) {
  try {
    const text = bootstrap();
    if (!text) return;
    const messages = event?.messages;
    if (!Array.isArray(messages) || !messages.length) return;

    const firstUser = messages.find((m) => m.role === 'user');
    if (firstUser && Array.isArray(firstUser.content) && firstUser.content.length === 0) return;
    if (firstUser?.content?.some?.((p) => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith(MARKER))) return;

    if (await isChild(ctx, event.sessionID)) return;

    if (firstUser) {
      if (!Array.isArray(firstUser.content)) firstUser.content = [];
      firstUser.content.unshift({ type: 'text', text });
    } else {
      messages.push({ role: 'user', content: [{ type: 'text', text }] });
    }
  } catch (err) {
    note('bootstrap injection failed:', err?.message || err);
  }
}

// Once per directory per process. Seeding never overwrites: it adds the
// directories, a config with the checks the manifests declare, the ledger
// header and a digest, so the first tool call in a real repo is not an empty
// state directory. Opt out with OC_STACKED_NO_SEED=1.
const seeded = new Set();
async function ensureProjectStack(dir) {
  if (process.env.OC_STACKED_NO_SEED === '1' || !dir || seeded.has(dir)) return;
  seeded.add(dir);
  try {
    const result = seedStack(dir);
    if (result.ok && (result.created.length || result.updated.length)) {
      note(`seeded ${dir}:`, [...result.created, ...result.updated].join(', '));
    }
  } catch (err) {
    note('stack seeding failed:', err?.message || err);
  }
}

async function setup(ctx) {
  // V1 also calls default.setup with a context that has no skill/session domain.
  if (!ctx || typeof ctx?.skill?.transform !== 'function' || typeof ctx?.session?.hook !== 'function') {
    return;
  }

  const dir = rootOf(ctx);
  await registerSkills(ctx);
  await registerTools(ctx, dir);
  await ensureProjectStack(dir);

  for (const hook of ['context', 'compaction', 'generate']) {
    try {
      await ctx.session.hook(hook, (event) => inject(event, ctx));
    } catch (err) {
      note(`hook "${hook}" registration failed:`, err?.message || err);
    }
  }

  note(`ready in ${dir} (OpenCode ${ctx?.app?.version || 'unknown'})`);

  // Surface readiness to the console once, so a headless smoke test can see it.
  if (DEBUG) {
    try {
      fs.appendFileSync(path.join(dir, '.stack', 'plugin.log'), `${new Date().toISOString()} ready\n`);
    } catch {
      /* the project may be read-only; never fail setup for a log line */
    }
  }
}

/** V1 entry point. Skills plus bootstrap; no tool domain exists there. */
export const StackedPlugin = async ({ directory } = {}) => ({
  config: async (config) => {
    if (Array.isArray(config.skills)) return; // V2 shape: setup() owns registration
    config.skills = config.skills || {};
    config.skills.paths = config.skills.paths || [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
  },

  'experimental.chat.messages.transform': async (input, output) => {
    const event = {
      messages: output?.messages?.map?.((m) => ({
        role: m?.info?.role,
        content: (m?.parts || []).map((p) => ({ type: p.type, text: p.text })),
        sessionID: m?.info?.sessionID,
      })),
      sessionID: output?.messages?.find?.((m) => m?.info?.role === 'user')?.info?.sessionID,
    };
    await inject(event, { session: null, location: { directory } });
  },
});

export default {
  id: 'oc-stacked',
  server: StackedPlugin,
  setup,
};
