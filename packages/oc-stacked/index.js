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
import { readSkills, skillsDir } from './lib/content.js';
import { bootstrap, MARKER } from './lib/bootstrap.js';
import { toolDefinitions } from './lib/tools.js';
import { seedStack, tryReadJson, withLock, writeJson, log } from './lib/state.js';
import { closeReasons, invalidateClose, preflight, readClose } from './lib/close.js';
import { head } from './lib/git.js';
import { intentOf, statusOf, stripStatus, withStatus } from './lib/title.js';

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
            description: 'The stacked workbench: memory, seam briefs, atomic swarm fan-out, proving checks, scope audits, the landing gate, and the closing sweep.',
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

// ---------------------------------------------------------------- live status
//
// The title is the status the owner reads: [active] while a turn runs, [parked]
// when it ends unsealed, [done] only on a GO receipt for this HEAD. One engine
// drives every transition - the renamed title, the prompt's plain English, tool
// activity, execution events and idle - so no path can disagree with another.
//
// Precedence, everywhere: a valid close receipt wins; then a parked override;
// then active while working, parked at rest. Every path filters to a top-level
// session living in this project, and every failure is contained by note()
// except the rename refusal, which is the gate itself.

const STATUS_PATH = '.stack/state/status.json';
const INTENT_PATH = '.stack/state/close-intent.json';
const NUDGE_META = 'oc-stacked-status-nudge';
// A close loop is bounded on purpose: six continuations, then a recorded ASK
// and a parked session. A bounded stop is not a success, and it is never [done].
const CLOSE_CAP = 6;
// The prefixes of this plugin's own synthetic messages. A synthetic message may
// arrive as a prompt; it must never be read as the owner asking to resume.
const SYNTHETIC_MARKS = [
  'Close is blocked on ',
  'Preflight is clear. Run stack_close',
  'The receipt is sealed at ',
  '[oc-stacked] The close turn ended without a GO receipt.',
];
// The host registers the tool as `session_rename` in the `opencode` namespace;
// which spelling reaches a hook depends on the surface, so all three are
// accepted. `ctx.tool.hook` names it in whatever form the host used.
const RENAME_TOOLS = new Set(['opencode_session_rename', 'opencode.session_rename', 'session_rename']);
const STATUS_EVENTS = [
  'session.created',
  'session.renamed',
  'session.deleted',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
];
const CLOSE_INTENT = [
  'CLOSE INTENT. Run stack_close op=preflight, settle every ticket it names -',
  'land, kill, answer, or record an ASK and park - then run stack_close op=run',
  'with one lesson. Final message: brief report and closing remarks, then stop.',
  'No work after. Do not claim [done] without the GO receipt.',
].join(' ');
const PARK_INTENT = 'PARK INTENT. Start nothing new. State where the work stands in one line and stop.';

const sameDir = (a, b) => {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
};

/** Per-session overrides: `{ "<sessionID>": { status, at } }`. */
function overrides(dir) {
  const { value } = tryReadJson(dir, STATUS_PATH, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function overrideOf(dir, sessionID) {
  const entry = overrides(dir)[sessionID];
  return entry && typeof entry === 'object' && typeof entry.status === 'string' ? entry.status : null;
}

/** `status` is 'parked', 'closing', or null to clear. Read-modify-write under the stack lock. */
function setOverride(dir, sessionID, status) {
  withLock(dir, () => {
    const all = overrides(dir);
    if ((all[sessionID]?.status || null) === status) return;
    if (status) all[sessionID] = { status, at: new Date().toISOString() };
    else delete all[sessionID];
    writeJson(dir, STATUS_PATH, all);
  });
}

/** Every reason the receipt is not a GO at this HEAD; an unreadable one is a reason too. */
function closeState(dir) {
  try {
    return closeReasons(dir);
  } catch (err) {
    note('close receipt unreadable:', err?.message || err);
    return ['the close receipt could not be read'];
  }
}

// ---------------------------------------------------------------- close loop
//
// `experimental.idle` is a real stop gate: input admitted there continues the
// same execution instead of the session going idle. So while a close intent is
// open the model cannot end a turn on the word "done" - the gate re-states the
// open tickets, or the seal instruction, until a GO receipt exists and the last
// assistant message carries the token. The loop is bounded at CLOSE_CAP; a
// cap is a parked session with a recorded ASK, never a seal.

function readIntents(dir) {
  const { value } = tryReadJson(dir, INTENT_PATH, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** This session's intent, or null. Keyed by session so two sessions cannot overwrite each other. */
function intentFor(dir, sessionID) {
  const entry = readIntents(dir)[sessionID];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return { attempts: Number(entry.attempts) || 0, at: entry.at || null, head: entry.head || null };
}

function writeIntent(dir, sessionID, entry) {
  withLock(dir, () => {
    const all = readIntents(dir);
    all[sessionID] = entry;
    writeJson(dir, INTENT_PATH, all);
  });
}

function clearIntent(dir, sessionID) {
  withLock(dir, () => {
    const all = readIntents(dir);
    if (!(sessionID in all)) return;
    delete all[sessionID];
    if (Object.keys(all).length) writeJson(dir, INTENT_PATH, all);
    else fs.rmSync(path.join(dir, INTENT_PATH), { force: true });
  });
}

/** `SEALED <7-char head>` - the token the close tool prints once the receipt exists. */
function sealToken(dir) {
  try {
    const read = readClose(dir);
    const sha = read?.value?.head;
    return sha ? `SEALED ${String(sha).slice(0, 7)}` : null;
  } catch {
    return null;
  }
}

/**
 * A seal is the brief report, not a bare token: the token, plus either the two
 * headings the report must carry or 200 characters of assistant text. A
 * one-line `SEALED abc1234` is a claim, and the gate asks for the report again.
 */
function sealReport(text, token) {
  if (!token || !text.includes(token)) return false;
  if (text.includes('## Outcome') && text.includes('## Evidence')) return true;
  return text.length >= 200;
}

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

function ticketsLine(blockers) {
  const shown = blockers.slice(0, 4).map(oneLine);
  if (blockers.length > shown.length) shown.push(`+${blockers.length - shown.length} more ticket(s)`);
  return shown.join(' | ');
}

/** The last assistant text in this session, or '' when the context cannot be read. */
async function lastAssistantText(ctx, sessionID) {
  if (typeof ctx?.session?.context !== 'function') return '';
  const fetched = await ctx.session.context({ sessionID });
  const messages = fetched?.data ?? fetched;
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    // A projected message is `{type:'assistant'|'user'|'synthetic', content:[...]}`;
    // the role-keyed shape is kept as a fallback for other hosts.
    const kind = message?.type ?? message?.role ?? message?.info?.role;
    if (kind !== 'assistant') continue;
    const body = message?.info ?? message;
    const parts = Array.isArray(body?.content) ? body.content : Array.isArray(body?.parts) ? body.parts : [];
    return parts
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/** The bounded stop: parked, an ASK in the ledger naming why, and no intent left to chase. */
async function exhaust(ctx, dir, sessionID, record, reasons) {
  await applyTitle(ctx, dir, sessionID, 'parked', record);
  try {
    log(dir, 'ASK', `close loop exhausted after ${CLOSE_CAP} continuations for ${sessionID}: ${reasons.map(oneLine).join('; ')}. Parked, not sealed.`);
  } catch (err) {
    note('could not record the exhausted close:', err?.message || err);
  }
  clearIntent(dir, sessionID);
  note(`close loop exhausted for ${sessionID}`);
}

/** The record for a top-level session that lives in this project, or null. */
async function liveSession(ctx, sessionID, dir) {
  if (!sessionID || typeof ctx?.session?.get !== 'function') return null;
  const fetched = await ctx.session.get({ sessionID });
  const record = fetched?.data ?? fetched;
  if (!record || typeof record !== 'object' || record.id !== sessionID) return null;
  if (typeof record.parentID === 'string' && record.parentID) return null;
  const where = record.location?.directory || record.directory;
  if (!where || !sameDir(where, dir)) return null;
  if (!fs.existsSync(path.join(where, '.stack'))) return null;
  return record;
}

/** Receipt, then a parked override, then the activity the caller reports. */
function targetStatus(dir, sessionID, activity) {
  if (closeState(dir).length === 0) return 'done';
  if (overrideOf(dir, sessionID) === 'parked') return 'parked';
  return activity === 'working' ? 'active' : 'parked';
}

/** Write the computed prefix, and never write when it is already there. */
async function applyTitle(ctx, dir, sessionID, status, record = null) {
  if (typeof ctx?.session?.update !== 'function') return false;
  const live = record || (await liveSession(ctx, sessionID, dir));
  if (!live) return false;
  const current = typeof live.title === 'string' ? live.title : '';
  // An empty title means the host has not named the session yet: writing a bare
  // prefix here would beat its auto-title. The first session.renamed prefixes it.
  if (!stripStatus(current)) return false;
  const next = withStatus(current, status);
  if (next === current) return false;
  await ctx.session.update({ sessionID, title: next });
  if (status === 'done') setOverride(dir, sessionID, null);
  return true;
}

const nudged = new Set();

/** One synthetic message per session, head and subject; the session gets one nudge, not a loop. */
async function nudge(ctx, dir, sessionID, subject, text) {
  if (typeof ctx?.session?.synthetic !== 'function') return false;
  const key = `${sessionID}:${head(dir) || 'no-head'}:${subject}`;
  if (nudged.has(key)) return false;
  if (nudged.size > 512) nudged.clear();
  nudged.add(key);
  await ctx.session.synthetic({ sessionID, text, metadata: { [NUDGE_META]: subject } });
  return true;
}

/** The open tickets the close would refuse on, named for the model. */
async function closeTickets(dir) {
  try {
    const pre = await preflight(dir, { atlas: false });
    if (!pre.blockers.length) return ['every blocker was cleared, but the ceremony never wrote a GO receipt'];
    const shown = pre.blockers.slice(0, 4);
    if (pre.blockers.length > shown.length) shown.push(`+${pre.blockers.length - shown.length} more ticket(s)`);
    return shown;
  } catch (err) {
    note('preflight for the nudge failed:', err?.message || err);
    return closeState(dir);
  }
}

async function nudgeMissingClose(ctx, dir, sessionID) {
  const tickets = await closeTickets(dir);
  return nudge(
    ctx,
    dir,
    sessionID,
    'close',
    `[oc-stacked] The close turn ended without a GO receipt. ${tickets.join(' ')} Run stack_close op=preflight, settle each one, then stack_close op=run with one lesson; the plugin sets [done], not the title.`,
  );
}

/** Drop every trace of a deleted session from this project's stores. */
function forgetSession(dir, sessionID) {
  setOverride(dir, sessionID, null);
  clearIntent(dir, sessionID);
  for (const key of [...nudged]) {
    if (key.startsWith(`${sessionID}:`)) nudged.delete(key);
  }
}

async function onTitleEvent(ctx, dir, event) {
  const type = event?.type;
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const sessionID = data.sessionID || event?.sessionID;
  if (!sessionID) return;

  if (type === 'session.deleted') {
    // The record may already be gone, so this is the one path that does not
    // read it. Only this project's stores are cleaned, and only for this dir.
    const where = event?.location?.directory;
    if (where && !sameDir(where, dir)) return;
    forgetSession(dir, sessionID);
    return;
  }

  const record = await liveSession(ctx, sessionID, dir);
  if (!record) return;

  if (type === 'session.created') {
    // A new top-level session starts active. Without a title yet there is
    // nothing to prefix; the first session.renamed does it.
    if (typeof data.title === 'string' && data.title) {
      record.title = data.title; // the event is newer than the read
      await applyTitle(ctx, dir, sessionID, 'active', record);
    }
    return;
  }

  if (type === 'session.renamed') {
    const title = typeof data.title === 'string' ? data.title : record.title;
    const claimed = statusOf(title);
    if (typeof data.title === 'string' && data.title) record.title = data.title;
    const valid = closeState(dir).length === 0;
    if (claimed === 'done' && !valid) {
      // The gate already refused the tool; a rename from any other surface
      // lands here. Park it and say once what is missing.
      await applyTitle(ctx, dir, sessionID, 'parked', record);
      await nudgeMissingClose(ctx, dir, sessionID);
      return;
    }
    // A parked claim stands while nothing is sealed; a GO outranks it.
    if (claimed === 'parked' && !valid) return;
    await applyTitle(ctx, dir, sessionID, valid ? 'done' : overrideOf(dir, sessionID) === 'parked' ? 'parked' : 'active', record);
    return;
  }

  if (type === 'session.execution.started') {
    // A new turn means the old GO no longer describes this tree.
    if (closeState(dir).length === 0) {
      try {
        invalidateClose(dir, 'a new turn started');
      } catch (err) {
        note('close invalidation failed:', err?.message || err);
      }
    }
    await applyTitle(ctx, dir, sessionID, targetStatus(dir, sessionID, 'working'), record);
    return;
  }

  if (type === 'session.execution.failed' || type === 'session.execution.interrupted') {
    // An Esc or a failed turn is a halt, not a pause: drop the close intent so a
    // later idle cannot resume the ceremony, and park the session.
    clearIntent(dir, sessionID);
    await applyTitle(ctx, dir, sessionID, 'parked', record);
    return;
  }

  if (type === 'session.execution.succeeded') {
    // The stop gate lives in experimental.idle, which runs before the turn can
    // end. Nothing is injected here: a post-hoc nudge would start a fresh
    // execution instead of continuing this one.
    await applyTitle(ctx, dir, sessionID, targetStatus(dir, sessionID, 'rest'), record);
  }
}

/**
 * The stop gate. `experimental.idle` runs just before the session would go
 * idle, and input admitted here continues the same execution - so an open
 * close intent is re-stated here, not after the turn is already over.
 */
async function onIdle(ctx, dir, event) {
  const sessionID = event?.sessionID;
  if (!sessionID) return;
  const record = await liveSession(ctx, sessionID, dir);
  if (!record) return;

  const intent = intentFor(dir, sessionID);
  const open = Boolean(intent);
  const valid = closeState(dir).length === 0;

  // 1. A GO receipt exists but the close is still open: the turn may only end
  //    with the seal token inside the brief report - never a bare token.
  if (open && valid) {
    const token = sealToken(dir);
    const last = await lastAssistantText(ctx, sessionID);
    if (!token || sealReport(last, token)) {
      await applyTitle(ctx, dir, sessionID, 'done', record);
      clearIntent(dir, sessionID);
      return;
    }
    if (intent.attempts >= CLOSE_CAP) {
      await exhaust(ctx, dir, sessionID, record, [`the final message never carried \`${token}\``]);
      return;
    }
    writeIntent(dir, sessionID, { ...intent, attempts: intent.attempts + 1, at: new Date().toISOString(), head: head(dir) });
    await applyTitle(ctx, dir, sessionID, 'active', record);
    await ctx.session.synthetic({
      sessionID,
      text: `The receipt is sealed at ${token.slice('SEALED '.length)}. Write the final report and closing remarks now, ending with \`${token}\`. No tools after.`,
      metadata: { [NUDGE_META]: 'seal' },
    });
    return;
  }

  // 2. The close is open and nothing is sealed: re-state the open tickets, or
  //    the one command that seals, until the cap parks the session.
  if (open) {
    if (intent.attempts >= CLOSE_CAP) {
      const tickets = await closeTickets(dir);
      await exhaust(ctx, dir, sessionID, record, tickets);
      return;
    }
    const pre = await preflight(dir, { atlas: false });
    writeIntent(dir, sessionID, { ...intent, attempts: intent.attempts + 1, at: new Date().toISOString(), head: head(dir) });
    const text = pre.blockers.length
      ? `Close is blocked on ${pre.blockers.length} ticket(s): ${ticketsLine(pre.blockers)}. Settle each - land, kill, answer, or record an ASK and park - then run stack_close op=preflight again. Do not reply done.`
      : `Preflight is clear. Run stack_close op=run lesson="<one sentence>" now. Do not reply done.`;
    await applyTitle(ctx, dir, sessionID, 'active', record);
    await ctx.session.synthetic({ sessionID, text, metadata: { [NUDGE_META]: 'close' } });
    return;
  }

  // 3. No close intent: the ordinary at-rest transition.
  await applyTitle(ctx, dir, sessionID, targetStatus(dir, sessionID, 'rest'), record);
}

/**
 * The prompt is where the owner says what they want in words. The hook appends
 * one block and records the intent; the loop itself lives in the idle gate.
 */
async function onPrompt(ctx, dir, event) {
  const sessionID = event?.sessionID;
  const prompt = event?.prompt;
  if (!sessionID || !prompt || typeof prompt.text !== 'string') return;
  const said = prompt.text;
  // Our own synthetic messages are not the owner's intent, whether or not the
  // host carries their metadata through to this hook.
  if (event?.metadata?.[NUDGE_META] || SYNTHETIC_MARKS.some((mark) => said.trimStart().startsWith(mark))) return;
  const record = await liveSession(ctx, sessionID, dir);
  if (!record) return;

  // The block carries its own intent, so a second pass over the same text
  // cannot read "CLOSE INTENT." as a resume and undo it.
  const intent = said.includes('CLOSE INTENT.') ? 'close' : said.includes('PARK INTENT.') ? 'park' : intentOf(said);

  if (intent === 'close') {
    if (!said.includes('CLOSE INTENT.')) prompt.text = `${said}\n\n${CLOSE_INTENT}`;
    setOverride(dir, sessionID, 'closing');
    writeIntent(dir, sessionID, { attempts: 0, at: new Date().toISOString(), head: head(dir) });
    await applyTitle(ctx, dir, sessionID, targetStatus(dir, sessionID, 'working'), record);
    return;
  }
  if (intent === 'park') {
    if (!said.includes('PARK INTENT.')) prompt.text = `${said}\n\n${PARK_INTENT}`;
    clearIntent(dir, sessionID);
    setOverride(dir, sessionID, 'parked');
    await applyTitle(ctx, dir, sessionID, targetStatus(dir, sessionID, 'rest'), record);
    return;
  }
  clearIntent(dir, sessionID);
  setOverride(dir, sessionID, null);
  await applyTitle(ctx, dir, sessionID, targetStatus(dir, sessionID, 'working'), record);
}

/** The gate: `[done]` is refused without a GO receipt, and every other rename is normalized. */
async function beforeTool(ctx, dir, event) {
  if (!RENAME_TOOLS.has(event?.tool)) return;
  const input = event?.input;
  if (!input || typeof input !== 'object' || typeof input.title !== 'string' || !input.title) return;
  const sessionID = event?.sessionID;
  if (!sessionID) return;

  let refusal = null;
  try {
    if (!(await liveSession(ctx, sessionID, dir))) return;
    const reasons = closeState(dir);
    if (statusOf(input.title) === 'done' && reasons.length) {
      refusal = `[oc-stacked] [done] refused: ${reasons.join('; ')}. Run stack_close op=run lesson="..." and let the plugin set the prefix.`;
    } else {
      // While a close is open, only the idle gate may apply [done]: the turn
      // still owes the final report and the seal token.
      const status = intentFor(dir, sessionID) ? 'active' : targetStatus(dir, sessionID, 'working');
      input.title = withStatus(input.title, status);
    }
  } catch (err) {
    note('rename gate failed:', err?.message || err);
  }
  if (refusal) throw new Error(refusal);
}

async function afterTool(ctx, dir, event) {
  const tool = event?.tool;
  if (typeof tool !== 'string') return;
  const isRename = RENAME_TOOLS.has(tool);
  if (!isRename && !tool.startsWith('stack_')) return;
  const sessionID = event?.sessionID;
  if (!sessionID) return;
  const record = await liveSession(ctx, sessionID, dir);
  if (!record) return;
  // Only onIdle may apply [done], after the seal token. A rename was already
  // normalised by the gate, so this hook leaves it alone; any other stack_* tool
  // leaves the session working - [active], or [parked] under the owner's hold.
  if (isRename) return;
  const status = overrideOf(dir, sessionID) === 'parked' ? 'parked' : 'active';
  await applyTitle(ctx, dir, sessionID, status, record);
}

/** The event loop, started by setup and stopped by the cleanup it returns. */
function startStatusEvents(ctx, dir) {
  if (typeof ctx?.event?.subscribe !== 'function') return null;
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal, types: STATUS_EVENTS })) {
        try {
          await onTitleEvent(ctx, dir, event);
        } catch (err) {
          note('title event failed:', err?.message || err);
        }
      }
    } catch (err) {
      note('title subscription failed:', err?.message || err);
    }
  })();
  return () => controller.abort();
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

  // The live status: hooks where the host offers them, and the event loop when
  // it offers a subscription. Every registration is contained; a host without
  // one of these surfaces loses that transition, never the plugin.
  const cleanups = [];
  if (typeof ctx?.tool?.hook === 'function') {
    for (const [name, handler] of [
      ['execute.before', beforeTool],
      ['execute.after', afterTool],
    ]) {
      try {
        await ctx.tool.hook(name, (event) => handler(ctx, dir, event));
      } catch (err) {
        note(`tool hook "${name}" registration failed:`, err?.message || err);
      }
    }
  }
  for (const [name, handler] of [
    ['prompt', onPrompt],
    ['experimental.idle', onIdle],
  ]) {
    try {
      await ctx.session.hook(name, (event) => handler(ctx, dir, event));
    } catch (err) {
      note(`session hook "${name}" registration failed:`, err?.message || err);
    }
  }
  const stopEvents = startStatusEvents(ctx, dir);
  if (stopEvents) cleanups.push(stopEvents);

  // Surface readiness to the console once, so a headless smoke test can see it.
  if (DEBUG) {
    try {
      fs.appendFileSync(path.join(dir, '.stack', 'plugin.log'), `${new Date().toISOString()} ready\n`);
    } catch {
      /* the project may be read-only; never fail setup for a log line */
    }
  }

  return () => {
    for (const stop of cleanups) {
      try {
        stop();
      } catch (err) {
        note('status cleanup failed:', err?.message || err);
      }
    }
  };
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
