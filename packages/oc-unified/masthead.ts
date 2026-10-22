// ═══════════════════════════════════════════════════════════════════════════
//  oc-unified - the title renamer feature.
//  (moved from plugins/oc-masthead/title.ts + plugins/oc-masthead/index.ts)
//
//  SECTION 1 is the pure title rules (formerly title.ts): no host imports and
//  no I/O, so every rule is exercised headlessly in fixtures/run.ts.
//  SECTION 2 is the event wiring, the RPC registration, and the durable counter
//  behind the fallback path's `untitled <N>` label (formerly index.ts).
// ═══════════════════════════════════════════════════════════════════════════

// Pure title rules: state and configuration in, one normalized title out.
// This section has no host imports or I/O, so every rule is exercised headlessly.
//
// VOCABULARY. The status/seat vocabularies live in CONFIG (`masthead.statuses`
// / `masthead.seats` / `masthead.legacySeats` / `masthead.fallbackSeat`), and
// the neutral default is EMPTY: with no configured vocabulary the grammar
// matchers below match nothing (observe-only - no enforced grammar until
// configured). A tree that keeps `<status> <seat>: <work>` titles carries its
// vocabulary in its own config file; nothing harness-specific ships here.

export type Status = string;
export type Seat = string;

export const FALLBACK_WORK = 'untitled';
// An issued sequence label, `untitled <N>`: FALLBACK_WORK's literal plus the
// number oc-masthead's durable counter hands out. It is the placeholder, never
// work: it does not pin a session's title, and real work still heals it.
export const FALLBACK_LABEL_RE = /^untitled \d+$/;
export function isFallbackLabel(value: unknown): boolean {
  const text = String(value ?? '').trim().toLowerCase();
  return text === FALLBACK_WORK || FALLBACK_LABEL_RE.test(text);
}
export const WORK_SOURCES = ['rename', 'assistant', 'user'] as const;
export type WorkSource = (typeof WORK_SOURCES)[number];

export type TitleConfig = {
  statuses: readonly string[];
  seats: readonly string[];
  legacySeats: readonly string[];
  fallbackSeat: string;
  template: string;
  lowercase: boolean;
  maxWork: number;
  snippetLength: number;
  workSource: readonly WorkSource[];
};

// Neutral defaults: EMPTY vocabularies (observe-only - no enforced grammar
// until configured). `fallbackSeat` names the seat used when no agent is
// known; `template`, `lowercase`, `maxWork`, and `snippetLength` are generic
// rendering knobs with the historical values.
export const DEFAULT_TITLE_CONFIG: TitleConfig = {
  statuses: [],
  seats: [],
  legacySeats: [],
  fallbackSeat: 'general',
  template: '{status} {seat}: {work}',
  lowercase: true,
  maxWork: 6,
  snippetLength: 60,
  workSource: WORK_SOURCES,
};

// Merge and validate the JSONC surface. The file is valid JSON (a JSONC subset),
// and every absent or malformed key falls back independently to today's values.
export function mergeTitleConfig(value: unknown): TitleConfig {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const strings = (candidate: unknown, fallback: readonly string[]) => {
    if (!Array.isArray(candidate)) return fallback;
    const accepted = candidate.filter(
      (item): item is string =>
        typeof item === 'string' && /^[a-z][a-z-]*$/i.test(item.trim()),
    );
    return accepted.length ? accepted.map((item) => item.trim().toLowerCase()) : fallback;
  };
  const sources = Array.isArray(raw.workSource)
    ? [...new Set(raw.workSource.filter((item): item is WorkSource =>
        typeof item === 'string' && (WORK_SOURCES as readonly string[]).includes(item),
      ))]
    : [...WORK_SOURCES];

  return {
    statuses: strings(raw.statuses, []),
    seats: strings(raw.seats, []),
    legacySeats: strings(raw.legacySeats, []),
    fallbackSeat:
      typeof raw.fallbackSeat === 'string' && raw.fallbackSeat.trim()
        ? raw.fallbackSeat.trim()
        : DEFAULT_TITLE_CONFIG.fallbackSeat,
    template:
      typeof raw.template === 'string' && raw.template.trim()
        ? raw.template
        : DEFAULT_TITLE_CONFIG.template,
    lowercase:
      typeof raw.lowercase === 'boolean'
        ? raw.lowercase
        : DEFAULT_TITLE_CONFIG.lowercase,
    maxWork:
      typeof raw.maxWork === 'number' && Number.isFinite(raw.maxWork)
        ? Math.max(1, Math.floor(raw.maxWork))
        : DEFAULT_TITLE_CONFIG.maxWork,
    snippetLength:
      typeof raw.snippetLength === 'number' && Number.isFinite(raw.snippetLength)
        ? Math.max(3, Math.floor(raw.snippetLength))
        : DEFAULT_TITLE_CONFIG.snippetLength,
    workSource: sources.length ? sources : WORK_SOURCES,
  };
}

const LEADING_SEAT = /^([A-Za-z][A-Za-z-]*):\s+/;

// A title or work candidate that arrives from a JSON-string body (the host
// delivers some RPC bodies as JSON text) is quote-wrapped: `"done fleet: x"`, or
// its escaped form `\"done fleet: x\"`. Left alone, the wrapper hides the status
// token from the grammar and turns the whole previous title into the work label.
// Unwrap only the outer layers; the interior text passes through byte-identical.
export function unwrapQuoted(value: unknown): string {
  let text = String(value ?? '').trim();
  for (let guard = 0; guard < 4; guard += 1) {
    const match = /^\\?"([\s\S]*?)\\?"$/.exec(text);
    if (!match) break;
    const inner = match[1]!;
    // An unescaped inner quote means this is not a single JSON string: leave it.
    if (!inner || /(^|[^\\])"/.test(inner)) break;
    text = inner.replace(/\\(["\\])/g, '$1').trim();
  }
  return text;
}

// The session's own state map records the truth about a close: a `close:` block
// whose `status` is `active | parked | done`, null while the session is live
// (reference/session-state.md). Read defensively: a non-string, a missing
// `close:` block, a missing or null `status`, or a token outside the vocabulary
// all return undefined, so the caller keeps its existing behaviour.
export function parseCloseStatus(text: unknown, config = DEFAULT_TITLE_CONFIG): Status | undefined {
  if (typeof text !== 'string') return undefined;
  let inClose = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^close:\s*(?:#.*)?$/.test(line)) {
      inClose = true;
      continue;
    }
    // Any other top-level key ends the block; `tasks` statuses are never read.
    if (/^\S/.test(line)) {
      inClose = false;
      continue;
    }
    if (!inClose) continue;
    const match = /^\s+status:\s*([^#\s]+)/.exec(line);
    if (!match) continue;
    const token = match[1]!.replace(/^["']|["']$/g, '').toLowerCase();
    return statusTokens(config).includes(token) ? (token as Status) : undefined;
  }
  return undefined;
}

// The exact shape a conforming title has, built from the configured status
// vocabulary. Exported for readers/fixtures. With no configured vocabulary
// this matches nothing (observe-only): use `titleRe(harnessConfig)` for a
// configured tree's shape.
export function titleRe(config = DEFAULT_TITLE_CONFIG): RegExp {
  const tokens = statusTokens(config);
  if (tokens.length === 0) return /(?!)/
  const choices = tokens
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');
  return new RegExp(`^(${choices}) [a-z][a-z0-9_-]*: .+$`);
}
export const TITLE_RE = titleRe();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function statusTokens(config: TitleConfig): string[] {
  return [...new Set(config.statuses.map((item) => item.toLowerCase()))];
}

const NEVER_MATCH = /(?!)/
function leadingStatus(config: TitleConfig): RegExp {
  const tokens = statusTokens(config);
  if (tokens.length === 0) return NEVER_MATCH;
  const choices = tokens
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');
  return new RegExp(`^(${choices})\\s+`, 'i');
}

function statusAfter(title: unknown, config: TitleConfig): Status | undefined {
  const match = String(title ?? '').trim().match(leadingStatus(config));
  return match ? (match[1]!.toLowerCase() as Status) : undefined;
}

export function isSeat(value: unknown, config = DEFAULT_TITLE_CONFIG): boolean {
  return (
    typeof value === 'string' &&
    [...config.seats, ...config.legacySeats].some((seat) => seat.toLowerCase() === value.toLowerCase())
  );
}

// The segment follows the current agent verbatim unless lowercase is configured.
export function resolveSeat(
  agent: unknown,
  config = DEFAULT_TITLE_CONFIG,
): string {
  const raw = String(agent ?? '').trim();
  return raw ? (config.lowercase ? raw.toLowerCase() : raw) : config.fallbackSeat;
}

// At least three Unicode letters or digits excludes empty, punctuation-only,
// symbol-only, and too-short work labels such as a single `.`.
export function isSubstantive(text: unknown): text is string {
  return typeof text === 'string' && (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}

export function asStatus(
  value: unknown,
  config = DEFAULT_TITLE_CONFIG,
): Status | undefined {
  if (typeof value !== 'string') return undefined;
  const token = value.trim().toLowerCase();
  return statusTokens(config).includes(token) ? (token as Status) : undefined;
}

// Parse the title's own status to keep terminal state from falling back to active.
export function parseStatus(
  title: unknown,
  config = DEFAULT_TITLE_CONFIG,
): Status | undefined {
  return statusAfter(unwrapQuoted(title), config);
}

export function resolveStatus(
  hasMessages: boolean,
  statusHint?: unknown,
  config = DEFAULT_TITLE_CONFIG,
): Status {
  // An explicit valid hint wins; else the first configured status (a tree's
  // vocabulary leads with its own live token); else a generic last resort.
  return asStatus(statusHint, config) ?? config.statuses[0] ?? 'active';
}

export type NormalizeInput = {
  title?: string | null;
  agent?: string | null;
  hasMessages?: boolean;
  /** Explicit agent-supplied rename candidate. */
  rename?: string | null;
  /** The session's first substantive assistant text. */
  assistant?: string | null;
  /** The session's last substantive user text. */
  user?: string | null;
  /** Backward-compatible alias for a user prompt snippet. */
  snippet?: string | null;
  /** Explicit status signal (completion/status event, live session state). */
  status?: string | null;
  /** Issued fallback label (`untitled <N>`) for a session with no derivable
   *  work; absent on every other path. */
  fallbackWork?: string | null;
};

// Whether the renamer enforces anything at all: a configured status
// vocabulary means a grammar to keep, an empty one means observe-only (no
// renames until configured). Exported for readers/fixtures.
export function isEnforcingConfig(config = DEFAULT_TITLE_CONFIG): boolean {
  return statusTokens(config).length > 0;
}

function stripTitlePrefix(
  value: unknown,
  agent: unknown,
  config: TitleConfig,
): string {
  let rest = unwrapQuoted(value);
  // Repeat: unwrapping a quote-wrapped title exposes a second status/seat
  // prefix (`active fleet: "done fleet: x"` -> `x`), so the label is never a
  // duplicate of the previous title.
  for (let guard = 0; guard < 3; guard += 1) {
    const before = rest;
    const status = leadingStatus(config);
    while (status.test(rest)) rest = rest.replace(status, '').trim();
    const seatMatch = rest.match(LEADING_SEAT);
    if (seatMatch) {
      const token = seatMatch[1]!.toLowerCase();
      if (token === resolveSeat(agent, config).toLowerCase() || isSeat(token, config))
        rest = rest.slice(seatMatch[0].length).trim();
    }
    rest = unwrapQuoted(rest);
    if (rest === before) break;
  }
  return rest;
}

// A title the session already owns: `<status> <seat>: <work>` with substantive
// work. This is the pin test, and it is deliberately looser than a byte-equal
// comparison: a terminal status healed from the recorded map, or a body that
// arrived quote-wrapped, leaves the work segment intact while the prefix differs,
// and the work segment is the only thing a pin protects. A bare host auto-title
// is not in the grammar and never pins, so a prompt still fills its label.
export function isGrammarTitle(
  value: unknown,
  agent: unknown,
  config = DEFAULT_TITLE_CONFIG,
): boolean {
  const text = unwrapQuoted(value);
  if (!statusAfter(text, config)) return false;
  if (!LEADING_SEAT.test(text.replace(leadingStatus(config), '').trim())) return false;
  const work = stripTitlePrefix(text, agent, config);
  return isSubstantive(work) && !isFallbackLabel(work);
}

// Leading markdown and emoji/pictograph/symbol noise never becomes the work
// label. Only the lead is cleaned - interior text passes through byte-identical
// - and ordinary leading words or digits (e.g. "42 sessions idle") are kept.
export function stripWorkNoise(text: string): string {
  let rest = String(text ?? '').trim();
  for (;;) {
    const before = rest;
    // Ordered-list ("1. ", "1) ") and task-list ("[ ] ", "[x] ") markers.
    rest = rest.replace(/^(?:\d{1,9}[.)]\s+|\[(?:\s|x|X)\]\s*)/, '');
    // Block markers: ATX headings, quotes, bullets, fences.
    rest = rest.replace(/^(?:#{1,6}(?=\s)\s*|>{1,}\s*|[-+*](?=\s)\s+|`{1,3}\s*|~{2,}\s*)/, '');
    // A leading span wrapped in emphasis/code markers is formatting noise when
    // more text follows it; when it wraps the whole string, keep its words.
    const span = rest.match(
      /^(?:\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|``([\s\S]+?)``|`([^`]+?)`|\*([^*\n]+?)\*|_([^_\n]+?)_)([\s\S]*)$/,
    );
    if (span) {
      const inner = (span[1] ?? span[2] ?? span[3] ?? span[4] ?? span[5] ?? span[6] ?? span[7] ?? '').trim();
      const after = (span[8] ?? '').trim();
      rest = after ? after : inner;
    }
    // Stray emphasis runs left at the lead (e.g. an unclosed "**").
    rest = rest.replace(/^([*_~`]+)(?=\s|$)/, '');
    // Leading emoji, pictographs, and symbols, plus the glue they leave behind
    // (variation selectors, ZWJ, format characters).
    rest = rest.replace(/^[\p{Extended_Pictographic}\p{M}\p{S}\p{Cf}]+/u, '');
    rest = rest.trimStart();
    if (rest === before) return rest;
  }
}

function capWork(text: string, config: TitleConfig): string {
  const words = text.trim().split(/\s+/).slice(0, config.maxWork).join(' ');
  const clipped = words.slice(0, config.snippetLength).trim();
  return config.lowercase ? clipped.toLowerCase() : clipped;
}

// Source order is configurable. The pin is not: a conforming rename the session
// already owns outranks a user-prompt snippet unconditionally, so a later prompt
// is the fallback, never the replacement. The initial title remains a
// compatibility fallback, and never outranks assistant or user text.
export function workFrom(
  input: NormalizeInput,
  config = DEFAULT_TITLE_CONFIG,
): string {
  const candidates: Record<WorkSource, unknown> = {
    rename: input.rename,
    assistant: input.assistant,
    user: input.user ?? input.snippet,
  };
  const pick = (source: WorkSource): string | undefined => {
    const raw = candidates[source];
    const cleaned =
      source === 'rename'
        ? stripTitlePrefix(raw, input.agent, config)
        : String(raw ?? '').trim();
    const text = unwrapQuoted(stripWorkNoise(cleaned));
    if (!isSubstantive(text)) return undefined;
    const capped = capWork(text, config);
    return isSubstantive(capped) ? capped : undefined;
  };

  if (config.workSource.includes('rename')) {
    const pinned = pick('rename');
    if (pinned) return pinned;
  }
  for (const source of config.workSource) {
    if (source === 'rename') continue;
    const text = pick(source);
    if (text) return text;
  }

  const legacy = unwrapQuoted(stripTitlePrefix(input.title, input.agent, config));
  if (!isFallbackLabel(legacy) && isSubstantive(legacy)) {
    const capped = capWork(legacy, config);
    if (isSubstantive(capped)) return capped;
  }
  // With no derivable work: the caller's issued label (`untitled <N>`) is
  // rendered in the same template; absent one, the bare literal is the
  // degradation path. `fallbackWork` is a value, never I/O - this rule stays
  // pure and headless.
  const issued = capWork(unwrapQuoted(String(input.fallbackWork ?? '').trim()), config);
  return isSubstantive(issued) ? issued : FALLBACK_WORK;
}

export function normalizeTitle(
  input: NormalizeInput,
  config = DEFAULT_TITLE_CONFIG,
): string {
  const status = resolveStatus(Boolean(input.hasMessages), input.status, config);
  const seat = resolveSeat(input.agent, config);
  const values = { status, seat, work: workFrom(input, config) };
  const result = config.template.replace(/\{(status|seat|work)\}/g, (_all, key: keyof typeof values) => values[key]);
  return config.lowercase ? result.toLowerCase() : result;
}

// Byte-equal no-op guard; a conforming rename never triggers a second write.
export function isConforming(
  input: NormalizeInput,
  config = DEFAULT_TITLE_CONFIG,
): boolean {
  return String(input.title ?? '') === normalizeTitle(input, config);
}


// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 2 - event wiring (formerly plugins/oc-masthead/index.ts).
//
//  Keeps every top-level session title in the configured grammar
//  (default `<status> <seat>: <work>`; see `masthead.statuses` /
//  `masthead.seats` / `masthead.template`). With no configured status
//  vocabulary the renamer is observe-only: events are tracked but no rename
//  is ever issued, so an unconfigured tree is untouched until configured.
//
//  The title rules live in section 1 (pure, headless); this
//  section is the event wiring, plus the durable counter behind the fallback
//  path's `untitled <N>` label (see the section header below).
//
// Shape: an exported async `setupMasthead(ctx)` returning a disposer, wired by
// index.ts into the single oc-unified plugin.
//
// LOOP GUARD (mandatory): external `session.renamed` events feed the work source;
// this plugin's own titles are tracked and ignored. Independently, a conforming
// title is a byte-equal no-op. Both behaviors are proven in fixtures/run.ts.
//
// TOP-LEVEL ONLY: subagent/child sessions are never renamed - the grammar is
// for top-level sessions. A child is identified by its `parentID` (absent on a
// top-level session); once seen it is cached and skipped for the rest of the
// process, and never counts a correction.
//
// It also tracks corrections (count, lastCorrectionAt) on a shared slot and
// registers the `oc-masthead` snapshot RPC. The RPC keeps its own id: a
// distinct RPC id coexists with any other. The counter increments only on a
// successful rename, so it can never drift from what the renamer actually did.
// ═══════════════════════════════════════════════════════════════════════════

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mastheadBlock } from './config.ts';
import type { Plugin } from '@opencode/plugin';

const CLAIM = '__ocMasthead';

// Prompt-side events that mean "this session now has a message". `step.started`
// carries the agent the creation event may have lacked.
const PROMPT_EVENTS = new Set([
  'session.inbox.enqueued',
  'session.execution.started',
  'session.step.started',
]);

// Terminal/status signals. Best-effort names only - the host's completion
// event inventory is unverified, so the `data.status` / live-state / on-disk
// fallbacks below carry the guarantee and these keys are one more hint.
const STATUS_EVENTS: Record<string, string> = {
  'session.completed': 'done',
  'session.failed': 'parked',
  'session.error': 'parked',
  'session.idle': 'parked',
  'session.closed': 'done',
};

// A child (subagent) session is never renamed: only top-level sessions own the
// `<status> <seat>: <work>` grammar. `session.created` carries the parent as
// `data.parentID` (the host's SessionCreated.data.parentID); a non-empty value
// marks the session a child permanently, so later events skip it with no
// further read. The prompt events carry no parent, so a child first observed on
// one is caught in `settle` from the session object it already fetches.
function hasParent(parentID: unknown): boolean {
  return typeof parentID === 'string' && parentID !== '';
}

// The title configuration comes from the shared config's `masthead` block,
// resolved by config.ts. An absent block or an unreadable file leaves the
// documented defaults in place - exactly the defaulting title.jsonc had.
function loadTitleConfig(options?: Readonly<Record<string, unknown>>) {
  const block = mastheadBlock(undefined, options);
  return block ? mergeTitleConfig(block) : DEFAULT_TITLE_CONFIG;
}

// The session's own state map is the recorded truth about whether it closed
// (`close.status`; `reference/session-state.md`): a terminal value there must
// never be overwritten by a derivation that falls back to `active`. Read
// defensively - a missing file, an unreadable path, a malformed map, or a
// missing/`null` key returns undefined and leaves today's behaviour in place,
// never a throw and never a latch.
function recordedCloseStatus(sessionID: string, config = DEFAULT_TITLE_CONFIG) {
  try {
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) return undefined;
    const path = join(
      homedir(),
      '.local',
      'state',
      'opencode',
      'sessions',
      sessionID,
      'session-state.yaml',
    );
    return parseCloseStatus(readFileSync(path, 'utf8'), config);
  } catch {
    return undefined;
  }
}

// Degradation note for the untitled counter, in the family's diagnostics idiom
// (plugins/oc-fleet/index.ts): one timestamped line appended under the temp
// lane, never in the state root. Diagnostics must never take the renamer down,
// so every failure is swallowed and nothing is thrown into the event loop.
const NOTE_DIR = join(tmpdir(), 'opencode', 'oc-masthead');

function note(tag: string): void {
  try {
    mkdirSync(NOTE_DIR, { recursive: true });
    appendFileSync(join(NOTE_DIR, 'notes.log'), `${tag} ${new Date().toISOString()}\n`);
  } catch {
    // a failed note is never fatal
  }
}

// ---------------------------------------------------------------------------
// Untitled fallback counter
// ---------------------------------------------------------------------------
// Durable numbering for the fallback path ONLY. A session whose work cannot be
// derived is titled inside the normal template with an issued label
// `untitled <N>`, N monotonically increasing and never reissued. The store is a
// small JSON file under the harness state root
// (%USERPROFILE%\.local\state\opencode\oc-masthead\) - deliberately NOT under
// %TEMP%: the aged-temp-junk lane deletes that and would restart numbering.
//
// Every read-modify-write holds an exclusive lock in the state root's locks\
// directory, the idiom scripts/scribe.ps1 uses (exclusive open, bounded retry,
// release). FIRST USE is distinguished from a LOST FILE: when the store file is
// ABSENT, nothing was ever issued, so the first allocation creates it (seeded at
// seq 0) inside the same critical section and issues 1 - no number can be
// reissued. A store that EXISTS but is corrupt, unreadable, or unwritable
// degrades to undefined and the caller keeps the bare `untitled` literal: a
// number is NEVER guessed - losing the store must not restart the sequence at 1.
//
// Lives here rather than in its own module: harness-doctor check 5 reads a new
// plugins/oc-masthead/*.ts as an orphan unless a live markdown doc names it,
// and this unit's docs are out of this change's scope.

const LOCK_RETRIES = 100;
const LOCK_DELAY_MS = 20;
const LOCK_STALE_MS = 30_000;

// Resolve the state root per call, so a caller that redirects USERPROFILE (the
// fixture, for one) is honoured rather than a value baked at module load.
function homeDir(): string {
  const env = String(process.env.USERPROFILE ?? '').trim();
  return env || homedir();
}

function counterDir(): string {
  return join(homeDir(), '.local', 'state', 'opencode', 'oc-masthead');
}

export function counterPath(): string {
  return join(counterDir(), 'untitled.json');
}

function lockDir(): string {
  return join(homeDir(), '.local', 'state', 'opencode', 'locks');
}

function lockPath(): string {
  return join(lockDir(), 'oc-masthead-untitled.lock');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lockIsStale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// Exclusive-create lock (scribe.ps1's FileShare::None idiom in node terms): a
// second holder's open fails, so the read-modify-write below can never
// interleave. Bounded retry, plus a stale-lock takeover so a crashed holder
// cannot wedge numbering forever. Undefined means the lock could not be taken.
async function acquireLock(): Promise<number | undefined> {
  try {
    mkdirSync(lockDir(), { recursive: true });
  } catch {
    return undefined;
  }
  const path = lockPath();
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    try {
      return openSync(path, 'wx');
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') return undefined;
      if (lockIsStale(path)) {
        try {
          unlinkSync(path);
        } catch {
          // another holder released it first
        }
        continue;
      }
      if (attempt === LOCK_RETRIES) return undefined;
      await sleep(LOCK_DELAY_MS);
    }
  }
  return undefined;
}

function releaseLock(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
  try {
    unlinkSync(lockPath());
  } catch {
    // already gone
  }
}

// The last issued number, or undefined when the store is absent or corrupt.
// Every failure mode (missing file, unreadable path, malformed document,
// missing/negative/non-integer `seq`) is the same verdict: never guess.
function readCounter(): number | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(counterPath(), 'utf8'));
    const seq =
      parsed && typeof parsed === 'object'
        ? (parsed as { seq?: unknown }).seq
        : undefined;
    return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0
      ? seq
      : undefined;
  } catch {
    return undefined;
  }
}

// True only when the store file does not exist at all (ENOENT) - the first-use
// signal. Any other failure is a store that EXISTS in some unusable shape (a
// permission error, a blocked path (ENOTDIR), a directory where the file
// belongs) and must degrade, never seed.
function storeAbsent(): boolean {
  try {
    statSync(counterPath());
    return false;
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT';
  }
}

// Atomic write: a temp sibling plus rename, so a reader never sees a partial
// document. Throws on any failure; the caller degrades.
function writeCounter(value: number): void {
  mkdirSync(counterDir(), { recursive: true });
  const tmp = join(counterDir(), `.untitled-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ seq: value })}\n`, 'utf8');
  renameSync(tmp, counterPath());
}

// Allocate the next number. Undefined is the degraded verdict (bare
// `untitled`): the lock could not be taken, or the store is corrupt or
// unwritable. An ABSENT store is first use, not degradation: nothing was ever
// issued, so the store is created (seeded at 0) and 1 is issued, both inside
// the lock already held - the seed and the first issue cannot be interleaved.
export async function allocateUntitled(): Promise<number | undefined> {
  const lock = await acquireLock();
  if (lock === undefined) return undefined;
  try {
    let current = readCounter();
    if (current === undefined) {
      if (!storeAbsent()) return undefined;
      writeCounter(0);
      current = 0;
    }
    const next = current + 1;
    writeCounter(next);
    return next;
  } catch {
    return undefined;
  } finally {
    releaseLock(lock);
  }
}

// Inbox items are either a plain string or `{ type, payload: { text } }`.
// Ignore non-user items and unknown shapes instead of stringifying them.
function userText(item: unknown): string | undefined {
  let raw: unknown;
  if (typeof item === 'string') {
    raw = item;
  } else if (item && typeof item === 'object') {
    const record = item as { type?: unknown; payload?: unknown };
    if (record.type !== undefined && record.type !== 'user') return undefined;
    const payload = record.payload;
    raw =
      payload && typeof payload === 'object'
        ? (payload as { text?: unknown }).text
        : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return isSubstantive(text) ? text : undefined;
}

// Module-level RPC definition (consumed by name by another worker): the id,
// method names, and input/output shapes below are byte-identical to the
// previously inline literal.
export const mastheadRpcDefinition = {
  id: 'oc-masthead',
  methods: {
    snapshot: {
      // Any input: the handler takes none, and a strict object schema
      // would reject the CLI's JSON-string body.
      input: {},
      output: { type: 'object', additionalProperties: true },
    },
  },
  events: {},
} as const;

export async function setupMasthead(ctx: Plugin.Context): Promise<() => void> {
  const config = loadTitleConfig(ctx.options);
  const globals = globalThis as Record<PropertyKey, any>;
  const previous = globals[CLAIM];
  // The correction counter lives on the shared slot, not per-instance: the
  // snapshot RPC is registered from every location node, and all of them must
  // report the same count.
  const slot: { count: number; lastCorrectionAt: number } =
    previous?.slot ?? {
      count: 0,
      lastCorrectionAt: 0,
    };

  // Registered on EVERY instance: the plugin host is a location node, so a
  // registration made in one location is not visible from another. Every
  // handler reads the single shared slot, so any caller sees the same count.
  try {
    await ctx.rpc?.register?.(
      mastheadRpcDefinition,
      {
        snapshot: async () => ({
          mounted: true,
          count: slot.count,
          lastCorrectionAt: slot.lastCorrectionAt,
          at: Date.now(),
        }),
      },
    );
  } catch {
    // A missing RPC host must not stop the renamer.
  }

  // The host runs setup once per location (lifeline observed ~13 within
  // 100ms); a second subscription would only repeat idempotent work.
  if (previous && previous.alive) return () => {};

  const controller = new AbortController();
  // `assistant` is first-substantive; `user` is last-substantive. Own rename
  // values are held only to prevent our output being mistaken for an agent
  // rename. A child is permanent and never renamed.
  type SessionState = {
    messaged: boolean;
    agent?: string;
    child?: boolean;
    rename?: string;
    assistant?: string;
    user?: string;
    ownTitles: Set<string>;
    /** Issued fallback label, or null once allocation was attempted and the
     *  store degraded; undefined until the fallback path is first reached. */
    fallbackWork?: string | null;
  };
  const seen = new Map<string, SessionState>();
  const entryFor = (sessionID: string): SessionState => {
    let entry = seen.get(sessionID);
    if (!entry) {
      entry = { messaged: false, ownTitles: new Set() };
      seen.set(sessionID, entry);
    }
    return entry;
  };
  globals[CLAIM] = { alive: true, controller, slot };

  // Read the session, then correct the title only when it differs. The
  // read-then-compare (never a blind write) is what makes this loop-safe.
  const settle = async (
    sessionID: string,
    hasMessages: boolean,
    hint?: {
      title?: string;
      agent?: string;
      status?: string;
      renameEvent?: boolean;
    },
  ) => {
    // Observe-only until configured: with no status vocabulary there is no
    // grammar to keep, so events are tracked but never renamed.
    if (!isEnforcingConfig(config)) return;
    const entry = entryFor(sessionID);
    let current: any;
    try {
      current = await ctx.session.get({ sessionID });
    } catch {
      // Creation can still settle from its event payload; later events need
      // the live session read for parent, agent, and title state.
      if (hint?.title === undefined) return;
    }
    if (hasParent(current?.parentID)) {
      entry.child = true;
      return;
    }
    const title = hint?.title ?? String(current?.title ?? '');
    const agent =
      hint?.agent ?? entry.agent ??
      (typeof current?.agent === 'string' ? current.agent : undefined);
    if (typeof agent === 'string' && agent) entry.agent = agent;

    // Preserve an on-disk parked/done against a stale live `active` hint; a
    // newer explicit signal may still replace one parked/done with another.
    // The recorded map is the second source of truth: a session its own map
    // records as closed stays closed, so the status token never falls back to
    // `active` behind a terminal close.
    const onDisk = parseStatus(title, config);
    const recorded = asStatus(recordedCloseStatus(sessionID, config), config);
    const terminal =
      onDisk && onDisk !== 'active'
        ? onDisk
        : recorded && recorded !== 'active'
          ? recorded
          : undefined;
    const candidateStatus =
      hint?.status ??
      (hint?.renameEvent ? onDisk : undefined) ??
      asStatus(current?.status, config) ??
      asStatus(current?.state, config);
    const status =
      terminal && (!candidateStatus || candidateStatus === 'active')
        ? terminal
        : candidateStatus ?? terminal;
    const input: NormalizeInput = {
      title,
      agent,
      hasMessages: hasMessages || onDisk === 'active',
      rename: entry.rename,
      assistant: entry.assistant,
      user: entry.user,
      status,
    };
    // A substantive title that already conforms is itself a valid rename
    // source. Pin it before a later user item can displace it; `untitled`
    // remains healable by assistant or user text. The byte-equal test alone
    // misses the residual case: when the recorded map has just healed the
    // status token, or the body arrived quote-wrapped, the work segment is
    // intact while the prefix differs - so the grammar shape pins too, and the
    // work label prefers the pin over a user-prompt snippet.
    const titleOnly = { ...input, rename: undefined, assistant: undefined, user: undefined };
    if (
      !entry.rename &&
      !hint?.renameEvent &&
      workFrom(titleOnly, config) !== FALLBACK_WORK &&
      (isConforming(titleOnly, config) || isGrammarTitle(title, agent, config))
    )
      entry.rename = title;
    if (entry.rename) input.rename = entry.rename;
    if (hint?.renameEvent) {
      // A conforming agent title wins byte-for-byte even if a configured
      // source order would otherwise select assistant or user text.
      if (
        isConforming(
          {
            ...input,
            rename: entry.rename,
            assistant: undefined,
            user: undefined,
          },
          config,
        )
      )
        return;
    }
    // Fallback path ONLY: a session whose work cannot be derived receives a
    // durable sequence number and is rendered inside the same template. An
    // already-issued label is reused, so a later event is a byte-equal no-op;
    // a title that HAS derivable work never reaches here, so it consumes no
    // number. A degraded store leaves the bare `untitled` literal, noted once.
    if (workFrom(input, config) === FALLBACK_WORK) {
      if (entry.fallbackWork === undefined) {
        const issued = await allocateUntitled();
        entry.fallbackWork = issued === undefined ? null : `${FALLBACK_WORK} ${issued}`;
        if (entry.fallbackWork === null) note('untitled-counter-degraded');
      }
      if (entry.fallbackWork) input.fallbackWork = entry.fallbackWork;
    }
    if (isConforming(input, config)) return;
    const normalized = normalizeTitle(input, config);
    try {
      entry.ownTitles.add(normalized);
      await ctx.session.update({ sessionID, title: normalized });
      slot.count += 1;
      slot.lastCorrectionAt = Date.now();
    } catch {
      entry.ownTitles.delete(normalized);
      // A failed rename is not fatal: the next conforming event retries.
    }
  };

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        const type = String((event as any)?.type ?? '');
        const data: any = (event as any)?.data ?? {};
        const sessionID = String(data.sessionID ?? '');
        if (!sessionID) continue;

        // Top-level only: a known child is skipped outright (cached, never
        // re-probed), and a creation event that carries a parent marks one
        // before any rename can happen.
        const known = seen.get(sessionID);
        if (known?.child) continue;
        if (hasParent(data.parentID)) {
          const entry = entryFor(sessionID);
          entry.child = true;
          continue;
        }

        // A status signal rides `data.status`/`data.state`, or the event
        // type itself is a completion signal.
        const statusHint =
          asStatus(data.status, config) ??
          asStatus(data.state, config) ??
          STATUS_EVENTS[type];

        if (type === 'session.created') {
          const entry = entryFor(sessionID);
          if (typeof data.agent === 'string') entry.agent = data.agent;
          await settle(sessionID, false, {
            title: String(data.title ?? ''),
            agent: typeof data.agent === 'string' ? data.agent : undefined,
            status: statusHint,
          });
          continue;
        }

        const entry = entryFor(sessionID);
        const agentHint =
          typeof data.agent === 'string' ? data.agent : undefined;

        if (type === 'session.agent.selected') {
          if (agentHint) entry.agent = agentHint;
          await settle(sessionID, entry.messaged, {
            agent: agentHint,
            status: statusHint,
          });
          continue;
        }

        if (type === 'session.renamed') {
          const renamed = typeof data.title === 'string' ? data.title : '';
          if (!renamed || entry.ownTitles.delete(renamed)) continue;
          entry.rename = renamed;
          await settle(sessionID, entry.messaged, {
            title: renamed,
            status: statusHint,
            renameEvent: true,
          });
          continue;
        }

        if (type === 'session.text.ended') {
          const text = typeof data.text === 'string' ? data.text.trim() : '';
          if (!entry.assistant && isSubstantive(text)) entry.assistant = text;
          entry.messaged = true;
          await settle(sessionID, entry.messaged, { status: statusHint });
          continue;
        }

        if (!PROMPT_EVENTS.has(type) && statusHint === undefined) continue;

        if (PROMPT_EVENTS.has(type)) entry.messaged = true;
        if (agentHint) entry.agent = agentHint;
        const prompt = userText(data.item);
        if (prompt) entry.user = prompt;
        await settle(sessionID, entry.messaged, {
          agent: agentHint,
          status: statusHint,
        });
      }
    } catch {
      // the subscription ends when aborted
    }
  })();

  return () => {
    controller.abort();
    if (globals[CLAIM]?.controller === controller)
      globals[CLAIM].alive = false;
  };
}
