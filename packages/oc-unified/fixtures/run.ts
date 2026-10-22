// Fixture gate for the oc-unified plugin: ONE headless gate covering the silent
// background features - the fleet watcher (fleet.ts) and the title renamer
// (masthead.ts) - plus the shared config resolver (config.ts), the lifeline
// daemon (lifeline.ts), and the unified entry (index.ts).
//
// Runs headless under bun, both in place (`bun run fixtures/run.ts`) and in the
// plugin-prove sandbox, where plugin-prove copies the unit and this file into a
// flat directory. The dual import path covers both layouts.
//
// The harness config is STAGED, never the live file: OC_UNIFIED_CONFIG names a
// temp copy carrying a tree's `fleet` and `masthead` blocks, so a proof never
// reads the live file and never depends on how it is tuned today.
//
// This plugin claims NO display surface: Part 1 is the no-TUI invariant (no
// sidebar/channel slot, no row drawer, no render tick, no drawing primitive -
// it fails if any of that returns). Fleet parts: 1 the invariant, 2 the pure
// decision core, 3
// the policy gate and an isolated escalation append, 4-5 the live deck
// behaviour, 7 the diagnostic log cap. Title parts: 8 the pure normalizer,
// 9 the loop guard driven against a fake ctx, 10 the inbox snippet, 11
// top-level-only, 12 the status latches, 13 the durable recorded close, 14 the
// untitled counter.
//
// NOTE: assertion expectations spell no glyph codepoints: there is no row
// vocabulary left to expect - only plain background behaviour.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Every fixture artifact lives under one per-run temp directory, never in the
// package working directory. The exit handler removes it even when a check
// fails, so a gate run leaves the tree clean.
const fixtureDir = mkdtempSync(join(tmpdir(), "oc-unified-fixture-"));
process.on("exit", () => rmSync(fixtureDir, { recursive: true, force: true }));

const runID = process.env.OPENCODE_SESSION_ID ?? "standalone";
const escalationPath = resolve(fixtureDir, `oc-fleet-escalations-${runID}.jsonl`);
const markerPath = resolve(fixtureDir, `oc-fleet-marker-${runID}.log`);
process.env.OC_FLEET_STATUS = resolve(fixtureDir, `oc-fleet-status-${runID}.json`);
process.env.OC_FLEET_ESCALATIONS = escalationPath;
process.env.OC_FLEET_MARKER = markerPath;

// The shared config the unit reads, staged here with every value the two live
// units shipped, so the assertions below describe today's behaviour. The comment
// line is deliberate: it proves the JSONC pass strips comments before parsing.
const stagedConfigPath = resolve(fixtureDir, `oc-unified-config-${runID}.jsonc`);
writeFileSync(
  stagedConfigPath,
  [
    "{",
    "  // staged by the fixture - the same blocks the live units shipped",
    '  "fleet": {',
    '    "enabled": true,',
    '    "report": true,',
    '    "push": false,',
    '    "target": null,',
    '    "recipient": "nearest-ancestor",',
    '    "terminalTokens": ["done"],',
    '    "autoWatchChildren": true,',
    '    "minNoteSeconds": 300,',
    '    "noteTtlSeconds": 900,',
    '    "watch": [],',
    '    "sweepSeconds": 5,',
    '    "stallSeconds": 600,',
    '    "writeMinMs": 100,',
    '    "doneTtlSeconds": 60,',
    '    "everyTerminal": true',
    "  },",
    '  "masthead": {',
    '    "statuses": ["active", "parked", "done"],',
    '    "seats": ["fleet", "commander", "plan", "recon", "build", "ops", "vault", "scribe", "reviewer", "general", "explore"],',
    '    "legacySeats": ["fleet", "commander"],',
    '    "fallbackSeat": "fleet",',
    '    "template": "{status} {seat}: {work}",',
    '    "lowercase": true,',
    '    "maxWork": 6,',
    '    "snippetLength": 60,',
    '    "workSource": ["rename", "assistant", "user"]',
    "  },",
    '  "lifeline": {',
    '    "enabled": true,',
    '    "repair": true,',
    '    "pulse": true',
    "  },",
    '  "caution": {',
    '    "enabled": true,',
    '    "exemptTools": ["question", "task", "subagent", "agent", "delegate", "delegate_many", "delegate_task", "tools.delegate", "tools.delegate_many", "tools.subagent", "tools.task"]',
    "  }",
    "}",
    "",
  ].join("\n"),
);
process.env.OC_UNIFIED_CONFIG = stagedConfigPath;

const fleetMod = await import("./fleet.ts").catch(() => import("../fleet.ts"));
const mastheadMod = await import("./masthead.ts").catch(() => import("../masthead.ts"));
const lifelineMod = await import("./lifeline.ts").catch(() => import("../lifeline.ts"));
const configMod = await import("./config.ts").catch(() => import("../config.ts"));
const pluginMod = await import("./index.ts").catch(() => import("../index.ts"));
const { configPath, fleetBlock, mastheadBlock, lifelineBlock, cautionBlock, lifelinePolicy, configDir, configSource, stateDir: resolveStateDir, optionsConfigPath, DEFAULT_CONFIG_NAME, DEFAULT_TOOL_WATCH_MS, DEFAULT_CEILING_MS } = configMod;
const stagedBase = basename(stagedConfigPath);
const { parseStatus, stale, STALE_MS } = fleetMod;
const { readPolicy, isTerminalTitle, isTerminalSession, firstLine, classifyExecution, countSessions, statusDocument, createDeck, resolveMarker, defaultMarker, trimLogFile, LOG_CAP_BYTES, LOG_KEEP_BYTES } = fleetMod;
const { normalizeTitle: normalizeTitleRaw, isConforming: isConformingRaw, isGrammarTitle: isGrammarTitleRaw, isSubstantive, mergeTitleConfig, stripWorkNoise, workFrom: workFromRaw, asStatus: asStatusRaw, resolveStatus: resolveStatusRaw, parseStatus: titleParseStatusRaw, unwrapQuoted, parseCloseStatus: parseCloseStatusRaw, isEnforcingConfig, titleRe, TITLE_RE, DEFAULT_TITLE_CONFIG } = mastheadMod;
// The harness vocabulary these pure-rule checks were written against: the
// fixture's staged `masthead` block carries a tree's vocabulary, and the
// neutral code default is now empty (observe-only). Threading the harness
// config here keeps every historical expectation as harness-value coverage;
// Part N proves the neutral default matches nothing.
const HARNESS_TITLE = mergeTitleConfig({ statuses: ["active", "parked", "done"], seats: ["orsted", "plan", "recon", "build", "ops", "vault", "scribe", "reviewer", "general", "explore"], legacySeats: ["fleet", "commander"], fallbackSeat: "orsted" });
const normalizeTitle = (input: any, cfg: any = HARNESS_TITLE) => normalizeTitleRaw(input, cfg);
const isConforming = (input: any, cfg: any = HARNESS_TITLE) => isConformingRaw(input, cfg);
const isGrammarTitle = (value: unknown, agent: unknown, cfg: any = HARNESS_TITLE) => isGrammarTitleRaw(value, agent, cfg);
const workFrom = (input: any, cfg: any = HARNESS_TITLE) => workFromRaw(input, cfg);
const asStatus = (value: unknown, cfg: any = HARNESS_TITLE) => asStatusRaw(value, cfg);
const resolveStatus = (hasMessages: boolean, hint?: unknown, cfg: any = HARNESS_TITLE) => resolveStatusRaw(hasMessages, hint, cfg);
const titleParseStatus = (title: unknown, cfg: any = HARNESS_TITLE) => titleParseStatusRaw(title, cfg);
const parseCloseStatus = (text: unknown, cfg: any = HARNESS_TITLE) => parseCloseStatusRaw(text, cfg);
const plugin = pluginMod.default;

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok)
    console.log(
      `       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`,
    );
}
function checkTrue(name: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : " " + detail}`);
}

// ---------------------------------------------------------------------------
// Part 1 - NO TUI SURFACE (the invariant). oc-unified is a silent background
// helper: setup registers no sidebar/channel slot, no row drawer, and no
// render tick, and no shipped module exports a drawing primitive. This part
// FAILS if any of that returns.
// ---------------------------------------------------------------------------

{
  // The display modules are gone from the unit's own tree.
  checkTrue("no-TUI: panel.ts is gone", readUnitSource("panel.ts") === "");
  checkTrue("no-TUI: rail.ts is gone", readUnitSource("rail.ts") === "");
  checkTrue("no-TUI: tui.tsx is gone", readUnitSource("tui.tsx") === "");

  // No shipped module exports a drawing primitive.
  for (const [name, mod] of [["fleet", fleetMod], ["lifeline", lifelineMod], ["masthead", mastheadMod], ["config", configMod]] as const) {
    const seen = mod as any;
    checkTrue(
      `no-TUI: ${name} exports no drawing primitive`,
      seen.lineFor === undefined && seen.markFor === undefined && seen.markThrob === undefined &&
        seen.drawRailRow === undefined && seen.stamp === undefined && seen.cut === undefined &&
        seen.toneFor === undefined && seen.levelFor === undefined && seen.isLive === undefined &&
        seen.armed === undefined && seen.composePanel === undefined && seen.resolvePanel === undefined &&
        seen.panelPolicy === undefined && seen.panelBlock === undefined,
    );
  }

  // No shipped source claims a display slot, tick, or render path.
  for (const name of ["index.ts", "config.ts", "fleet.ts", "lifeline.ts", "masthead.ts"]) {
    const src = readUnitSource(name);
    checkTrue(
      `no-TUI: ${name} claims no display surface`,
      !/sidebar|ui\.slot|requestRender|wrapMode|drawRailRow|railFrame|sidebar\.content/.test(src),
      name,
    );
  }

  // Setup against a host that OFFERS a display slot: the plugin must not take
  // it, while the silent background still wires (both RPC ids, both hooks).
  const slotCalls: unknown[] = [];
  const rpcIds: string[] = [];
  let hooks = 0;
  const quietCtx: any = {
    options: {},
    ui: { slot: (...args: unknown[]) => { slotCalls.push(args); return () => {}; } },
    session: {
      get: async () => ({}),
      hook: async () => { hooks += 1; return { dispose: async () => {} }; },
    },
    event: {
      subscribe: async function* () {},
    },
    rpc: { register: async (shape: any) => { rpcIds.push(String(shape?.id ?? "")); } },
    tool: { transform: async () => {} },
    storage: {
      get: async () => undefined,
      set: async () => {},
      scan: async () => ({ entries: [] }),
      remove: async () => {},
    },
  };
  let setupError: unknown = null;
  let dispose: any = null;
  try {
    dispose = await (plugin as any).setup(quietCtx);
  } catch (error) {
    setupError = error;
  }
  check("no-TUI: setup resolves with a display slot on offer", setupError, null);
  check("no-TUI: setup claims no sidebar/channel slot", slotCalls.length, 0);
  checkTrue("no-TUI: the lifeline RPC still wires", rpcIds.includes("oc-lifeline"), JSON.stringify(rpcIds));
  checkTrue("no-TUI: the masthead RPC still wires", rpcIds.includes("oc-masthead"), JSON.stringify(rpcIds));
  check("no-TUI: both silent context hooks still wire", hooks, 2);
  if (typeof dispose === "function") await dispose();
}

const now = 1_700_000_000_000;
const fresh = (over: any = {}) => ({
  at: now - 5_000,
  sweptAt: now - 1_000,
  total: 3,
  watch: 2,
  blocked: 0,
  errors: 0,
  done: 1,
  ...over,
});

// Tolerant reader.
check("parse absent -> undefined", parseStatus(""), undefined);
check("parse torn -> undefined", parseStatus("{torn"), undefined);
check(
  "parse wrong version -> undefined",
  parseStatus(JSON.stringify({ version: 2, sweptAt: now })),
  undefined,
);
check(
  "parse missing sweptAt -> undefined",
  parseStatus(JSON.stringify({ version: 1, total: 1 })),
  undefined,
);
const parsed = parseStatus(JSON.stringify({ version: 1, sweptAt: now, at: now - 1000, total: 2, watch: 1, blocked: 0, errors: 0, done: 1 }));
checkTrue("parse keeps watch count", (parsed as any)?.watch === 1);
checkTrue("parse clamps negatives", (parseStatus(JSON.stringify({ version: 1, sweptAt: now, watch: -5 })) as any)?.watch === 0);

// Stale window.
check("no reading is stale", stale(undefined, now), true);
check("fresh is not stale", stale(fresh(), now), false);
check("old sweep is stale", stale(fresh({ sweptAt: now - STALE_MS - 1 }), now), true);

// ---------------------------------------------------------------------------
// Part 2 - the pure decision core (index.ts)
// ---------------------------------------------------------------------------

// Terminality is configured: the harness's `done` token arrives via the
// `fleet` block's `terminalTokens` (see the staged file above). Neutral
// default is empty - nothing is terminal until configured (Part N).
const HARNESS_TOKENS = ["done"];
check("done is terminal", isTerminalTitle("done build: ship it", HARNESS_TOKENS), true);
check("closed is not terminal", isTerminalTitle("closed ops: done", HARNESS_TOKENS), false);
check("parked is not terminal", isTerminalTitle("parked build: ship it", HARNESS_TOKENS), false);
check("active is not terminal", isTerminalTitle("active build: ship it", HARNESS_TOKENS), false);
check("empty is not terminal", isTerminalTitle("", HARNESS_TOKENS), false);
check("undefined is not terminal", isTerminalTitle(undefined, HARNESS_TOKENS), false);

check("firstLine flattens object message", firstLine({ message: "boom" }), "boom");
check("firstLine coerces string", firstLine("  hello   world  "), "hello world");
const long = "x".repeat(200);
checkTrue("firstLine truncates with ellipsis", String(firstLine(long)).endsWith(String.fromCharCode(0x2026)) && String(firstLine(long)).length === 160, JSON.stringify(firstLine(long)).slice(0, 80));

const errClass = classifyExecution("session.execution.failed", { error: { message: "kaboom" } });
check("execution failed -> error", (errClass as any)?.class, "error");
checkTrue("error detail carries message", String((errClass as any)?.detail ?? "").includes("kaboom"));
check(
  "user cancel is not a stall",
  classifyExecution("session.execution.interrupted", { reason: "user" }),
  undefined,
);
check(
  "inactivity interrupt -> stalled",
  (classifyExecution("session.execution.interrupted", { reason: "inactivity" }) as any)?.class,
  "stalled",
);
check(
  "step failed -> error",
  (classifyExecution("session.step.failed", { error: "bad step" }) as any)?.class,
  "error",
);
check(
  "provider retry -> stalled",
  (classifyExecution("session.status", { status: { type: "retry", attempt: 2, message: "retrying" } }) as any)?.class,
  "stalled",
);
check("unrelated event -> undefined", classifyExecution("session.created", {}), undefined);

const counts = countSessions([
  { terminal: false, gone: false, executing: true, blocked: false },
  { terminal: false, gone: false, executing: false, blocked: true, error: true },
  { terminal: true, gone: false, executing: false, blocked: false },
  { terminal: false, gone: true, executing: false, blocked: false },
]);
check("count total skips gone", (counts as any).total, 3);
check("count watch skips terminal+gone", (counts as any).watch, 2);
check("count blocked", (counts as any).blocked, 1);
check("count errors", (counts as any).errors, 1);
check("count done", (counts as any).done, 1);

// Status document round-trips through the row parser. LIVE values only: no
// sticky latches, no executing count.
const doc = statusDocument({
  stats: { at: now - 5000, sweptAt: now },
  counts: { total: 3, watch: 2, executing: 1, blocked: 0, errors: 0, done: 1 },
  enabled: true,
});
const docParsed = parseStatus(doc, now);
checkTrue("status doc parses", docParsed !== undefined);
check("status doc watch survives", (docParsed as any)?.watch, 2);
checkTrue("status doc carries oc-fleet writer", String(doc).includes("oc-fleet"));
checkTrue(
  "status doc drops sticky latches and executing",
  !String(doc).includes("targetGone") && !String(doc).includes("injected") &&
    !String(doc).includes("executing") && !String(doc).includes('"event"'),
  String(doc),
);

// ---------------------------------------------------------------------------
// Part 3 - policy gate + shape
// ---------------------------------------------------------------------------

check("plugin id is oc-unified", (plugin as any)?.id, "oc-unified");
checkTrue("plugin setup is a function", typeof (plugin as any)?.setup === "function");

// The live policy file + no options -> file values (source is the staged copy's
// basename). The shared config path is env-derived, so the fixture points it
// at its own staged copy; there is no other file the unit reads.
const fromFile = readPolicy({});
check("file report true", (fromFile as any).report, true);
check("file enabled", (fromFile as any).enabled, true);
check("file push false", (fromFile as any).push, false);
check("file report option enables reporting", (readPolicy({ options: { "oc-fleet": { report: true } } }) as any).report, true);
check("file doneTtlSeconds default", (fromFile as any).doneTtlSeconds, 60);
check("file minNoteSeconds default", (fromFile as any).minNoteSeconds, 300);
check("file noteTtlSeconds default", (fromFile as any).noteTtlSeconds, 900);
check("file writeMinMs default", (fromFile as any).writeMinMs, 100);
check("file source", (fromFile as any).source, stagedBase);
check("file recipient strategy", (fromFile as any).recipient, "nearest-ancestor");
check("file terminalTokens", JSON.stringify((fromFile as any).terminalTokens), JSON.stringify(["done"]));
check("file autoWatchChildren", (fromFile as any).autoWatchChildren, true);

// An absent config file (or an absent block) is not an error: every documented
// default comes straight back. The source token still reads `options`, because
// the (empty) options object is itself an overlay - unchanged behaviour.
const realConfig = process.env.OC_UNIFIED_CONFIG;
process.env.OC_UNIFIED_CONFIG = resolve(fixtureDir, `oc-unified-missing-${runID}.jsonc`);
const fromDefaults = readPolicy({});
check("absent config -> no file source", (fromDefaults as any).source, "options");
check("absent config -> enabled default", (fromDefaults as any).enabled, true);
check("absent config -> report default", (fromDefaults as any).report, true);
check("absent config -> push default", (fromDefaults as any).push, false);
check("absent config -> target default", (fromDefaults as any).target, null);
check("absent config -> sweepSeconds default", (fromDefaults as any).sweepSeconds, 5);
check("absent config -> stallSeconds default", (fromDefaults as any).stallSeconds, 600);
check("absent config -> doneTtlSeconds default", (fromDefaults as any).doneTtlSeconds, 60);
check("absent config -> minNoteSeconds default", (fromDefaults as any).minNoteSeconds, 300);
check("absent config -> noteTtlSeconds default", (fromDefaults as any).noteTtlSeconds, 900);
check("absent config -> writeMinMs default", (fromDefaults as any).writeMinMs, 100);
check("absent config -> everyTerminal default", (fromDefaults as any).everyTerminal, true);
check("absent config -> recipient default", (fromDefaults as any).recipient, "nearest-ancestor");
check("absent config -> terminalTokens default", ((fromDefaults as any).terminalTokens ?? []).length, 0);
check("absent config -> autoWatchChildren default", (fromDefaults as any).autoWatchChildren, true);
check("absent config -> watch default", ((fromDefaults as any).watch ?? []).length, 0);
// The title config falls back the same way: no block, the documented defaults.
check("absent config -> no masthead block", mastheadBlock(), undefined);
check("absent config -> no lifeline block", lifelineBlock(), undefined);
check("absent config -> no caution block", cautionBlock(), undefined);
check("absent config -> no context block reader", (configMod as any).contextBlock, undefined);
// Lifeline's policy falls back the same way, through the same resolver: the
// documented defaults. The advisory context nudger is gone, so the policy
// carries no band, threshold, cap, or window key.
const lifelineDefaults = lifelinePolicy();
check("absent config -> lifeline policy reports the fallback", lifelineDefaults.source, "defaults (policy unreadable)");
check("absent config -> lifeline policy carries no watch rung", (lifelineDefaults as any).contextWatch, undefined);
check("absent config -> lifeline policy carries no nudge rung", (lifelineDefaults as any).contextNudge, undefined);
check("absent config -> lifeline policy carries no critical rung", (lifelineDefaults as any).contextCritical, undefined);
check("absent config -> lifeline policy carries no dynamic window", (lifelineDefaults as any).contextDynamic, undefined);
check("absent config -> lifeline policy carries no safety floor", (lifelineDefaults as any).safetyNudgeTokens, undefined);
check("absent config -> lifeline policy carries no per-session cap", (lifelineDefaults as any).nudgeCap, undefined);
check("absent config -> lifeline policy carries no projection knob", (lifelineDefaults as any).contextProjectionTurns, undefined);
check("absent config -> lifeline policy carries no per-model overrides", (lifelineDefaults as any).perModel, undefined);
check("absent config -> lifeline defaults arm no repair", lifelineDefaults.repairArmed, false);
check("absent config -> lifeline defaults keep pulse on", lifelineDefaults.pulseEnabled, true);
check("absent config -> lifeline defaults keep the fallback bound", lifelineDefaults.fallbackMs, 420_000);
process.env.OC_UNIFIED_CONFIG = realConfig;

// The resolver's live shape: the env override names the staged copy, and every
// block it hands out is the one written above.
check("config path honours OC_UNIFIED_CONFIG", configPath(), stagedConfigPath);
check("staged config -> fleet block present", fleetBlock()?.enabled, true);
check("staged config -> masthead block present", mastheadBlock()?.template, "{status} {seat}: {work}");
check("staged config -> comment line was stripped", fleetBlock()?.report, true);
check("staged config -> lifeline block present", lifelineBlock()?.enabled, true);
check("staged config -> caution block present", cautionBlock()?.enabled, true);
// The resolver feeds lifeline's whole policy: the two blocks above become the
// validated Policy through the ONE config path, never a second read. A
// `context` block, if one were present, is unread and meaningless.
const stagedLifeline = lifelinePolicy();
check("staged lifeline policy -> source is the file", stagedLifeline.source, stagedBase);
check("staged lifeline policy -> carries no watch rung", (stagedLifeline as any).contextWatch, undefined);
check("staged lifeline policy -> carries no nudge rung", (stagedLifeline as any).contextNudge, undefined);
check("staged lifeline policy -> carries no critical rung", (stagedLifeline as any).contextCritical, undefined);
check("staged lifeline policy -> carries no urgent rung", (stagedLifeline as any).contextUrgent, undefined);
check("staged lifeline policy -> carries no dynamic window", (stagedLifeline as any).contextDynamic, undefined);
check("staged lifeline policy -> carries no safety floor", (stagedLifeline as any).safetyNudgeTokens, undefined);
check("staged lifeline policy -> carries no per-session cap", (stagedLifeline as any).nudgeCap, undefined);
check("staged lifeline policy -> carries no auto-compact gate", (stagedLifeline as any).contextAutoCompactAt, undefined);
check("staged lifeline policy -> repair armed from the lifeline block", stagedLifeline.repairArmed, true);
check("staged lifeline policy -> pulse on", stagedLifeline.pulseEnabled, true);
check("staged lifeline policy -> exempt list is the file's", stagedLifeline.exempt.length, 11);

const activePolicy = { ...fromFile, report: true };

// Registration options win over the file.
const overridden = readPolicy({ options: { "oc-fleet": { enabled: false, watch: ["ses_abc"], sweepSeconds: 9, minNoteSeconds: 12, noteTtlSeconds: 34, writeMinMs: 56 } } });
check("options disable", (overridden as any).enabled, false);
checkTrue("options watch lands", ((overridden as any).watch ?? []).includes("ses_abc"));
check("options sweep wins", (overridden as any).sweepSeconds, 9);
check("options minNoteSeconds wins", (overridden as any).minNoteSeconds, 12);
check("options noteTtlSeconds wins", (overridden as any).noteTtlSeconds, 34);
check("options writeMinMs wins", (overridden as any).writeMinMs, 56);
check("options keep file source", (overridden as any).source, stagedBase);

let promptCalls = 0;
const fakeContext = (get: () => Promise<any> = async () => ({})) => ({
  session: {
    get,
    prompt: async () => { promptCalls += 1; },
  },
});

// Setup owns one silent context hook PER feature that uses one and disposes it
// with the plugin: the fleet watcher (its escalation notes) and lifeline (its
// silent note channel). The title renamer registers none.
let contextHookCalls = 0;
let contextHookName = "";
let hookDisposed = false;
const cleanup = await (plugin as any).setup({
  options: { "oc-fleet": { enabled: true, report: false } },
  event: {},
  session: {
    get: async () => ({}),
    hook: async (name: string) => {
      contextHookCalls += 1;
      contextHookName = name;
      return { dispose: async () => { hookDisposed = true; } };
    },
  },
});
check("setup registers one context hook per feature that needs one", contextHookCalls, 2);
check("setup registers the context hook name", contextHookName, "context");
await cleanup();
check("setup disposes context hook", hookDisposed, true);

// Marker isolation: the diagnostic log honours OC_FLEET_MARKER (sandbox path
// set above before the import), and the default lane is ENV-DERIVED (the home
// root), never a literal user path.
check("marker honours override", resolveMarker(process.env), markerPath);
check("marker default honours LOCALAPPDATA", resolveMarker({ LOCALAPPDATA: "X:\\lane" }), join("X:\\lane", "Temp", "opencode", "oc-fleet.log"));
check("marker default derives from the home root", resolveMarker({}), join(homedir(), "AppData", "Local", "Temp", "opencode", "oc-fleet.log"));
checkTrue("sandbox marker captures setup note", readFileSync(markerPath, "utf8").includes("setup generation="));

// One failed execution drives the real escalation path; both status and
// escalation writes stay in the disposable proving sandbox.
writeFileSync(escalationPath, "");
const watchedSid = "ses_fixture_escalation";
const deck = createDeck(
  fakeContext(),
  { ...activePolicy, enabled: true, watch: [watchedSid], target: "ses_fixture_recipient" },
);
await deck.handleEvent({ type: "session.execution.failed", data: { sessionID: watchedSid, error: "fixture failure" } });
const escalationLines = readFileSync(escalationPath, "utf8").trim().split("\n");
const escalation = JSON.parse(escalationLines[0]);
checkTrue(
  "escalation appends one JSONL record",
  escalationLines.length === 1 && escalation.kind === "error" && escalation.sid === watchedSid &&
    escalation.recipient === "ses_fixture_recipient" && escalation.detail === "execution failed" &&
    escalation.text.startsWith("FLEET-ESCALATION"),
  JSON.stringify(escalation),
);

// Pending notes collapse to the newest and are added once to outgoing context.
const recipient = "ses_fixture_recipient";
const noteDeck = createDeck(
  fakeContext(),
  { ...activePolicy, enabled: true, watch: ["ses_note_old", "ses_note_new", "ses_note_repeat"], target: recipient },
);
await noteDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_note_old", error: "old failure" } });
await noteDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_note_new", error: "new failure" } });
await noteDeck.handleEvent({ type: "session.inbox.enqueued", data: { sessionID: recipient, inboxID: "inbox_note_1", item: { type: "user" } } });
const noteContext = { sessionID: recipient, system: [] as Array<{ type: string; text: string }> };
noteDeck.context(noteContext);
checkTrue("context hook pushes one compact newest note", noteContext.system.length === 1 && noteContext.system[0].text.includes("session=ses_note_new") && noteContext.system[0].text.includes("class=error"));
noteDeck.context(noteContext);
check("context hook clears note after one push", noteContext.system.length, 1);

// A later escalation cannot exceed the configured per-recipient delivery rate.
await noteDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_note_repeat", error: "repeat failure" } });
await noteDeck.handleEvent({ type: "session.inbox.enqueued", data: { sessionID: recipient, inboxID: "inbox_note_2", item: { type: "user" } } });
const throttledContext = { sessionID: recipient, system: [] as Array<{ type: string; text: string }> };
noteDeck.context(throttledContext);
check("minNoteSeconds suppresses repeat delivery", throttledContext.system.length, 0);
noteDeck.stop();

// A status-changing event writes before the recipient probe can finish.
let probeStarted = false;
let finishProbe: ((value: any) => void) | undefined;
const immediateDeck = createDeck(
  {
    session: {
      get: () => new Promise((resolve) => { probeStarted = true; finishProbe = resolve; }),
      prompt: async () => { promptCalls += 1; },
    },
  },
  { ...activePolicy, enabled: true, watch: ["ses_fast_status"], target: recipient },
);
immediateDeck.enqueue({ type: "session.execution.failed", data: { sessionID: "ses_fast_status", error: "fast status" } });
const immediateStatus = parseStatus(readFileSync(process.env.OC_FLEET_STATUS as string, "utf8"), Date.now());
checkTrue("status writes before recipient probe resolves", probeStarted && (immediateStatus as any)?.blocked === 1);
finishProbe?.({});
await new Promise((resolve) => setTimeout(resolve, 0));
await immediateDeck.handleDirty();
immediateDeck.stop();

// ---------------------------------------------------------------------------
// report:false keeps the rail status current while disabling every active probe/report path.
let quietGets = 0;
let quietPrompts = 0;
const escalationsBeforeQuiet = readFileSync(escalationPath, "utf8").split("\n").filter(Boolean).length;
const quietDeck = createDeck(
  { session: { ...fakeContext(async () => { quietGets += 1; return {}; }).session, prompt: async () => { quietPrompts += 1; promptCalls += 1; } } },
  { ...fromFile, report: false, push: true, enabled: true, watch: ["ses_report_off"], target: "ses_fixture_recipient" },
);
await quietDeck.handleEvent({ type: "session.idle", data: { sessionID: "ses_report_off" } });
await quietDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_report_off", error: "quiet failure" } });
await quietDeck.handleEvent({ type: "session.inbox.enqueued", data: { sessionID: "ses_fixture_recipient", inboxID: "inbox_quiet", item: { type: "user" } } });
const quietContext = { sessionID: "ses_fixture_recipient", system: [] as Array<{ type: string; text: string }> };
quietDeck.context(quietContext);
await quietDeck.sweep();
const quietStatus = parseStatus(readFileSync(process.env.OC_FLEET_STATUS as string, "utf8"), Date.now());
check("report false skips all session.get probes", quietGets, 0);
check("report false skips all prompts", quietPrompts, 0);
check("report false adds zero context notes", quietContext.system.length, 0);
check("report false skips escalation append", readFileSync(escalationPath, "utf8").split("\n").filter(Boolean).length, escalationsBeforeQuiet);
check("report false still paints status", (quietStatus as any)?.blocked, 1);
// Part 4 - live-only deck behaviour (blocked auto-clear, gone purge,
// terminal TTL age-out, sweep cadence, recipient liveness gate)
// ---------------------------------------------------------------------------

const statusPath = process.env.OC_FLEET_STATUS as string;
const readLive = () => parseStatus(readFileSync(statusPath, "utf8"), Date.now());

// Blocked/error auto-clears on idle, on restart, and on rename-to-nonterminal.
const clearDeck = createDeck(
  fakeContext(),
  { ...activePolicy, enabled: true, watch: ["ses_clear"], target: null },
);
await clearDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_clear", error: "boom" } });
checkTrue("error blocks", clearDeck.state.sessions.get("ses_clear")?.blocked === true);
await clearDeck.handleEvent({ type: "session.idle", data: { sessionID: "ses_clear" } });
checkTrue("idle auto-clears blocked", clearDeck.state.sessions.get("ses_clear")?.blocked === false);
await clearDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_clear", error: "boom" } });
await clearDeck.handleEvent({ type: "session.step.started", data: { sessionID: "ses_clear" } });
checkTrue("restart auto-clears blocked", clearDeck.state.sessions.get("ses_clear")?.blocked === false);
await clearDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_clear", error: "boom" } });
await clearDeck.handleEvent({ type: "session.renamed", data: { sessionID: "ses_clear", title: "active work" } });
checkTrue("rename-to-nonterminal auto-clears blocked", clearDeck.state.sessions.get("ses_clear")?.blocked === false);

// RE-POINTED (was: "target-gone reported once, not per sweep"). A vanished
// watch member is by-design operation - the session's own close deletes it - so
// it is no longer an escalation at all: it never reaches the escalation history,
// now or on any later sweep. The purge from live counts still holds.
const escalationHistoryLines = () => readFileSync(escalationPath, "utf8").split("\n").filter(Boolean).length;
const goneDeck = createDeck(
  fakeContext(async () => { throw new Error("gone"); }),
  { ...activePolicy, enabled: true, watch: ["ses_gone"], target: null },
);
const goneHistoryBefore = escalationHistoryLines();
await goneDeck.sweep();
checkTrue("gone sid leaves the watch set", !goneDeck.state.watch.has("ses_gone"));
goneDeck.writeStatus(true);
check("gone records purge from live counts", (readLive() as any)?.total, 0);
checkTrue("no targetGone latch in status", (readLive() as any)?.targetGone !== true);
check("vanished watch member writes no escalation history", escalationHistoryLines(), goneHistoryBefore);
checkTrue("no target-gone class ever reaches the escalation history", !readFileSync(escalationPath, "utf8").includes("target-gone"));
await goneDeck.sweep();
check("still none after a second sweep", escalationHistoryLines(), goneHistoryBefore);

// ADDED - RECIPIENT LIVENESS GATE. The same event sequence twice, differing
// only in the recipient's title: a finished (`done`) recipient is suppressed and
// counted - no history line and no note - while a live recipient still records
// the escalation and still delivers the note into outgoing context.
const gateHistoryBefore = escalationHistoryLines();
const contextFor = (sessionID: string) => ({ sessionID, system: [] as Array<{ type: string; text: string }> });

const doneRecipientDeck = createDeck(
  { session: { get: async () => ({ data: { title: "done commander: finished work" } }) } },
  { ...activePolicy, enabled: true, watch: ["ses_gate_done"], target: "ses_done_recipient" },
);
await doneRecipientDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_gate_done", error: "gate failure" } });
check("terminal recipient suppresses the note", doneRecipientDeck.state.suppressed, 1);
check("terminal recipient writes no escalation history", escalationHistoryLines(), gateHistoryBefore);
await doneRecipientDeck.handleEvent({ type: "session.inbox.enqueued", data: { sessionID: "ses_done_recipient", inboxID: "inbox_gate_done", item: { type: "user" } } });
const doneContext = contextFor("ses_done_recipient");
doneRecipientDeck.context(doneContext);
check("terminal recipient gets no note in context", doneContext.system.length, 0);
doneRecipientDeck.stop();

const liveRecipientDeck = createDeck(
  { session: { get: async () => ({ data: { title: "active commander: live work" } }) } },
  { ...activePolicy, enabled: true, watch: ["ses_gate_live"], target: "ses_live_recipient" },
);
await liveRecipientDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_gate_live", error: "gate failure" } });
check("live recipient records the escalation", escalationHistoryLines(), gateHistoryBefore + 1);
check("live recipient is never suppressed", liveRecipientDeck.state.suppressed, 0);
await liveRecipientDeck.handleEvent({ type: "session.inbox.enqueued", data: { sessionID: "ses_live_recipient", inboxID: "inbox_gate_live", item: { type: "user" } } });
const liveContext = contextFor("ses_live_recipient");
liveRecipientDeck.context(liveContext);
checkTrue("live recipient still gets the note", liveContext.system.length === 1 && liveContext.system[0].text.includes("class=error"), JSON.stringify(liveContext.system));
liveRecipientDeck.stop();

// The second suppression reason: a recipient that no longer resolves.
const absentRecipientDeck = createDeck(
  fakeContext(async () => { throw new Error("recipient gone"); }),
  { ...activePolicy, enabled: true, watch: ["ses_gate_absent"], target: "ses_absent_recipient" },
);
const absentHistoryBefore = escalationHistoryLines();
await absentRecipientDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_gate_absent", error: "gate failure" } });
check("absent recipient suppresses the note", absentRecipientDeck.state.suppressed, 1);
check("absent recipient writes no escalation history", escalationHistoryLines(), absentHistoryBefore);
absentRecipientDeck.stop();

// Terminal records age out after the done-TTL so the fleet returns to idle.
const ttlDeck = createDeck(
  fakeContext(),
  { ...activePolicy, enabled: true, watch: ["ses_old"], target: null },
);
await ttlDeck.handleEvent({ type: "session.renamed", data: { sessionID: "ses_old", title: "done ship it" } });
const oldRec = ttlDeck.state.sessions.get("ses_old");
if (oldRec) oldRec.terminalAt = Date.now() - 61_000;
ttlDeck.writeStatus(true);
check("terminal records age out after done-TTL", (readLive() as any)?.total, 0);

// ---------------------------------------------------------------------------
// Part 5 - stall auto-clear on renewed activity, escalation pruning,
// terminal age-out removal
// ---------------------------------------------------------------------------

// (a) A stalled session that then shows fresh activity drops out of blocked.
const stallDeck = createDeck(
  fakeContext(),
  { ...activePolicy, enabled: true, watch: ["ses_stall"], target: null },
);
await stallDeck.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_stall" } });
const stallRec = stallDeck.state.sessions.get("ses_stall");
if (stallRec) stallRec.lastActivityAt = Date.now() - (fromFile.stallSeconds * 1000 + 5_000);
await stallDeck.sweep();
checkTrue("stall sets blocked", stallDeck.state.sessions.get("ses_stall")?.blocked === true);
check("stalled session counts as blocked", (readLive() as any)?.blocked, 1);
await stallDeck.handleEvent({ type: "session.inbox.delivered", data: { sessionID: "ses_stall" } });
checkTrue("fresh activity clears stall-blocked", stallDeck.state.sessions.get("ses_stall")?.blocked === false);
stallDeck.writeStatus(true);
check("renewed activity drops out of blocked count", (readLive() as any)?.blocked, 0);

// (b) Expired escalation entries are pruned, not retained forever.
const escDeck = createDeck(
  fakeContext(),
  { ...activePolicy, enabled: true, watch: ["ses_esc"], target: null },
);
escDeck.state.escalated.set("error:ses_stale_a", Date.now() - 60 * 60_000);
escDeck.state.escalated.set("stalled:ses_stale_b", Date.now() - 60 * 60_000);
await escDeck.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_esc", error: "boom" } });
checkTrue(
  "expired escalations pruned",
  !escDeck.state.escalated.has("error:ses_stale_a") && !escDeck.state.escalated.has("stalled:ses_stale_b"),
);
checkTrue("escalated stays bounded", escDeck.state.escalated.size <= 2, `size=${escDeck.state.escalated.size}`);

// (c) Aged-out terminal records are removed, not just skipped.
const ageDeck = createDeck(
  fakeContext(),
  { ...activePolicy, enabled: true, watch: ["ses_aged"], target: null },
);
await ageDeck.handleEvent({ type: "session.renamed", data: { sessionID: "ses_aged", title: "done ship it" } });
const ageRec = ageDeck.state.sessions.get("ses_aged");
if (ageRec) ageRec.terminalAt = Date.now() - 61_000;
ageDeck.writeStatus(true);
checkTrue("aged-out terminal record removed", !ageDeck.state.sessions.has("ses_aged"));
check("aged-out terminal counts zero", (readLive() as any)?.total, 0);

// Sweep cadence honours the configured sweepSeconds.
let gets = 0;
const cadDeck = createDeck(
  fakeContext(async () => { gets += 1; return {}; }),
  { ...activePolicy, enabled: true, watch: ["ses_cad"], target: null, sweepSeconds: 1 },
);
cadDeck.tick();
await new Promise((r) => setTimeout(r, 250));
checkTrue("sweep honours sweepSeconds=1 (swept on first tick)", gets >= 1, `gets=${gets}`);
cadDeck.stop();
clearDeck.stop();
goneDeck.stop();
ttlDeck.stop();
stallDeck.stop();
escDeck.stop();
ageDeck.stop();
quietDeck.stop();
deck.stop();
check("test double's session.prompt is never called", promptCalls, 0);

// ---------------------------------------------------------------------------
// Part 7 - diagnostic log cap: bounded, newest survives, no partial line,
// append still works.
// ---------------------------------------------------------------------------

{
  checkTrue("log cap exports the trim helper", typeof trimLogFile === "function");
  check("log cap is 1MiB", LOG_CAP_BYTES, 1_048_576);
  check("log keep is 256KiB", LOG_KEEP_BYTES, 262_144);
  const capPath = resolve(fixtureDir, `oc-fleet-logcap-${runID}.log`);
  const filler = (i: number) => `capfill line ${i} ${"x".repeat(64)}\n`;
  const parts: string[] = [];
  let size = 0;
  let i = 0;
  while (size <= LOG_CAP_BYTES + 4096) {
    const s = filler(i++);
    parts.push(s);
    size += s.length;
  }
  parts.push("CAP-NEWEST-1 tail sentinel\n");
  parts.push("CAP-NEWEST-2 tail sentinel\n");
  writeFileSync(capPath, parts.join(""));
  checkTrue("cap fixture starts over the cap", statSync(capPath).size > LOG_CAP_BYTES);
  trimLogFile(capPath);
  const capped = statSync(capPath).size;
  checkTrue("capped file is at or under the cap", capped <= LOG_CAP_BYTES, `size=${capped}`);
  const cappedText = readFileSync(capPath, "utf8");
  checkTrue("newest lines survive the cap", cappedText.includes("CAP-NEWEST-2 tail sentinel"));
  checkTrue("old head is dropped", !cappedText.includes("capfill line 0 "));
  const firstCapped = cappedText.split("\n")[0];
  checkTrue(
    "no partial line is left",
    /^(capfill line \d+ x+|CAP-NEWEST-\d tail sentinel)$/.test(firstCapped),
    JSON.stringify(firstCapped).slice(0, 80),
  );
  checkTrue("capped file still ends on a newline", cappedText.endsWith("\n"));
  appendFileSync(capPath, "CAP-AFTER append works\n");
  trimLogFile(capPath);
  const recappedText = readFileSync(capPath, "utf8");
  checkTrue("appending still works afterwards", recappedText.endsWith("CAP-AFTER append works\n"));
  checkTrue("still bounded after append", statSync(capPath).size <= LOG_CAP_BYTES);
}

// ---------------------------------------------------------------------------
// Title renamer parts (moved from plugins/oc-masthead/fixtures/run.ts). The
// helpers and the env staging above are shared by both features; these parts
// keep every assertion the standalone unit shipped, adapted only where the
// unit's own file names changed (title.ts / index.ts / row.ts -> masthead.ts).
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Part 1 - the pure normalizer
// ---------------------------------------------------------------------------

// Conforming title is a no-op.
check(
  'conforming no-op',
  normalizeTitle({
    title: 'active build: ship the fix',
    agent: 'build',
    hasMessages: true,
  }),
  'active build: ship the fix',
);

// A bare auto-title gains the prefix; the default status is active.
check(
  'bare auto-title gains prefix',
  normalizeTitle({
    title: 'warp drive diagnostics',
    agent: 'build',
    hasMessages: false,
  }),
  'active build: warp drive diagnostics',
);

// An existing status token is replaced, never duplicated.
check(
  'stale status token replaced',
  normalizeTitle({
    title: 'done build: ship the fix',
    agent: 'build',
    hasMessages: true,
  }),
  'active build: ship the fix',
);
check(
  'doubled status token collapses',
  normalizeTitle({
    title: 'active active build: ship the fix',
    agent: 'build',
    hasMessages: true,
  }),
  'active build: ship the fix',
);

// An explicit status signal wins over the default active derivation.
check(
  'explicit status hint wins',
  normalizeTitle({
    title: 'active build: ship the fix',
    agent: 'build',
    hasMessages: true,
    status: 'done',
  }),
  'done build: ship the fix',
);
check(
  'garbage status hint falls back to derivation',
  normalizeTitle({
    title: 'active build: ship the fix',
    agent: 'build',
    hasMessages: true,
    status: 'nope',
  }),
  'active build: ship the fix',
);

// Three-token vocabulary: `parked` is accepted, a retired token is rejected.
check('asStatus accepts parked', asStatus('parked'), 'parked');
check('asStatus rejects retired closed', asStatus('closed'), undefined);
check(
  'resolveStatus defaults to active without messages',
  resolveStatus(false),
  'active',
);

// Unknown / empty agent falls back to orsted.
check(
  'unknown agent -> orsted',
  normalizeTitle({
    title: 'warp drive diagnostics',
    agent: undefined,
    hasMessages: false,
  }),
  'active orsted: warp drive diagnostics',
);
check(
  'empty agent -> orsted',
  normalizeTitle({
    title: 'warp drive diagnostics',
    agent: '',
    hasMessages: false,
  }),
  'active orsted: warp drive diagnostics',
);
check(
  'non-roster agent kept verbatim',
  normalizeTitle({
    title: 'warp drive diagnostics',
    agent: 'builder',
    hasMessages: false,
  }),
  'active builder: warp drive diagnostics',
);

// Empty title falls back to untitled, and to the snippet when supplied.
check(
  'empty title -> untitled',
  normalizeTitle({ title: '', agent: 'build', hasMessages: false }),
  'active build: untitled',
);
check(
  'empty title -> snippet',
  normalizeTitle({
    title: '',
    agent: 'build',
    hasMessages: false,
    snippet: 'fix the login bug',
  }),
  'active build: fix the login bug',
);

// The stored fallback `untitled` is not work: a supplied snippet heals it, and
// without a snippet the title stays a conforming no-op (the loop guard).
check(
  'stored fallback is non-sticky with snippet',
  normalizeTitle({
    title: 'active fleet: untitled',
    hasMessages: true,
    snippet: 'retire Orca from harness',
  }),
  'active orsted: retire orca from harness',
);
check(
  'stored fallback stays untitled without snippet',
  normalizeTitle({ title: 'active fleet: untitled', hasMessages: true }),
  'active orsted: untitled',
);
check(
  'stored legacy-seat fallback without snippet no longer conforms (guard)',
  isConforming({ title: 'active fleet: untitled', hasMessages: true }),
  false, // the default seat is now orsted: the legacy title normalizes to an orsted title
);

// parked -> active on plain derivation (no explicit status is kept).
check(
  'parked -> active on derivation',
  normalizeTitle({
    title: 'parked build: ship the fix',
    agent: 'build',
    hasMessages: true,
  }),
  'active build: ship the fix',
);

// Double normalization is idempotent, including the non-trivial seat.
check(
  'double normalization is idempotent',
  normalizeTitle({
    title: normalizeTitle({
      title: 'victor-mango',
      agent: 'recon',
      hasMessages: true,
    }),
    agent: 'recon',
    hasMessages: true,
  }),
  'active recon: victor-mango',
);

// A bare auto-title that happens to contain a colon keeps its words.
check(
  'colon in bare title is kept',
  normalizeTitle({
    title: 'Fix: the login bug',
    agent: 'build',
    hasMessages: false,
  }),
  'active build: fix: the login bug',
);

// The whole title is always lowercase, whatever the input's case.
check(
  'whole title lowercased',
  normalizeTitle({
    title: 'Warp Drive Diagnostics',
    agent: 'Build',
    hasMessages: false,
  }),
  'active build: warp drive diagnostics',
);

// A hand-typed uppercase status token is consumed, not duplicated.
check(
  'uppercase status token consumed',
  normalizeTitle({
    title: 'Active build: ship the fix',
    agent: 'build',
    hasMessages: true,
  }),
  'active build: ship the fix',
);

// The seat token matches case-insensitively, so `Fleet:` strips.
check(
  'uppercase seat token stripped',
  normalizeTitle({
    title: 'active Fleet: ship the fix',
    agent: 'build',
    hasMessages: true,
  }),
  'active build: ship the fix',
);

// A stale non-roster seat prefix strips when it equals the live seat, so a
// rename's own output stays a conforming no-op after an agent switch.
check(
  'live non-roster seat prefix strips',
  normalizeTitle({
    title: 'active builder: ship the fix',
    agent: 'builder',
    hasMessages: true,
  }),
  'active builder: ship the fix',
);
check(
  'live non-roster seat prefix conforms (guard)',
  isConforming({
    title: 'active builder: ship the fix',
    agent: 'builder',
    hasMessages: true,
  }),
  true,
);
check(
  'retired status token never conforms',
  isConforming({
    title: 'closed ops: done here',
    agent: 'ops',
    hasMessages: true,
  }),
  false, // `closed` is retired: the title normalizes to an active title
);

check('substance: punctuation-only is rejected', isSubstantive('...'), false);
check('substance: fewer than three alphanumerics is rejected', isSubstantive('a1'), false);
check('substance: three alphanumerics is accepted', isSubstantive('Fix'), true);
check(
  'trivial title and prompt -> untitled',
  normalizeTitle({ title: '.', snippet: '.', hasMessages: true }),
  'active orsted: untitled',
);
// Leading markdown/emoji noise never becomes the work label; interior text and
// ordinary leading words or digits pass through byte-identical.
check('work noise: bold span drops', stripWorkNoise('**Bold** ship the thing'), 'ship the thing');
check('work noise: quote marker drops', stripWorkNoise('> quoted work'), 'quoted work');
// Rocket via fromCodePoint keeps this file ASCII-only (a raw emoji literal does not round-trip through this checkout).
check('work noise: emoji drops', stripWorkNoise(String.fromCodePoint(0x1F680) + ' Deploy the harness'), 'Deploy the harness');
check('work noise: heading drops', stripWorkNoise('### heading work'), 'heading work');
check('work noise: digits kept', stripWorkNoise('42 sessions idle'), '42 sessions idle');
check('work noise: interior kept', stripWorkNoise('ship **the** thing today'), 'ship **the** thing today');
check('work: bold lead drops', workFrom({ assistant: '**Bold** ship the thing' }), 'ship the thing');
check('work: quote lead drops', workFrom({ user: '> quoted work' }), 'quoted work');
check('work: emoji lead drops', workFrom({ assistant: String.fromCodePoint(0x1F680) + ' Deploy the harness' }), 'deploy the harness');
check('work: heading lead drops', workFrom({ assistant: '### heading work' }), 'heading work');
check('work: leading digits kept', workFrom({ assistant: '42 sessions idle' }), '42 sessions idle');
check('work: interior emphasis kept', workFrom({ assistant: 'ship **the** thing today' }), 'ship **the** thing today');
check('work: rename still wins', workFrom({ rename: '**Bold** ship the thing', assistant: 'other words here today' }), 'ship the thing');
check(
  'work: live title derives identically',
  workFrom({ assistant: 'Three local plugins silent and doctor-green' }),
  'three local plugins silent and doctor-green',
);
check(
  'work: dot still falls back',
  normalizeTitle({ title: '.', snippet: '.', hasMessages: true }),
  'active orsted: untitled',
);

// A title that arrived from a JSON-string body is quote-wrapped. The wrapper
// hides the status token from the grammar and turns the whole previous title
// into the work label - both shapes observed live.
check(
  'unwrap: JSON string layer',
  unwrapQuoted('"done fleet: harness close-v2 revamp"'),
  'done fleet: harness close-v2 revamp',
);
check(
  'unwrap: escaped quote layer',
  unwrapQuoted('\\"done fleet: harness close-v2 revamp\\"'),
  'done fleet: harness close-v2 revamp',
);
check('unwrap: clean title untouched', unwrapQuoted('active build: ship the fix'), 'active build: ship the fix');
check(
  'unwrap: interior quotes kept',
  unwrapQuoted('active build: "ship the fix"'),
  'active build: "ship the fix"',
);
check(
  'quoted title keeps its status token',
  titleParseStatus('"done fleet: harness close-v2 revamp"'),
  'done',
);
check(
  'quoted rename work is not the previous title',
  workFrom({ rename: '"done fleet: harness close-v2 revamp"' }),
  'harness close-v2 revamp',
);
check(
  'nested quoted work is not a duplicated title',
  workFrom({ rename: 'active fleet: "done fleet: harness close-v2 revamp"' }),
  'harness close-v2 revamp',
);
check('quoted assistant work unwrapped', workFrom({ assistant: '"deploy the harness"' }), 'deploy the harness');
check('quoted bare title work unwrapped', workFrom({ title: '"deploy the harness"', agent: 'build' }), 'deploy the harness');

// The pin outranks a user-prompt snippet: a conforming title the session already
// owns is its work label, and a later prompt is the fallback, never the
// replacement. Only the other sources stay in configurable order.
check(
  'work: conforming pin beats a user snippet',
  workFrom({
    rename: 'done fleet: harness close-v2 revamp',
    user: 'masthead is fixed - you are the best',
  }),
  'harness close-v2 revamp',
);
check(
  'work: pin beats a user snippet under a reordered source list',
  workFrom(
    { rename: 'done fleet: harness close-v2 revamp', user: 'masthead is fixed - you are the best' },
    mergeTitleConfig({ ...HARNESS_TITLE, workSource: ['user', 'rename'] }),
  ),
  'harness close-v2 revamp',
);
check(
  'work: no pin -> the user snippet is the fallback',
  workFrom({ title: 'active fleet: untitled', user: 'heal the stale title' }),
  'heal the stale title',
);
check(
  'work: bare title does not pin, the snippet fills it',
  workFrom({ title: 'warp drive diagnostics', user: 'actual task words' }),
  'actual task words',
);
// Wrapper defences hold on the pin path too: a pin that is only a wrapper, a bare
// backslash, or the fallback label is not work, so the snippet still supplies it.
check('work: wrapper-only pin falls back to the snippet', workFrom({ rename: '""', user: 'real work words' }), 'real work words');
check('work: bare-backslash pin falls back to the snippet', workFrom({ rename: 'active fleet: \\', user: 'real work words' }), 'real work words');
// The fallback label never pins from a title, so a snippet still heals it; an
// explicit agent rename to it is the agent's own word and is honoured as-is.
check('work: fallback label never pins from a title', workFrom({ title: 'active fleet: untitled', user: 'real work words' }), 'real work words');
check('work: explicit fallback rename is honoured', workFrom({ rename: 'done fleet: untitled', user: 'real work words' }), 'untitled');

// The pin test is the grammar shape, not a byte-equal title: a status token
// healed from the recorded map, or a quote-wrapped body, still counts.
check('grammar: conforming title pins', isGrammarTitle('active fleet: harness close-v2 revamp', 'fleet'), true);
check('grammar: quote-wrapped conforming title pins', isGrammarTitle('active fleet: "done fleet: harness close-v2 revamp"', 'fleet'), true);
check('grammar: non-roster seat still pins', isGrammarTitle('active builder: ship the fix', 'builder'), true);
check('grammar: stale seat token still pins', isGrammarTitle('active fleet: switch the agent', 'build'), true);
check('grammar: bare auto-title does not pin', isGrammarTitle('warp drive diagnostics', 'build'), false);
check('grammar: fallback label does not pin', isGrammarTitle('active fleet: untitled', 'fleet'), false);
check('grammar: no seat token does not pin', isGrammarTitle('active fleet close-v2 revamp', 'fleet'), false);
check('grammar: punctuation-only work does not pin', isGrammarTitle('active fleet: ...', 'fleet'), false);

// The recorded map's close status: read only the top-level `close:` block.
check('close status: done', parseCloseStatus('close:\n  status: done\n  at: x\n  publication: null\n'), 'done');
check('close status: quoted value', parseCloseStatus('close:\n  status: "parked"\n'), 'parked');
check('close status: null block -> undefined', parseCloseStatus('close: null\n'), undefined);
check('close status: absent key -> undefined', parseCloseStatus('updated: x\nsession:\n  id: s\n'), undefined);
check('close status: task status never read', parseCloseStatus('tasks:\n  - what: x\n    status: done\n'), undefined);
check('close status: retired token -> undefined', parseCloseStatus('close:\n  status: closed\n'), undefined);
check('close status: malformed -> undefined', parseCloseStatus('close:\n  status: [unclosed\n'), undefined);
check('close status: non-string -> undefined', parseCloseStatus(null), undefined);
const customTitleConfig = mergeTitleConfig({
  template: '{work} | {seat} [{status}]',
  maxWork: 2,
  lowercase: false,
});
check(
  'config: template, maxWork, lowercase apply',
  normalizeTitle(
    { title: '', agent: 'Build', assistant: 'Fix Critical Header', hasMessages: true },
    customTitleConfig,
  ),
  'Fix Critical | Build [active]',
);

// ---------------------------------------------------------------------------
// Part 2 - the plugin, driven against a fake ctx (loop guard)
// ---------------------------------------------------------------------------

function makeQueue() {
  const items: any[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(event: any) {
      items.push(event);
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    close() {
      closed = true;
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    async *[Symbol.asyncIterator]() {
      while (!closed || items.length) {
        if (!items.length) {
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        yield items.shift();
      }
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 25));

// The untitled counter store is resolved from USERPROFILE on every call, and
// the first-use path now CREATES it, so the state root is redirected to the
// fixture's own temp home BEFORE the plugin can allocate - no allocation ever
// writes to the real %USERPROFILE%\.local\state\opencode. Part 7 recomputes the
// same path for its session-map fixtures, and the run restores the real value.
const realHome = process.env.USERPROFILE;
const realHomePosix = process.env.HOME;
process.env.USERPROFILE = await (async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return join(tmpdir(), 'opencode', `oc-masthead-fixture-${process.pid}`);
})();

const store = new Map<
  string,
  {
    title: string;
    agent?: string;
    parentID?: string;
    status?: string;
    state?: string;
  }
>();
const updates: Array<{ sessionID: string; title: string }> = [];
// The host fans every event out to EVERY subscriber: each feature gets its own
// stream. The fixture models that - `subscribe` mints a fresh queue per call and
// `push` delivers to all of them - so wiring a third feature into the one plugin
// cannot starve the others of the events they assert on.
const subscribers: any[] = [];
const queue = {
  push(event: any) {
    for (const q of subscribers) q.push(event);
  },
  close() {
    for (const q of subscribers) q.close();
  },
};
// One ctx for the whole unit: the renamer needs get/update, the fleet watcher
// (wired by the same setup) needs the event stream and one context hook, and
// lifeline (wired by the same setup) needs the event stream too.
const ctx = {
  event: {
    subscribe: (_args: any) => {
      const q = makeQueue();
      subscribers.push(q);
      return q;
    },
  },
  session: {
    hook: async (_name: string) => ({ dispose: async () => {} }),
    get: async ({ sessionID }: any) => store.get(sessionID),
    update: async ({ sessionID, title }: any) => {
      updates.push({ sessionID, title });
      const current = store.get(sessionID) ?? { title: '', agent: undefined };
      current.title = title;
      store.set(sessionID, current);
    },
  },
};

const dispose = await plugin.setup(ctx);

// s1: bare title, agent known at creation -> one rename, then a rename echo.
store.set('s1', { title: 'warp drive diagnostics', agent: 'build' });
queue.push({
  type: 'session.created',
  data: { sessionID: 's1', title: 'warp drive diagnostics', agent: 'build' },
});
await tick();
check('plugin: bare title corrected', updates.length, 1);
check(
  'plugin: correction is active build',
  updates[0]?.title,
  'active build: warp drive diagnostics',
);

// Our own rename output must not re-enter.
queue.push({
  type: 'session.renamed',
  data: { sessionID: 's1', title: 'active build: warp drive diagnostics' },
});
await tick();
check('plugin: rename echo is ignored', updates.length, 1);

// The first message is a no-op once active (there is no staged state).
queue.push({
  type: 'session.step.started',
  data: { sessionID: 's1', agent: 'build' },
});
await tick();
check('plugin: first message keeps active', updates.length, 1);
check(
  'plugin: title stays active',
  store.get('s1')?.title,
  'active build: warp drive diagnostics',
);

// A repeated step with the same agent is a no-op (re-read, conforming, no write).
queue.push({
  type: 'session.step.started',
  data: { sessionID: 's1', agent: 'build' },
});
await tick();
check('plugin: repeated step is a no-op', updates.length, 1);

// s2: agent unknown at creation -> fleet; the first step fixes it.
store.set('s2', { title: 'victor-mango' });
queue.push({
  type: 'session.created',
  data: { sessionID: 's2', title: 'victor-mango' },
});
await tick();
check(
  'plugin: unknown agent -> fleet now',
  updates[1]?.title,
  'active fleet: victor-mango',
);
queue.push({
  type: 'session.step.started',
  data: { sessionID: 's2', agent: 'recon' },
});
await tick();
check(
  'plugin: agent known re-normalizes',
  updates[2]?.title,
  'active recon: victor-mango',
);

// s3: a title that already conforms at creation is never written.
const before = updates.length;
store.set('s3', { title: 'active build: already fine', agent: 'build' });
queue.push({
  type: 'session.created',
  data: {
    sessionID: 's3',
    title: 'active build: already fine',
    agent: 'build',
  },
});
await tick();
check('plugin: conforming title is a no-op', updates.length, before);

// A trivial first prompt never becomes the work label; the first substantive
// assistant text fills it after the punctuation-only user item.
store.set('s10', { title: '.', agent: 'build' });
queue.push({
  type: 'session.created',
  data: { sessionID: 's10', title: '.', agent: 'build' },
});
await tick();
check('plugin: dot title becomes untitled', store.get('s10')?.title, 'active build: untitled 1');
queue.push({
  type: 'session.inbox.enqueued',
  data: { sessionID: 's10', item: { type: 'user', payload: { text: '.' } } },
});
await tick();
check('plugin: dot first prompt never yields dot', store.get('s10')?.title, 'active build: untitled 1');
queue.push({
  type: 'session.text.ended',
  data: { sessionID: 's10', assistantMessageID: 'assistant_10', ordinal: 0, text: 'Describe masthead title behavior' },
});
await tick();
check(
  'plugin: assistant text fills trivial prompt work',
  store.get('s10')?.title,
  'active build: describe masthead title behavior',
);

// Agent selection is a first-class event; its agent value must replace the
// stored segment even without another step-start event.
store.set('s11', { title: 'active fleet: use selected agent', agent: 'fleet' });
queue.push({
  type: 'session.agent.selected',
  data: { sessionID: 's11', agent: 'ops', previous: 'fleet' },
});
await tick();
check(
  'plugin: session.agent.selected changes agent segment',
  store.get('s11')?.title,
  'active ops: use selected agent',
);

// A conforming title supplied through session.renamed remains byte-identical.
store.set('s12', { title: 'active build: original task title', agent: 'build' });
queue.push({
  type: 'session.created',
  data: { sessionID: 's12', title: 'active build: original task title', agent: 'build' },
});
await tick();
const renameBefore = updates.length;
store.get('s12')!.title = 'active build: agent authored task title';
queue.push({
  type: 'session.renamed',
  data: { sessionID: 's12', title: 'active build: agent authored task title' },
});
await tick();
check('plugin: conforming agent rename makes no write', updates.length, renameBefore);
check(
  'plugin: conforming agent rename bytes untouched',
  store.get('s12')?.title,
  'active build: agent authored task title',
);

// ---------------------------------------------------------------------------
// Part 3 - the inbox snippet heals the fallback (the observed payload shape)
// ---------------------------------------------------------------------------

// s4: created with no title -> `untitled`; the real inbox OBJECT payload must
// supply the work words (shape observed from session.inbox.list).
store.set('s4', { title: '' });
queue.push({
  type: 'session.created',
  data: { sessionID: 's4', title: '' },
});
await tick();
check(
  'plugin: empty title -> untitled',
  updates.at(-1)?.title,
  'active fleet: untitled 2',
);
queue.push({
  type: 'session.inbox.enqueued',
  data: {
    sessionID: 's4',
    item: {
      id: 'msg_1',
      sessionID: 's4',
      time: { created: 0 },
      type: 'user',
      payload: { text: 'retire Orca from harness' },
      delivery: 'steer',
    },
  },
});
await tick();
check(
  'plugin: inbox object payload heals the fallback',
  updates.at(-1)?.title,
  'active fleet: retire orca from harness',
);

// h1: an already-stamped `active fleet: untitled` is non-sticky - a later
// snippet still heals it.
store.set('h1', { title: 'active fleet: untitled' });
queue.push({
  type: 'session.inbox.enqueued',
  data: {
    sessionID: 'h1',
    item: { type: 'user', payload: { text: 'heal the stale title' } },
  },
});
await tick();
check(
  'plugin: stored untitled heals from snippet',
  updates.at(-1)?.title,
  'active fleet: heal the stale title',
);

// s5: the legacy plain-string inbox item still supplies the work words.
store.set('s5', { title: '' });
queue.push({
  type: 'session.created',
  data: { sessionID: 's5', title: '' },
});
await tick();
check(
  'plugin: s5 empty title -> untitled',
  updates.at(-1)?.title,
  'active fleet: untitled 3',
);
queue.push({
  type: 'session.inbox.enqueued',
  data: { sessionID: 's5', item: 'plain string prompt' },
});
await tick();
check(
  'plugin: plain-string inbox item still works',
  updates.at(-1)?.title,
  'active fleet: plain string prompt',
);

// s6: a conforming title stays byte-identical even when a snippet is supplied.
const conformingBefore = updates.length;
store.set('s6', { title: 'active build: already fine', agent: 'build' });
queue.push({
  type: 'session.step.started',
  data: {
    sessionID: 's6',
    agent: 'build',
    item: { type: 'user', payload: { text: 'must not override' } },
  },
});
await tick();
check(
  'plugin: conforming title + snippet is a no-op',
  updates.length,
  conformingBefore,
);
check(
  'plugin: conforming title bytes unchanged',
  store.get('s6')?.title,
  'active build: already fine',
);

// ---------------------------------------------------------------------------
// Part 4 - top-level only: a child (subagent) session is never renamed
// ---------------------------------------------------------------------------

const slotOf = () =>
  (globalThis as any).__ocMasthead?.slot as { count: number } | undefined;

// t1: a top-level session (no parent anywhere) IS renamed. `parentID` is
// deliberately absent, which is what marks a session top-level.
const topBefore = updates.length;
store.set('t1', { title: 'top level work', agent: 'build' });
queue.push({
  type: 'session.created',
  data: { sessionID: 't1', title: 'top level work', agent: 'build' },
});
await tick();
check('plugin: top-level session is renamed', updates.length, topBefore + 1);
check(
  'plugin: top-level title',
  updates.at(-1)?.title,
  'active build: top level work',
);

// c1: a child whose parentID rides the creation payload is NEVER renamed - not
// on creation, not on a later step - and never counts a correction.
const childBefore = updates.length;
const countBeforeChild = slotOf()?.count ?? 0;
store.set('c1', { title: 'subagent work', agent: 'build', parentID: 't1' });
queue.push({
  type: 'session.created',
  data: {
    sessionID: 'c1',
    title: 'subagent work',
    agent: 'build',
    parentID: 't1',
  },
});
await tick();
check('plugin: child not renamed on creation', updates.length, childBefore);
queue.push({
  type: 'session.step.started',
  data: { sessionID: 'c1', agent: 'build' },
});
await tick();
check('plugin: child not renamed on later step', updates.length, childBefore);
check('plugin: child title untouched', store.get('c1')?.title, 'subagent work');
check(
  'plugin: child does not count a correction',
  slotOf()?.count,
  countBeforeChild,
);

// c2: a child first observed on a later event - its creation event was never
// seen, and the parent surfaces from the session object `settle` fetches - is
// skipped, and stays skipped on every event after.
const lateBefore = updates.length;
store.set('c2', { title: 'late child work', agent: 'recon', parentID: 't1' });
queue.push({
  type: 'session.step.started',
  data: { sessionID: 'c2', agent: 'recon' },
});
await tick();
check('plugin: late child not renamed', updates.length, lateBefore);
queue.push({
  type: 'session.inbox.enqueued',
  data: { sessionID: 'c2', item: { type: 'user', payload: { text: 'more' } } },
});
await tick();
check('plugin: late child stays skipped', updates.length, lateBefore);
check(
  'plugin: late child title untouched',
  store.get('c2')?.title,
  'late child work',
);

// ---------------------------------------------------------------------------
// Part 5 - the two title latches: agent switch + terminal status
// ---------------------------------------------------------------------------

// s7: the stored agent is stale (`fleet`); the step event carries the live
// switch, and the fresh hint must win.
store.set('s7', { title: 'active fleet: switch the agent', agent: 'fleet' });
queue.push({
  type: 'session.step.started',
  data: { sessionID: 's7', agent: 'build' },
});
await tick();
check(
  'plugin: fresh agent hint wins over stored',
  updates.at(-1)?.title,
  'active build: switch the agent',
);

// s7 again with no agent on the event and a still-stale store: the seen-cache
// carries the switch, so the title must not fall back to `fleet`.
const s7Before = updates.length;
queue.push({ type: 'session.step.started', data: { sessionID: 's7' } });
await tick();
check(
  'plugin: cached agent survives agent-less event',
  updates.length,
  s7Before,
);
check(
  'plugin: cached agent title bytes unchanged',
  store.get('s7')?.title,
  'active build: switch the agent',
);

// s8: a post-`active` status signal on the event moves the status past `active`.
store.set('s8', { title: 'active build: finish the job', agent: 'build' });
queue.push({
  type: 'session.step.started',
  data: { sessionID: 's8', agent: 'build', status: 'done' },
});
await tick();
check(
  'plugin: status signal moves past active',
  updates.at(-1)?.title,
  'done build: finish the job',
);

// s8b: the status rides live session state (`session.get`), not the event.
store.set('s8b', {
  title: 'active build: live state job',
  agent: 'build',
  status: 'parked',
});
queue.push({
  type: 'session.step.started',
  data: { sessionID: 's8b', agent: 'build' },
});
await tick();
check(
  'plugin: live session status moves past active',
  updates.at(-1)?.title,
  'parked build: live state job',
);

// s8c: a completion event type alone carries the terminal status.
store.set('s8c', { title: 'active build: typed completion', agent: 'build' });
queue.push({ type: 'session.completed', data: { sessionID: 's8c' } });
await tick();
check(
  'plugin: completion event moves past active',
  updates.at(-1)?.title,
  'done build: typed completion',
);

// s9: no signal at all - a hand-set terminal status is never clobbered back
// to `active`.
store.set('s9', { title: 'done build: already shipped', agent: 'build' });
const s9Before = updates.length;
queue.push({
  type: 'session.step.started',
  data: { sessionID: 's9', agent: 'build' },
});
await tick();
check('plugin: terminal status not clobbered', updates.length, s9Before);
check(
  'plugin: terminal title bytes unchanged',
  store.get('s9')?.title,
  'done build: already shipped',
);

// ---------------------------------------------------------------------------
// Part 7 - a terminal title is durable: the wrapper and the recorded map
// ---------------------------------------------------------------------------

// m1: a title that arrived quote-wrapped (the host delivered a JSON-string
// rename body) must heal to the unwrapped grammar, never to a false `active`.
store.set('m1', { title: '"done fleet: harness close-v2 revamp"', agent: 'fleet' });
queue.push({ type: 'session.step.started', data: { sessionID: 'm1', agent: 'fleet' } });
await tick();
check(
  'plugin: quote-wrapped done title heals, never active',
  store.get('m1')?.title,
  'done fleet: harness close-v2 revamp',
);

// The recorded map is the second source of truth. A fake home keeps the real
// one untouched; the fixture self-deletes it, so nothing is left behind.
// (fs / path / os helpers come from the module-level imports at the top.)
const fakeHome = join(tmpdir(), 'opencode', `oc-masthead-fixture-${process.pid}`);
const stateDir = (id: string) => join(fakeHome, '.local', 'state', 'opencode', 'sessions', id);
// Realistic ids: the reader only touches a `ses_`-shaped directory name.
const MAP_SESSION = 'ses_m2fixture';
const BAD_SESSION = 'ses_m4fixture';
mkdirSync(stateDir(MAP_SESSION), { recursive: true });
writeFileSync(
  join(stateDir(MAP_SESSION), 'session-state.yaml'),
  'updated: 2026-01-01T00:00:00+08:00\n\nsession:\n  id: ses_m2fixture\n  title: "done fleet: harness close-v2 revamp"\n\ntasks:\n  - what: x\n    status: done\n\nclose:\n  status: done\n  at: 2026-01-01T00:00:00+08:00\n  publication: null\n  note: "closed"\n',
);
mkdirSync(stateDir(BAD_SESSION), { recursive: true });
writeFileSync(join(stateDir(BAD_SESSION), 'session-state.yaml'), 'close:\n  status: [unclosed\n');
// `recordedCloseStatus` calls os.homedir(): Windows reads USERPROFILE, POSIX reads HOME.
// Set both so the same fixture resolves the recorded map on either platform.
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

// m2: the live title is the false claim the bug produced, while the map records
// a terminal close - the status token must not fall back to `active`.
store.set(MAP_SESSION, { title: 'active fleet: "done fleet: harness close-v2 revamp"', agent: 'fleet' });
queue.push({ type: 'session.step.started', data: { sessionID: MAP_SESSION, agent: 'fleet' } });
await tick();
check(
  'plugin: recorded close beats the active fallback',
  store.get(MAP_SESSION)?.title,
  'done fleet: harness close-v2 revamp',
);

// m3: no map file - today's behaviour is untouched (conforming title no-op).
store.set('m3', { title: 'active fleet: still working', agent: 'fleet' });
const m3Before = updates.length;
queue.push({ type: 'session.step.started', data: { sessionID: 'm3', agent: 'fleet' } });
await tick();
check('plugin: no recorded close keeps the active no-op', updates.length, m3Before);

// m4: a malformed map degrades to today's behaviour - no throw, no latch.
store.set(BAD_SESSION, { title: 'active fleet: still working', agent: 'fleet' });
const m4Before = updates.length;
queue.push({ type: 'session.step.started', data: { sessionID: BAD_SESSION, agent: 'fleet' } });
await tick();
check('plugin: malformed map degrades to the active no-op', updates.length, m4Before);

// p1: the residual. The live title carries the session's own work in the grammar
// while the recorded map heals its status token, and the user prompt rides the
// same event. The title is pinned, so the work segment is the pin's - never the
// prompt snippet.
const PIN_SESSION = 'ses_p1fixture';
mkdirSync(stateDir(PIN_SESSION), { recursive: true });
writeFileSync(
  join(stateDir(PIN_SESSION), 'session-state.yaml'),
  'close:\n  status: done\n  at: 2026-01-01T00:00:00+08:00\n  publication: null\n',
);
store.set(PIN_SESSION, { title: 'active fleet: "done fleet: harness close-v2 revamp"', agent: 'fleet' });
queue.push({
  type: 'session.step.started',
  data: {
    sessionID: PIN_SESSION,
    agent: 'fleet',
    item: { type: 'user', payload: { text: 'masthead is fixed - you are the best' } },
  },
});
await tick();
check(
  'plugin: pinned work beats the prompt snippet',
  store.get(PIN_SESSION)?.title,
  'done fleet: harness close-v2 revamp',
);
// ...and the pin holds across a later prompt.
queue.push({
  type: 'session.inbox.enqueued',
  data: { sessionID: PIN_SESSION, item: { type: 'user', payload: { text: 'something else entirely here' } } },
});
await tick();
check(
  'plugin: pin holds across a later prompt',
  store.get(PIN_SESSION)?.title,
  'done fleet: harness close-v2 revamp',
);

// p2: a bare host auto-title is not in the grammar, so it never pins and a
// prompt still supplies its work label.
store.set('p2', { title: 'warp drive diagnostics', agent: 'build' });
queue.push({
  type: 'session.inbox.enqueued',
  data: { sessionID: 'p2', item: { type: 'user', payload: { text: 'actual task words' } } },
});
await tick();
check(
  'plugin: non-grammar title still takes the prompt label',
  store.get('p2')?.title,
  'active build: actual task words',
);

// ---------------------------------------------------------------------------
// Part 8 - the untitled fallback gets a durable, unique sequence number
// ---------------------------------------------------------------------------
// Fallback path ONLY. FIRST USE is distinguished from a LOST FILE: an ABSENT
// store was never allocated from, so the first allocation creates it (seeded at
// seq 0) inside the lock already held and issues 1 - no number can be reissued.
// A store that EXISTS but is corrupt still degrades to the bare `untitled`
// literal, never a guessed number. The seeded checks below drive an explicit
// store; the first-use path is proven on its own store at the end of the part.
const { allocateUntitled, counterPath } = mastheadMod;
const freshQuery = `?fresh=${process.pid}-${Date.now()}`;
const freshCounter = await import(`./masthead.ts${freshQuery}`).catch(
  () => import(`../masthead.ts${freshQuery}`),
);
const readCounterFile = readFileSync; // the module-level import, under the name this part uses
const counterFile = counterPath();
const seqNow = () => JSON.parse(readCounterFile(counterFile, 'utf8')).seq;

mkdirSync(dirname(counterFile), { recursive: true });
writeFileSync(counterFile, '{"seq": 0}\n');

// 8a first allocation.
check('counter: first allocation is 1', await allocateUntitled(), 1);
// 8b monotonic increment.
check('counter: monotonic increment is 2', await allocateUntitled(), 2);
// 8c persistence, not in-memory: a FRESH module evaluation (a distinct module
// instance, no memory of the prior calls) continues from the file.
check(
  'counter: survives a fresh module evaluation',
  await freshCounter.allocateUntitled(),
  3,
);
check('counter: store holds the last issued number', seqNow(), 3);

// 8d a title that HAS derivable work consumes no number.
const beforeDerive = seqNow();
store.set('u-work', { title: 'derive real work here', agent: 'build' });
queue.push({
  type: 'session.created',
  data: { sessionID: 'u-work', title: 'derive real work here', agent: 'build' },
});
await tick();
check('fallback: derivable work consumes no number', seqNow(), beforeDerive);
check(
  'fallback: derivable work keeps its own label',
  store.get('u-work')?.title,
  'active build: derive real work here',
);

// 8e two consecutive cold sessions receive different numbers.
store.set('u-a', { title: '', agent: 'build' });
queue.push({ type: 'session.created', data: { sessionID: 'u-a', title: '', agent: 'build' } });
await tick();
store.set('u-b', { title: '.', agent: 'build' });
queue.push({ type: 'session.created', data: { sessionID: 'u-b', title: '.', agent: 'build' } });
await tick();
check(
  'fallback: first cold session gets untitled 4',
  store.get('u-a')?.title,
  'active build: untitled 4',
);
check(
  'fallback: second cold session gets untitled 5',
  store.get('u-b')?.title,
  'active build: untitled 5',
);
check(
  'fallback: two consecutive cold sessions differ',
  store.get('u-a')?.title === store.get('u-b')?.title,
  false,
);

// 8f a corrupt store degrades to the bare literal, never a guessed number.
writeFileSync(counterFile, '{ not json');
store.set('u-bad', { title: '', agent: 'build' });
queue.push({ type: 'session.created', data: { sessionID: 'u-bad', title: '', agent: 'build' } });
await tick();
check(
  'fallback: corrupt store degrades to bare untitled',
  store.get('u-bad')?.title,
  'active build: untitled',
);

// 8g FIRST USE: with no store at all, the first allocation creates it and the
// plugin renders `untitled 1` inside the template. The seeded checks above left
// a corrupt store, so it is removed first - first use is exercised on its own,
// deterministic state.
rmSync(counterFile, { force: true });
check('counter: first use starts from no store', existsSync(counterFile), false);
store.set('u-first', { title: '', agent: 'build' });
queue.push({ type: 'session.created', data: { sessionID: 'u-first', title: '', agent: 'build' } });
await tick();
check(
  'fallback: absent store first use titles untitled 1',
  store.get('u-first')?.title,
  'active build: untitled 1',
);
check('counter: first use created the store', existsSync(counterFile), true);
check('counter: store created by first use holds 1', seqNow(), 1);

// 8h persistence across evaluation: a FRESH module instance, with no memory of
// the allocation above, reads the file that call created and issues 2.
check(
  'counter: created store survives a fresh evaluation',
  await freshCounter.allocateUntitled(),
  2,
);
check('counter: store holds 2 after the fresh evaluation', seqNow(), 2);

// 8i a store created by first use, then corrupted, still degrades to the bare
// literal - the first-use path never turns a lost file into a guessed number.
writeFileSync(counterFile, '{ not json');
store.set('u-lost', { title: '', agent: 'build' });
queue.push({ type: 'session.created', data: { sessionID: 'u-lost', title: '', agent: 'build' } });
await tick();
check(
  'fallback: corrupt store after first use still degrades',
  store.get('u-lost')?.title,
  'active build: untitled',
);

if (realHome === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = realHome;
if (realHomePosix === undefined) delete process.env.HOME;
else process.env.HOME = realHomePosix;
rmSync(fakeHome, { recursive: true, force: true });

dispose();
queue.close();
await tick();

// ═══════════════════════════════════════════════════════════════════════════
// Lifeline parts (moved from plugins/oc-lifeline/fixtures/run.ts). The helpers
// and the env staging above are shared by all three features; these parts keep
// every assertion the standalone unit shipped, adapted only where the unit's own
// file names changed (index.ts / status.ts -> lifeline.ts), where the marker
// paths became environment-derived instead of literal, and where the config
// blocks now arrive through the shared resolver.
// ═══════════════════════════════════════════════════════════════════════════

// The unit's own sources, for the source-level wiring assertions below. Flat in
// the plugin-prove sandbox, nested in place - the same dual path the imports use.
function readUnitSource(name: string): string {
  try {
    return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  } catch {
    try {
      return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    } catch {
      return "";
    }
  }
}

// A committed byte must never carry a literal user path. This regex matches
// drive-letter `\Users\` and POSIX `/home/<name>` or `/Users/<name>` prefixes.
const LITERAL_USER_PATH = /(?:[A-Za-z]:\\Users\\|\/home\/[^/\s]+|\/Users\/[^/\s]+)/;

// ---------------------------------------------------------------------------
// Part L2 - the pure band decision core (decideBand)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Part L2 - the band decision core is GONE; the note channel still arms.
//
// The advisory context nudger was removed (the DCP plugin owns that surface
// now): no band ladder, no dynamic point, no projection or safety path, no
// per-session cap, no burn-rate window, no band-driven auto-compact. Every old
// behaviour below is re-pointed at its absence - never deleted silently - and
// the kept note channel (arm -> hook -> deliver) is proved still working.
// ---------------------------------------------------------------------------

{
  const lifelineSrc = readUnitSource("lifeline.ts");
  const configSrc = readUnitSource("config.ts");

  // The pure core no longer exists: unknown window, ladder, safety, projection,
  // hysteresis, cap, dynamic point, and the rate formatter all decided nothing.
  check("lifeline decideBand is gone", (lifelineMod as any).decideBand, undefined);
  check("lifeline dynamicNudgePoint is gone", (lifelineMod as any).dynamicNudgePoint, undefined);
  check("lifeline BAND_RANK is gone", (lifelineMod as any).BAND_RANK, undefined);
  check("lifeline formatRate is gone", (lifelineMod as any).formatRate, undefined);
  check("lifeline normalizeDynamicWindow re-export is gone", (lifelineMod as any).normalizeDynamicWindow, undefined);
  check("lifeline config no longer validates a dynamic window", (configMod as any).normalizeDynamicWindow, undefined);
  checkTrue("lifeline source carries no band ladder", !/BAND_RANK|bandFromPct/.test(lifelineSrc), lifelineSrc.slice(0, 120));
  checkTrue("lifeline source carries no nudge point math", !/dynamicNudgePoint|nudgePoint|nudgeDynamic/.test(lifelineSrc), lifelineSrc.slice(0, 120));
  checkTrue("lifeline source carries no safety token line", !/safetyNudgeTokens|SAFETY line/.test(lifelineSrc), lifelineSrc.slice(0, 120));
  checkTrue("lifeline source carries no per-session cap", !/nudgeCap|maxPerSession/.test(lifelineSrc), lifelineSrc.slice(0, 120));
  checkTrue("lifeline source carries no projection path", !/ratePerTurn|turnsToLimit/.test(lifelineSrc), lifelineSrc.slice(0, 120));
  checkTrue("lifeline source carries no band-driven auto-compact", !/autoCompact|auto-compact/.test(lifelineSrc), lifelineSrc.slice(0, 120));
  checkTrue("lifeline source carries no band storage", !/ctxband|ctxrate|ctxstats|BAND_PREFIX|RATE_PREFIX|STATS_KEY/.test(lifelineSrc), lifelineSrc.slice(0, 120));
  checkTrue("lifeline source carries no context evaluation", !/evaluateContext|measureContext/.test(lifelineSrc), lifelineSrc.slice(0, 120));
  checkTrue("lifeline config carries no context keys", !/contextWatch|contextNudge|contextCritical|contextUrgent|contextDynamic|perModel/.test(configSrc), configSrc.slice(0, 120));
  checkTrue("lifeline config reads no context block", !/over\("context"|parsed\?\.context|readBlock\("context"/.test(configSrc), configSrc.slice(0, 120));

  // ...while the note channel still arms: one pending note per session, spaced
  // by the built-in 300 s default, delivered once through the silent hook.
  const { armPendingContextNote } = lifelineMod;
  checkTrue("lifeline the note channel still arms", typeof armPendingContextNote === "function");
  const channelPending = new Map();
  const channelDelivered = new Map();
  const channelNote = { message: "channel proof", band: "note", pct: 0, used: 0, limit: 0, safety: false, decidedBy: "channel", projectionFields: {} };
  check("lifeline the channel arms a note", armPendingContextNote("channel-fixture", channelPending, channelDelivered, channelNote), true);
  check("lifeline the channel arms only once per session", armPendingContextNote("channel-fixture", channelPending, channelDelivered, channelNote), false);
}

// ---------------------------------------------------------------------------
// Part L3 - the reader-marker freshness decision (isReaderFresh)
// ---------------------------------------------------------------------------

{
  const { isReaderFresh, READER_STALE_MS } = lifelineMod;

  check("lifeline stale window is 10s", READER_STALE_MS, 10_000);
  check("lifeline absent marker is DEAD", isReaderFresh(undefined, now), false);
  check("lifeline zero mtime is DEAD", isReaderFresh(0, now), false);
  check("lifeline NaN mtime is DEAD", isReaderFresh(NaN, now), false);
  check("lifeline fresh stamp is LIVE", isReaderFresh(now - 5_000, now), true);
  check("lifeline stale stamp is DEAD", isReaderFresh(now - READER_STALE_MS - 1, now), false);
  check("lifeline boundary is LIVE", isReaderFresh(now - READER_STALE_MS, now), true);

  // The flip the daemon must report: DEAD -> LIVE on stamp, back to DEAD stale.
  const t0 = now - READER_STALE_MS - 5_000;
  const deadBefore = isReaderFresh(t0, now);
  const liveOnStamp = isReaderFresh(now, now);
  const deadWhenStale = isReaderFresh(now, now + READER_STALE_MS + 1);
  console.log(`       lifeline freshness flip: ${deadBefore ? "LIVE" : "DEAD"} -> ${liveOnStamp ? "LIVE" : "DEAD"} -> ${deadWhenStale ? "LIVE" : "DEAD"}`);
  check("lifeline flip starts DEAD", deadBefore, false);
  check("lifeline flip goes LIVE on stamp", liveOnStamp, true);
  check("lifeline flip returns DEAD when stale", deadWhenStale, false);
}

// ---------------------------------------------------------------------------
// Part L4 - snapshot shape, feature shape, and the ENV-DERIVED marker paths
// ---------------------------------------------------------------------------

{
  const { buildSnapshot, liveMaxPct, MARKER, READER_MARKER } = lifelineMod;

  const stats = {
    heartbeat: 7,
    state: "watch",
    counts: { wedged: 0, watch: 2 },
    canary: "ok",
    canaryDetail: "2/2 tool parts carried a known state.status",
    policy: "flight-deck.jsonc",
    sessions: 3,
    ledger: 1,
  };
  const snap: any = buildSnapshot(stats as any);
  checkTrue("lifeline snapshot carries heartbeat", snap.heartbeat === 7);
  checkTrue("lifeline snapshot carries numeric at", typeof snap.at === "number" && snap.at > 0);
  check("lifeline snapshot passes state through", snap.state, "watch");
  checkTrue("lifeline snapshot carries counts", snap.counts?.watch === 2);
  check("lifeline snapshot carries canary", snap.canary, "ok");
  check("lifeline snapshot carries policy", snap.policy, "flight-deck.jsonc");
  check("lifeline snapshot carries sessions", snap.sessions, 3);
  check("lifeline snapshot carries ledger", snap.ledger, 1);
  const failedSnap: any = buildSnapshot({ ...stats, canary: "failed", state: "idle" } as any);
  check("lifeline canary failure reads wedged", failedSnap.state, "wedged");
  // The snapshot carries the LIVE pct for the reader's tail; a drop lowers it.
  check("lifeline empty pct is null", buildSnapshot(stats as any).pct, null);
  check("lifeline live pct passes through rounded", (buildSnapshot({ ...stats, pct: 45.6 } as any) as any).pct, 46);
  check("lifeline non-finite pct is null", (buildSnapshot({ ...stats, pct: NaN } as any) as any).pct, null);
  // LIVE-MAX: recomputed, never max-latched - a drop lowers the result.
  check("lifeline live max across sessions", liveMaxPct([10, 45, 30]), 45);
  check("lifeline a drop lowers the live max", liveMaxPct([10, 20]), 20);
  check("lifeline empty is zero", liveMaxPct([]), 0);
  check("lifeline non-finite entries are ignored", liveMaxPct([NaN, 25]), 25);

  // The feature entry the unified plugin wires, and the three actions its tool
  // carries, are contracts other things read.
  checkTrue("lifeline setup is exported", typeof (lifelineMod as any).setupLifeline === "function");
  const lifelineSrc = readUnitSource("lifeline.ts");
  checkTrue("the daemon keeps the RPC id oc-lifeline", /id: "oc-lifeline"/.test(lifelineSrc));
  checkTrue("the daemon keeps the snapshot method", /methods:\s*\{\s*snapshot/.test(lifelineSrc));
  checkTrue("the daemon keeps its globalThis slot key", /Symbol\.for\("oc-lifeline\.daemon\.v1"\)/.test(lifelineSrc));
  checkTrue("the lifeline tool keeps its two actions", /enum: \["status", "repair"\]/.test(lifelineSrc));
  checkTrue("the lifeline tool no longer carries reset", !/"reset"/.test(lifelineSrc));
  checkTrue("the tool is still named lifeline", /name: "lifeline"/.test(lifelineSrc));

  // Two markers, both under the platform state directory, neither carrying a
  // session id: the daemon stamps MARKER, the reader stamps READER_MARKER, and
  // freshness is measured against the reader's writes only. Both resolve
  // through config.ts `stateDir` (explicit `OC_UNIFIED_STATE` override, else
  // the platform convention) - a committed byte carries no literal user path.
  const stateRoot = resolveStateDir();
  check("lifeline daemon marker sits under the state dir", MARKER, join(stateRoot, "oc-lifeline.log"));
  check("lifeline reader marker sits under the state dir", READER_MARKER, join(stateRoot, "oc-lifeline-reader.log"));
  checkTrue("lifeline daemon marker carries no session id", !String(MARKER).includes("ses_"), String(MARKER));
  checkTrue("lifeline reader marker carries no session id", !String(READER_MARKER).includes("ses_"), String(READER_MARKER));
  checkTrue("lifeline daemon marker is outside the TEMP junk root", !resolve(MARKER).startsWith(resolve(tmpdir())), String(MARKER));
  checkTrue("lifeline reader marker is outside the TEMP junk root", !resolve(READER_MARKER).startsWith(resolve(tmpdir())), String(READER_MARKER));
  checkTrue("lifeline daemon and reader are two distinct markers", MARKER !== READER_MARKER);
  checkTrue("lifeline marker is resolved through stateDir", /export const MARKER = join\(stateDir\(\), "oc-lifeline\.log"\)/.test(lifelineSrc), lifelineSrc.slice(lifelineSrc.indexOf("export const MARKER"), lifelineSrc.indexOf("export const MARKER") + 120));
  checkTrue("lifeline reader marker is resolved through stateDir", /join\(stateDir\(\), "oc-lifeline-reader\.log"\)/.test(lifelineSrc));
  checkTrue("no committed lifeline byte carries a literal user path", !LITERAL_USER_PATH.test(lifelineSrc));
  checkTrue("no committed daemon byte carries a literal user path", !LITERAL_USER_PATH.test(readUnitSource("lifeline.ts")));
  checkTrue("no committed config byte carries a literal user path", !LITERAL_USER_PATH.test(readUnitSource("config.ts")));
  checkTrue("no committed entry byte carries a literal user path", !LITERAL_USER_PATH.test(readUnitSource("index.ts")));
}

// ---------------------------------------------------------------------------
// Part L5 - dead sessions drop out, the pct tail follows live only, idle static
// ---------------------------------------------------------------------------

{
  const { pruneDeadSessions, liveMaxPct, livePctOverLive, buildSnapshot, SESSION_TTL_MS } = lifelineMod;

  // (a) A dead session drops out of the session set, so the displayed count
  // (slot.stats.sessions = size) reflects LIVE sessions.
  {
    const sessions = new Map([["live-a", "a"], ["dead-b", "b"]]);
    const removed = pruneDeadSessions(sessions, (id) => id !== "dead-b");
    check("lifeline prune reports the dead id", JSON.stringify(removed), JSON.stringify(["dead-b"]));
    check("lifeline dead session drops out", sessions.has("dead-b"), false);
    check("lifeline live session survives prune", sessions.has("live-a"), true);
    check("lifeline pruned size is the live count", sessions.size, 1);
    checkTrue("lifeline prune helper is exported", typeof pruneDeadSessions === "function");
    checkTrue("lifeline session TTL window is configured", typeof SESSION_TTL_MS === "number" && SESSION_TTL_MS > 0);
  }

  // (b) A dead session's high-water mark no longer pins the live pct tail: the
  // max is taken over LIVE sessions only, even when the dead entry holds a
  // stale high figure (the exclusion happens at recompute time).
  {
    const bands = new Map([
      ["live-a", { band: "watch", count: 0, pct: 20, at: now }],
      ["dead-b", { band: "critical", count: 1, pct: 90, at: now }],
    ]);
    check("lifeline stale max over all would pin at 90", liveMaxPct([...bands.values()].map((e) => e.pct)), 90);
    check("lifeline live-only pct ignores the dead tail", livePctOverLive(bands, ["live-a"]), 20);
    check("lifeline empty live set is zero", livePctOverLive(bands, []), 0);
    const snapLive: any = buildSnapshot({ heartbeat: 1, state: "idle", counts: { wedged: 0, watch: 0 }, canary: "ok", canaryDetail: "", policy: "flight-deck.jsonc", sessions: 1, ledger: 0, pct: livePctOverLive(bands, ["live-a"]) } as any);
    check("lifeline snapshot tail follows the live pct", snapLive.pct, 20);
  }

}

// ---------------------------------------------------------------------------
// Part L6 - silent context notes and rate limiting
// ---------------------------------------------------------------------------

{
  const { armPendingContextNote, registerSilentContextHook } = lifelineMod;

  // Notes still flow: the channel arms one pending note per session (no band
  // decision feeds it anymore - the envelope is built by the producer), the
  // silent `context` hook pushes it once into outgoing context, then clears it.
  const sessionID = "silent-channel-fixture";
  const pendingNotes = new Map();
  const deliveredAt = new Map();
  const pendingNote = {
    message: "channel proof: notes still flow without the nudger",
    band: "note",
    pct: 0,
    used: 0,
    limit: 0,
    safety: false,
    decidedBy: "channel",
    projectionFields: {},
  };
  let armedCount = 0;
  if (armPendingContextNote(sessionID, pendingNotes, deliveredAt, pendingNote)) armedCount++;
  if (armPendingContextNote(sessionID, pendingNotes, deliveredAt, pendingNote)) armedCount++;
  check("lifeline one pending note is armed per session", armedCount, 1);

  let contextHook: ((event: any) => void) | undefined;
  let hookName = "";
  let localPromptCalls = 0;
  const fakeCtx = {
    session: {
      prompt: () => { localPromptCalls++ },
      hook: async (name: string, callback: (event: any) => void) => {
        hookName = name;
        contextHook = callback;
      },
    },
  };
  check("lifeline context hook registers", await registerSilentContextHook(fakeCtx, pendingNotes, deliveredAt), true);
  check("lifeline registered hook is context", hookName, "context");
  const firstSystem: any[] = [];
  contextHook?.({ sessionID, system: firstSystem });
  check("lifeline one silent text part is pushed", firstSystem.length, 1);
  check("lifeline silent part is a system text", firstSystem[0]?.type, "text");
  check("lifeline silent part carries the note", firstSystem[0]?.text, pendingNote.message);
  check("lifeline pending note clears after delivery", pendingNotes.has(sessionID), false);
  const nextSystem: any[] = [];
  contextHook?.({ sessionID, system: nextSystem });
  check("lifeline cleared note is not pushed again", nextSystem.length, 0);
  check("lifeline test double's session.prompt is never called", localPromptCalls, 0);

  const cooldownStart = Date.now();
  const cooldownPending = new Map();
  const cooldownDelivered = new Map([["cooldown-fixture", cooldownStart]]);
  check(
    "lifeline minNoteSeconds default suppresses a repeat inside 300 seconds",
    armPendingContextNote("cooldown-fixture", cooldownPending, cooldownDelivered, pendingNote, undefined, cooldownStart + 299_999),
    false,
  );
  check(
    "lifeline minNoteSeconds permits a repeat at 300 seconds",
    armPendingContextNote("cooldown-fixture", cooldownPending, cooldownDelivered, pendingNote, undefined, cooldownStart + 300_000),
    true,
  );
  cooldownPending.clear();

  // The percentage trigger is GONE and stays gone: compaction was opt-in only
  // through the autoCompactAt band gate, and the gate went with the bands, so
  // no session is ever compacted as a side effect of a measurement. The
  // negative controls below are the proof - the old API must not be exported,
  // the policy must not carry the key, and the source must contain no
  // percentage or band compaction path at all.
  check("lifeline no longer exports compactAtIntensity", (lifelineMod as any).compactAtIntensity, undefined);
  check("lifeline no longer exports compactThresholdForIntensity", (lifelineMod as any).compactThresholdForIntensity, undefined);
  check("lifeline policy no longer carries compactIntensity", (stagedLifeline as any).compactIntensity, undefined);
  check("lifeline policy no longer carries autoCompactAt", (stagedLifeline as any).contextAutoCompactAt, undefined);
  check("lifeline policy no longer carries autoCompact", (stagedLifeline as any).contextAutoCompact, undefined);
  const lifelineSrc = readUnitSource("lifeline.ts");
  const intensityRefs = lifelineSrc.match(/.*compact(?:AtIntensity|ThresholdForIntensity|Intensity).*/g) ?? [];
  checkTrue(
    "lifeline source carries no percentage compaction trigger",
    intensityRefs.length === 0,
    intensityRefs.join(" | ").slice(0, 240),
  );
  checkTrue(
    "lifeline source carries no band auto-compact gate",
    !/contextAutoCompactAt|auto-compact|autoCompact\(/.test(lifelineSrc),
    "auto-compact gate present",
  );
}

// ---------------------------------------------------------------------------
// Part L7 - diagnostic log cap: bounded, newest survives, no partial line,
// append still works. The daemon marker is proved functionally through the
// exported helper; the reader marker uses the same-algorithm trim wired into
// lifeline.ts's own append path (the daemon's `note()`), asserted on source
// below - and the live daemon/reader logs are never touched).
// ---------------------------------------------------------------------------

{
  const { trimLogFile, LOG_CAP_BYTES, LOG_KEEP_BYTES } = lifelineMod;
  checkTrue("lifeline log cap exports the trim helper", typeof trimLogFile === "function");
  check("lifeline log cap is 1MiB", LOG_CAP_BYTES, 1_048_576);
  check("lifeline log keep is 256KiB", LOG_KEEP_BYTES, 262_144);
  const proveCap = (tag: string) => {
    const capPath = resolve(fixtureDir, `oc-lifeline-logcap-${tag}.log`);
    const filler = (i: number) => `capfill line ${i} ${"x".repeat(64)}\n`;
    const parts: string[] = [];
    let size = 0;
    let i = 0;
    while (size <= LOG_CAP_BYTES + 4096) {
      const s = filler(i++);
      parts.push(s);
      size += s.length;
    }
    parts.push("CAP-NEWEST-1 tail sentinel\n");
    parts.push("CAP-NEWEST-2 tail sentinel\n");
    writeFileSync(capPath, parts.join(""));
    checkTrue(`lifeline ${tag}: cap fixture starts over the cap`, statSync(capPath).size > LOG_CAP_BYTES);
    trimLogFile(capPath);
    const capped = statSync(capPath).size;
    checkTrue(`lifeline ${tag}: capped file is at or under the cap`, capped <= LOG_CAP_BYTES, `size=${capped}`);
    const cappedText = readFileSync(capPath, "utf8");
    checkTrue(`lifeline ${tag}: newest lines survive the cap`, cappedText.includes("CAP-NEWEST-2 tail sentinel"));
    checkTrue(`lifeline ${tag}: old head is dropped`, !cappedText.includes("capfill line 0 "));
    const firstCapped = cappedText.split("\n")[0];
    checkTrue(
      `lifeline ${tag}: no partial line is left`,
      /^(capfill line \d+ x+|CAP-NEWEST-\d tail sentinel)$/.test(firstCapped),
      JSON.stringify(firstCapped).slice(0, 80),
    );
    checkTrue(`lifeline ${tag}: capped file still ends on a newline`, cappedText.endsWith("\n"));
    appendFileSync(capPath, "CAP-AFTER append works\n");
    trimLogFile(capPath);
    const recappedText = readFileSync(capPath, "utf8");
    checkTrue(`lifeline ${tag}: appending still works afterwards`, recappedText.endsWith("CAP-AFTER append works\n"));
    checkTrue(`lifeline ${tag}: still bounded after append`, statSync(capPath).size <= LOG_CAP_BYTES);
    // The cap fixture is scratch: remove it so an in-place run leaves the plugin
    // directory clean (a stray 256KiB pair here trips harness-doctor's orphan check).
    rmSync(capPath, { force: true });
  };
  proveCap("daemon");
  proveCap("reader");
  const lifelineSrc = readUnitSource("lifeline.ts");
  checkTrue("lifeline reader cap is 1MiB", lifelineSrc.includes("1_048_576") && lifelineSrc.includes("LOG_CAP_BYTES"));
  checkTrue("lifeline reader keeps a 256KiB tail", lifelineSrc.includes("LOG_KEEP_BYTES"));
  checkTrue("lifeline reader trims to the next newline", lifelineSrc.includes("indexOf(10)"));
  checkTrue(
    "lifeline reader caps before its marker append",
    /trimLogFile\(MARKER\)[\s\S]{0,120}appendFileSync\(MARKER/.test(lifelineSrc),
    lifelineSrc.slice(lifelineSrc.indexOf("function note("), lifelineSrc.indexOf("function note(") + 320),
  );
  checkTrue("lifeline reader marker keeps its sole writer", lifelineSrc.split("appendFileSync(MARKER").length === 2);
}

// ---------------------------------------------------------------------------
// Part L8 - Fault A: ORPHAN ADOPTION and the incident's cleanup ordering.
//
// The incident: a setup evaluated the ownership election while the incumbent was
// still alive, became a follower, and claimed nothing; the incumbent's cleanup
// then set alive=false and cleared the ONLY timer. The tree was left with no live
// owner and nothing re-armed it - the reader reported `daemon stale` with `at`
// frozen forever (observed: heartbeat age 948 s against a 30 s cadence).
//
// These cases run the REAL `setupLifeline` against a fake ctx, on the REAL
// process-wide slot, and assert the two properties that fix it: a stopped slot is
// CLAIMABLE, and a claimable slot, once claimed, BEATS. Note: setup calls `note()`,
// whose sole sink is the live daemon marker - this part appends a handful of lines
// to `oc-lifeline.log`. Nothing under the live root is used as a write TARGET.
// ---------------------------------------------------------------------------
{
  const { setupLifeline } = lifelineMod;
  const CLAIM = Symbol.for("oc-lifeline.daemon.v1")
  const globals = globalThis as Record<PropertyKey, any>
  const savedSlot = globals[CLAIM]
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const seedStats = () => ({
    heartbeat: 1,
    at: Date.now(),
    state: "idle",
    counts: { wedged: 0, watch: 0 },
    canary: "ok",
    canaryDetail: "seeded",
    policy: "flight-deck.jsonc",
    sessions: 0,
    ledger: 0,
    stale: 0,
    unknown: 0,
    blind: 0,
    reader: "unknown",
    readerAt: 0,
  })
  const seedSlot = (generation: string, alive: boolean) => ({
    generation,
    alive,
    stats: seedStats(),
    sessions: new Map<string, string>(),
    lastSeen: new Map<string, number>(),
    recorded: new Map<string, number>(),
    pendingContextNotes: new Map(),
    lastContextNoteAt: new Map(),
    status: "seeded",
  })
  // One rpc registration per setup, captured in order: the reader's read path.
  const rpcHandlers: any[] = []
  const fakeCtx = () => ({
    session: { hook: async () => {} },
    rpc: {
      register: async (_shape: any, handlers: any) => {
        rpcHandlers.push(handlers)
      },
    },
    tool: { transform: async () => {} },
    storage: {
      get: async () => undefined,
      set: async () => {},
      scan: async () => ({ entries: [] }),
      remove: async () => {},
    },
  })

  // (a) THE ORPHAN: the incident's end state - alive=false, no timer left.
  {
    globals[CLAIM] = seedSlot("dead-orphan", false)
    const before = globals[CLAIM]
    await setupLifeline(fakeCtx())
    const after = globals[CLAIM]
    checkTrue("lifeline orphan (alive:false) is adopted by a fresh setup", after !== before)
    checkTrue("lifeline the adopted slot carries a NEW generation", after?.generation !== "dead-orphan", String(after?.generation))
    check("lifeline the adopted slot is alive", after?.alive, true)
    const h0 = after?.stats?.heartbeat ?? -1
    const at0 = after?.stats?.at ?? 0
    await sleep(1_300)
    checkTrue("lifeline the adopted owner starts beating (heartbeat advances)", (after?.stats?.heartbeat ?? -1) > h0, `${h0} -> ${after?.stats?.heartbeat}`)
    checkTrue("lifeline the adopted owner stamps a fresh heartbeat time", (after?.stats?.at ?? 0) > at0)
    if (after?.timer) clearInterval(after.timer)
  }

  // (b) FROZEN BUT STILL `alive`: an owner that died without running cleanup.
  // The horizon, not the flag, is what makes this claimable.
  {
    globals[CLAIM] = seedSlot("frozen-alive", true)
    globals[CLAIM].stats.at = Date.now() - 600_000
    const before = globals[CLAIM]
    await setupLifeline(fakeCtx())
    const after = globals[CLAIM]
    checkTrue("lifeline a stale `alive` slot is adopted too", after !== before && after?.alive === true)
    checkTrue("lifeline the frozen generation is replaced", after?.generation !== "frozen-alive", String(after?.generation))
    const h0 = after?.stats?.heartbeat ?? -1
    await sleep(1_300)
    checkTrue("lifeline the frozen slot's new owner beats", (after?.stats?.heartbeat ?? -1) > h0)
    if (after?.timer) clearInterval(after.timer)
  }

  // (c) A FRESH live incumbent is NEVER stolen: single-owner is preserved.
  {
    const incumbent = seedSlot("live-incumbent", true)
    incumbent.timer = setInterval(() => {
      incumbent.stats.heartbeat += 1
      incumbent.stats.at = Date.now()
    }, 100)
    globals[CLAIM] = incumbent
    await setupLifeline(fakeCtx())
    checkTrue("lifeline a fresh live incumbent keeps its slot", globals[CLAIM] === incumbent)
    check("lifeline the newcomer becomes a follower", globals[CLAIM]?.generation, "live-incumbent")
    const h0 = incumbent.stats.heartbeat
    await sleep(300)
    checkTrue("lifeline the incumbent keeps beating, undisarmed", incumbent.stats.heartbeat > h0)
    clearInterval(incumbent.timer)
  }

  // (d) THE INCIDENT ORDERING, end to end, with NO further setup. A arms; B is
  // born a follower while A is alive; A's cleanup clears the ONLY timer and
  // leaves a dead, readable slot. The reader's status read must re-arm it.
  {
    globals[CLAIM] = undefined
    const cleanupA = await setupLifeline(fakeCtx())
    const slotA = globals[CLAIM]
    check("lifeline A claims the slot", slotA?.alive, true)
    await setupLifeline(fakeCtx()) // B: follower, because A is alive and fresh
    checkTrue("lifeline B follows (one owner, not two)", globals[CLAIM] === slotA)
    cleanupA()
    checkTrue("lifeline A's cleanup leaves the dead slot readable", globals[CLAIM] === slotA)
    check("lifeline ...and it is no longer alive", slotA.alive, false)

    const handler = rpcHandlers[rpcHandlers.length - 1]
    checkTrue("lifeline a status read is registered on the follower too", typeof handler?.snapshot === "function")
    const readBefore: any = await handler.snapshot()
    checkTrue("lifeline the read still renders a snapshot after death", typeof readBefore?.heartbeat === "number")
    const revived = globals[CLAIM]
    checkTrue("lifeline the status read ADOPTS the dead slot", revived !== slotA)
    check("lifeline the re-armed daemon is alive", revived?.alive, true)
    const h0 = revived?.stats?.heartbeat ?? -1
    const at0 = revived?.stats?.at ?? 0
    await sleep(1_300)
    checkTrue("lifeline the re-armed daemon beats with NO fresh setup", (revived?.stats?.heartbeat ?? -1) > h0, `${h0} -> ${revived?.stats?.heartbeat}`)
    checkTrue("lifeline the re-armed daemon stamps a fresh time", (revived?.stats?.at ?? 0) > at0)
    // A second read must NOT churn generations: the daemon is healthy again.
    const revivedGeneration = revived?.generation
    await handler.snapshot()
    check("lifeline a second read does not re-claim a healthy daemon", globals[CLAIM]?.generation, revivedGeneration)
    if (revived?.timer) clearInterval(revived.timer)
  }

  globals[CLAIM] = savedSlot
}

// ---------------------------------------------------------------------------
// Part L9 - FIX B: `execute` carries its own deliberate bound. The shipped
// table and ceiling live in config.ts (`DEFAULT_TOOL_WATCH_MS` /
// `DEFAULT_CEILING_MS`) and reach the sweep merged with the `caution` block's
// overrides through the policy - asserted on source the same way Part L7
// asserts lifeline.ts's wiring, plus functionally through `lifelinePolicy`. The
// bound must be EXPLICIT (never the configurable fallback) and must stay under
// the hard ceiling, whose min() math is unchanged in shape.
// ---------------------------------------------------------------------------
{
  const lifelineSrc = readUnitSource("lifeline.ts");
  const configSrc = readUnitSource("config.ts");
  const table = configSrc.slice(
    configSrc.indexOf("export const DEFAULT_TOOL_WATCH_MS"),
    configSrc.indexOf("export const DEFAULT_CEILING_MS"),
  );
  // The built-in exempt list moved with the config read: it is the fallback for
  // `caution.exemptTools`, so it now lives in config.ts.
  const exempt = configSrc.slice(
    configSrc.indexOf("const DEFAULT_EXEMPT"),
    configSrc.indexOf("const FALLBACK_WATCH_MS"),
  );
  checkTrue("lifeline execute carries an explicit watch bound", /execute:\s*300_000/.test(table), table.slice(0, 160));
  checkTrue("lifeline the execute bound stays under the 600s ceiling", 300_000 < 600_000);
  checkTrue("lifeline execute is NOT in the built-in exempt list", !/"execute"/.test(exempt), exempt.slice(0, 160));
  checkTrue("lifeline the ceiling min() math is policy-driven", /Math\.min\(policy\.toolBoundsMs\[tool\] \?\? policy\.fallbackMs, policy\.ceilingMs\)/.test(lifelineSrc));
  checkTrue("lifeline the shipped table is re-exported for readers", /export \{ DEFAULT_TOOL_WATCH_MS as PER_TOOL_WATCH_MS, DEFAULT_CEILING_MS as CEILING_WATCH_MS \}/.test(lifelineSrc));
  checkTrue("lifeline the shipped ceiling is still 600s", /export const DEFAULT_CEILING_MS = 600_000/.test(configSrc));
  // Functionally: the staged file names no overrides, so the policy carries
  // the shipped table and ceiling untouched.
  check("lifeline policy carries the shipped execute bound", (stagedLifeline as any).toolBoundsMs?.execute, 300_000);
  check("lifeline policy carries the shipped read bound", (stagedLifeline as any).toolBoundsMs?.read, 120_000);
  check("lifeline policy ceiling is the shipped 600s", (stagedLifeline as any).ceilingMs, 600_000);
}

// ---------------------------------------------------------------------------
// Part L10 - FIX C: a hung call must be WEDGE-ELIGIBLE (see the header).
//
// The probe's four shapes and the sweep's decision, as a table over
// (shape, pastBound) -> verdict:
//
//   live            past bound -> wedge              (plain live wedge)
//   unknown-stalled past bound -> wedge              <- THE FIX
//   stale           past bound -> stale-row          (idle: never repaired)
//   unknown-probe   past bound -> unknown-liveness   (failed probe: never repaired)
//   any of the four under bound -> watch
//
// `unknown-stalled` is the shape a REAL hang lands in: the session exists (the
// sweep already dropped every session whose `session.get` failed), it is not
// idle, and its `time.updated` still predates the call's start because a tool
// part is written before it runs. `unknown-probe` is a FAILED probe - no signal -
// and must never be wedge-eligible.
// ---------------------------------------------------------------------------
{
  const decideWedge: (shape: string, pastBound: boolean) => unknown =
    typeof (lifelineMod as any).decideWedge === "function"
      ? (lifelineMod as any).decideWedge
      : () => "MISSING(decideWedge)"
  const table: Array<[string, boolean, string]> = [
    ["live", true, "wedge"],
    ["unknown-stalled", true, "wedge"],
    ["stale", true, "stale-row"],
    ["unknown-probe", true, "unknown-liveness"],
    ["live", false, "watch"],
    ["unknown-stalled", false, "watch"],
    ["stale", false, "watch"],
    ["unknown-probe", false, "watch"],
  ]
  console.log("       lifeline liveness x bound -> verdict")
  for (const [shape, pastBound, expected] of table) {
    check(
      `lifeline verdict: ${shape} ${pastBound ? "past bound" : "under bound"} -> ${expected}`,
      decideWedge(shape, pastBound),
      expected,
    )
  }
  // The gate the fix exists for, stated as one assertion: the shape a real hang
  // lands in is wedge-eligible.
  checkTrue("lifeline timestamp-unknown past its bound is WEDGE-ELIGIBLE", decideWedge("unknown-stalled", true) === "wedge");
  checkTrue("lifeline probe-exception past its bound is NOT wedge-eligible", decideWedge("unknown-probe", true) !== "wedge");

  // Source wiring: the table above only decides if the probe reports the two
  // `unknown` sources as DISTINCT values and the sweep uses the table. Asserted
  // on source, the same way Part L7 asserts lifeline.ts's wiring.
  const src = readUnitSource("lifeline.ts");
  const probe = src.slice(
    src.indexOf("const liveness = async"),
    src.indexOf("const sweep = async"),
  );
  checkTrue("lifeline the probe returns a distinct timestamp-unknown", /return "unknown-stalled"/.test(probe), probe.slice(0, 200))
  checkTrue("lifeline the probe returns a distinct probe-exception", /return "unknown-probe"/.test(probe), probe.slice(0, 200))
  checkTrue("lifeline the probe no longer collapses both into bare `unknown`", !/Promise<"live" \| "stale" \| "unknown">/.test(probe))
  const sweep = src.slice(src.indexOf("const sweep = async"), src.indexOf("slot.stats.counts = { wedged, watch }"));
  checkTrue("lifeline the sweep decides through the table", /const verdict = decideWedge\(shape, true\)/.test(sweep), sweep.slice(0, 400));
  checkTrue("lifeline the sweep gates on the probe-exception verdict", /verdict === "unknown-liveness"/.test(sweep));
  checkTrue("lifeline the sweep no longer gates on bare shape === unknown", !/shape === "unknown"/.test(sweep));
  checkTrue("lifeline repair is still the single interrupt rung", /ctx\.session\.interrupt\(\{ sessionID, resume: true \}\)/.test(sweep));
}

// ---------------------------------------------------------------------------
// Part L11 - FIX D RETIRED: the daemon measures nothing and arms nothing.
//
// The dynamic nudge point (context.dynamic) went with the nudger: no window is
// validated, no point is computed, the daemon never reads the model catalog or
// scans token accounting, and no inbox event or tick arms a pending note. The
// note channel itself (Part L6) still delivers; it is simply never fed by a
// measurement here. Proved functionally against the REAL setup plus on source.
// ---------------------------------------------------------------------------
{
  const lifeClaim = Symbol.for('oc-lifeline.daemon.v1');
  const globals = globalThis as Record<PropertyKey, any>;
  const savedLife = globals[lifeClaim];
  globals[lifeClaim] = undefined;

  const touched: Array<{ op: string; key: string }> = [];
  const q = makeQueue();
  let catalogReads = 0;
  let contextReads = 0;
  const ctx = {
    session: {
      hook: async () => ({ dispose: async () => {} }),
      get: async () => ({ data: { model: { id: 'probe/model' }, time: { updated: Date.now() } } }),
      context: async () => {
        contextReads += 1;
        return {
          data: [
            {
              type: 'assistant',
              tokens: { input: 90_000, cache: { read: 0 } },
              time: { completed: Date.now() },
            },
          ],
        };
      },
    },
    model: {
      list: async () => {
        catalogReads += 1;
        return [{ id: 'probe/model', limit: { context: 100_000 } }];
      },
    },
    event: { subscribe: () => q },
    rpc: { register: async () => {} },
    tool: { transform: async () => {} },
    storage: {
      get: async (key: string) => { touched.push({ op: 'get', key }); return undefined; },
      set: async (key: string) => { touched.push({ op: 'set', key }); },
      scan: async (args: any) => { touched.push({ op: 'scan', key: String(args?.prefix ?? '') }); return { entries: [] }; },
      remove: async (key: string) => { touched.push({ op: 'remove', key }); },
    },
  };

  const cleanup = await lifelineMod.setupLifeline(ctx);
  // A 90%-full window on the event the nudger used to evaluate on, plus time
  // for the sweep to run: nothing may be measured, persisted, or armed.
  q.push({ type: 'session.inbox.enqueued', data: { sessionID: 'measure-probe' } });
  await new Promise((r) => setTimeout(r, 400));

  check("lifeline the daemon never reads the model catalog", catalogReads, 0);
  check("lifeline the daemon never reads token accounting", contextReads, 0);
  check("lifeline no pending note is armed by measurement", globals[lifeClaim]?.pendingContextNotes?.size ?? -1, 0);
  checkTrue(
    "lifeline measurement touches no storage at all",
    touched.length === 0,
    JSON.stringify(touched),
  );

  const src = readUnitSource('lifeline.ts');
  checkTrue("lifeline setup reads no model catalog", !/ctx\.model\?\.list/.test(src));
  checkTrue("lifeline setup scans no token accounting", !/tokens\?\.input|cache\?\.read/.test(src));
  checkTrue("lifeline the context tick is gone", !/CONTEXT_EVERY_TICKS|context pass/.test(src));
  checkTrue("lifeline inbox events arm nothing", !/session\.inbox\.enqueued/.test(src));

  await cleanup();
  if (globals[lifeClaim]?.timer) clearInterval(globals[lifeClaim].timer);
  globals[lifeClaim] = savedLife;
  q.close();
}

// ---------------------------------------------------------------------------
// Part F1 - P2: FEATURE ISOLATION at the unified entry.
//
// As three SEPARATE plugins, one unit's setup could not stop another's: the host
// wired each independently. The fusion must not create that coupling. This is the
// reviewer's mocked scenario, now inside the gate: `ctx.session.hook` rejects -
// the live lifeline accepted its absence (`live plugins/oc-lifeline/index.ts:832`)
// while `fleet.ts:870` calls it unconditionally - so `setupFleet` rejects. Fleet
// must fail ALONE: lifeline and masthead still wire, and the failure is REPORTED
// through the unit's note path, never swallowed.
// ---------------------------------------------------------------------------
{
  const lifeClaim = Symbol.for('oc-lifeline.daemon.v1');
  const fleetClaim = Symbol.for('oc-fleet.v1');
  const globals = globalThis as Record<PropertyKey, any>;
  const savedLife = globals[lifeClaim];
  const savedFleet = globals[fleetClaim];
  const savedMasthead = globals['__ocMasthead'];

  // The note path is env-overridden, the same override idiom the fleet watcher
  // used for OC_FLEET_MARKER, so this part proves the report without touching the
  // live state root.
  const notePath = resolve(fixtureDir, `oc-unified-note-${runID}.log`);
  rmSync(notePath, { force: true });
  process.env.OC_UNIFIED_NOTE = notePath;

  const registered: string[] = [];
  const isoSubscribers: any[] = [];
  const isoCtx = {
    session: {
      // The reviewer's mock: the context hook is unusable on this host.
      hook: async () => {
        throw new Error('session.hook unavailable (reviewer mock)');
      },
      get: async () => undefined,
      update: async () => {},
      context: async () => ({ data: [] }),
    },
    event: {
      subscribe: () => {
        const q = makeQueue();
        isoSubscribers.push(q);
        return q;
      },
    },
    rpc: {
      register: async (shape: any) => {
        registered.push(String(shape?.id ?? ''));
      },
    },
    tool: { transform: async () => {} },
    storage: {
      get: async () => undefined,
      set: async () => {},
      scan: async () => ({ entries: [] }),
      remove: async () => {},
    },
  };

  let setupError: unknown = null;
  let isoDispose: any = null;
  try {
    isoDispose = await plugin.setup(isoCtx);
  } catch (error) {
    setupError = error;
  }

  check('isolation: a fleet setup failure does not reject the unified setup', setupError, null);
  checkTrue('isolation: the unified setup still returns its disposer', typeof isoDispose === 'function');
  checkTrue('isolation: lifeline is wired despite the fleet failure', registered.includes('oc-lifeline'), JSON.stringify(registered));
  checkTrue('isolation: masthead is wired despite the fleet failure', registered.includes('oc-masthead'), JSON.stringify(registered));
  checkTrue('isolation: lifeline still claimed its daemon slot', globals[lifeClaim]?.alive === true);

  const noteText = existsSync(notePath) ? readFileSync(notePath, 'utf8') : '';
  checkTrue('isolation: the fleet failure is REPORTED, not swallowed', noteText.includes('feature fleet failed to wire'), JSON.stringify(noteText));
  checkTrue('isolation: the note names the cause', /feature fleet failed to wire: .*hook unavailable/.test(noteText), JSON.stringify(noteText));
  checkTrue(
    'isolation: the note is one timestamped line',
    /^feature fleet failed to wire: .+ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n$/.test(noteText),
    JSON.stringify(noteText),
  );

  // Teardown, then restore every process-wide thing this part touched.
  if (typeof isoDispose === 'function') await isoDispose();
  for (const q of isoSubscribers) q.close();
  globals['__ocMasthead']?.controller?.abort?.();
  if (globals[lifeClaim] !== savedLife && globals[lifeClaim]?.timer) clearInterval(globals[lifeClaim].timer);
  globals[lifeClaim] = savedLife;
  globals[fleetClaim] = savedFleet;
  globals['__ocMasthead'] = savedMasthead;
  rmSync(notePath, { force: true });
  delete process.env.OC_UNIFIED_NOTE;
}

// ---------------------------------------------------------------------------
// Part F2 - P1: lifeline's storage surface is LEDGER-ONLY.
//
// Plugin-scoped storage is host-scoped per plugin id, so the fused plugin owns
// ONE namespace shared by all three features: every lifeline key must be
// `lifeline:`-prefixed, or the features can collide inside it. The bands, the
// burn-rate windows, and the nudge counters went with the nudger - the ONLY
// lifeline storage left is the observation ledger. Proved FUNCTIONALLY against
// the REAL setup (a recording storage double sees a genuine wedge write) and,
// for the declaration sites, on source.
// ---------------------------------------------------------------------------
{
  const lifeClaim = Symbol.for('oc-lifeline.daemon.v1');
  const globals = globalThis as Record<PropertyKey, any>;
  const savedLife = globals[lifeClaim];
  globals[lifeClaim] = undefined;

  const probe = 'wedge-probe';
  const seen: Array<{ op: string; key: string }> = [];
  const q = makeQueue();
  const callStarted = Date.now() - 200_000;
  const ctx = {
    session: {
      hook: async () => ({ dispose: async () => {} }),
      get: async () => ({ data: { time: { idle: 0, updated: Date.now() } } }),
      context: async () => ([
        {
          parts: [
            {
              type: 'tool',
              id: 'part-1',
              name: 'read',
              state: { status: 'running', input: {} },
              time: { ran: callStarted },
            },
          ],
        },
      ]),
    },
    event: { subscribe: () => q },
    rpc: { register: async () => {} },
    tool: { transform: async () => {} },
    storage: {
      get: async (key: string) => {
        seen.push({ op: 'get', key });
        return undefined;
      },
      set: async (key: string) => {
        seen.push({ op: 'set', key });
      },
      scan: async (args: any) => {
        seen.push({ op: 'scan', key: String(args?.prefix ?? '') });
        return { entries: [] };
      },
      remove: async (key: string) => {
        seen.push({ op: 'remove', key });
      },
    },
  };

  const cleanup = await lifelineMod.setupLifeline(ctx);
  // The sweep runs every 5 s once a session is known: a `read` call 200 s old
  // is past its 120 s bound on a live session, so a wedge is recorded.
  q.push({ type: 'session.step.started', data: { sessionID: probe } });
  await new Promise((r) => setTimeout(r, 6_500));

  const keys = seen.map((s) => s.key);
  checkTrue('storage prefix: the real setup writes the ledger at all', keys.length > 0, JSON.stringify(keys));
  checkTrue('storage prefix: every lifeline key is namespaced', keys.every((k) => k.startsWith('lifeline:')), JSON.stringify(keys));
  checkTrue('storage prefix: the wedge WRITE is a ledger key', keys.some((k) => k.startsWith('lifeline:ledger:')), JSON.stringify(keys));
  checkTrue(
    'storage prefix: no band, rate, or counter key survives',
    !keys.some((k) => /ctxband|ctxrate|ctxstats/.test(k)),
    JSON.stringify(keys),
  );
  checkTrue(
    'storage prefix: no bare legacy key survives',
    !keys.some((k) => /^(ctxband|ctxrate|ctxstats|ledger)/.test(k)),
    JSON.stringify(keys),
  );

  // Source, for the declaration sites: the namespace is declared once, the
  // ledger key rides it, every storage call takes a namespaced constant.
  const src = readUnitSource('lifeline.ts');
  checkTrue('storage prefix: the namespace is declared once', /const STORAGE_NS = "lifeline:"/.test(src));
  checkTrue('storage prefix: the ledger key is namespaced', /const LEDGER_PREFIX = `\$\{STORAGE_NS\}ledger:`/.test(src));
  const bareKey = /storage\.(?:get|set|remove)\(\s*["'`](?!\$\{)/;
  checkTrue('storage prefix: no storage call takes a bare literal key', !bareKey.test(src), (src.match(bareKey) ?? []).join(','));
  const scans = [...src.matchAll(/storage\.scan\(\{\s*prefix:\s*([A-Za-z_]+)/g)].map((m) => m[1]);
  checkTrue(
    'storage prefix: every scan prefix is the namespaced ledger constant',
    scans.length >= 1 && scans.every((p) => ['LEDGER_PREFIX'].includes(p)),
    JSON.stringify(scans),
  );

  await cleanup();
  if (globals[lifeClaim]?.timer) clearInterval(globals[lifeClaim].timer);
  globals[lifeClaim] = savedLife;
  q.close();
}

// ---------------------------------------------------------------------------
// Part N - neutral defaults: a stranger's tree is observe-only until
// configured, and every harness-specific assumption is a config key.
// ---------------------------------------------------------------------------
{
  // N1 masthead: the neutral default carries no vocabulary, so the grammar
  // matchers match nothing and the renamer does not enforce.
  check("neutral title config has no statuses", DEFAULT_TITLE_CONFIG.statuses.length, 0);
  check("neutral title config has no seats", DEFAULT_TITLE_CONFIG.seats.length, 0);
  check("neutral title config has no legacy seats", DEFAULT_TITLE_CONFIG.legacySeats.length, 0);
  check("neutral grammar matches nothing", isGrammarTitleRaw("active build: ship it", "build"), false);
  check("neutral status never parses", titleParseStatusRaw("done build: ship it"), undefined);
  check("neutral close status never parses", parseCloseStatusRaw("close:\n  status: done\n"), undefined);
  check("neutral title shape never matches", titleRe().test("active build: ship it"), false);
  check("neutral renamer does not enforce", isEnforcingConfig(), false);
  check("harness vocab enforces", isEnforcingConfig(HARNESS_TITLE), true);
  check("neutral asStatus rejects everything", asStatusRaw("active"), undefined);
  // mergeTitleConfig with no vocabulary stays neutral (absent keys, not the
  // old hardcoded fallback).
  const mergedEmpty = mergeTitleConfig({});
  check("merge with no vocab stays neutral", mergedEmpty.statuses.length + mergedEmpty.seats.length + mergedEmpty.legacySeats.length, 0);

  // N2 fleet: neutral terminality is empty, host status is preferred, and the
  // recipient strategy parses all three rungs.
  check("neutral tokens match nothing", isTerminalTitle("done build: ship it"), false);
  check("neutral session matches nothing", isTerminalSession({ title: "done build: ship it", status: "done" }), false);
  check("host status wins over title", isTerminalSession({ title: "active build: ship it", status: "done" }, HARNESS_TOKENS), true);
  check("title token is the fallback", isTerminalSession({ title: "done build: ship it" }, HARNESS_TOKENS), true);
  check("live session is not terminal", isTerminalSession({ title: "active build: ship it", status: "busy" }, HARNESS_TOKENS), false);
  const offPolicy = readPolicy({ options: { "oc-fleet": { recipient: "off" } } });
  check("recipient off parses", (offPolicy as any).recipient, "off");
  const offDeck = createDeck(fakeContext(), { ...activePolicy, recipient: "off", target: null });
  check("recipient off resolves no one", offDeck.resolveRecipient("ses_note_old"), undefined);
  offDeck.stop();
  const noAutoDeck = createDeck(fakeContext(), { ...activePolicy, autoWatchChildren: false, watch: [] });
  await noAutoDeck.handleEvent({ type: "session.created", data: { sessionID: "ses_manual_child", parentID: "ses_parent", title: "child work" } });
  checkTrue("autoWatchChildren false skips workers", !noAutoDeck.state.watch.has("ses_manual_child"));
  noAutoDeck.stop();
  const autoDeck = createDeck(fakeContext(), { ...activePolicy, autoWatchChildren: true, watch: [] });
  await autoDeck.handleEvent({ type: "session.created", data: { sessionID: "ses_auto_child", parentID: "ses_parent", title: "child work" } });
  checkTrue("autoWatchChildren true keeps current behavior", autoDeck.state.watch.has("ses_auto_child"));
  autoDeck.stop();

  // N3 config path: neutral default is oc-unified.jsonc (XDG-aware), with an
  // explicit override in both options and env. Both plugin spec forms work: a
  // bare string (no options) and {package, options}.
  check("default config file is neutral", DEFAULT_CONFIG_NAME, "oc-unified.jsonc");
  check("default config path ends neutral", configPath({}).endsWith(join("opencode", "oc-unified.jsonc")), true);
  check("XDG config home is honoured", configPath({ XDG_CONFIG_HOME: join(tmpdir(), "xdg-cfg") }), join(tmpdir(), "xdg-cfg", "opencode", "oc-unified.jsonc"));
  check("env override wins over default", configPath({ OC_UNIFIED_CONFIG: stagedConfigPath }), stagedConfigPath);
  check("options override wins over env", configPath({ OC_UNIFIED_CONFIG: stagedConfigPath }, { config: "custom.jsonc" }), "custom.jsonc");
  check("bare-string options name the file", optionsConfigPath("shared.jsonc"), "shared.jsonc");
  check("oc-unified sub-object names the file", optionsConfigPath({ "oc-unified": { config: "shared.jsonc" } }), "shared.jsonc");
  check("bare string (no options) still reads the file", fleetBlock(undefined, undefined)?.enabled, true);
  check("config source is the basename", configSource(stagedConfigPath), stagedBase);

  // N4 lifeline overrides: per-tool bounds and the ceiling move without code.
  const overridePath = resolve(fixtureDir, `oc-unified-override-${runID}.jsonc`);
  writeFileSync(overridePath, JSON.stringify({ caution: { toolBoundsMs: { read: 60_000 }, ceilingSeconds: 300 } }));
  const realCfg = process.env.OC_UNIFIED_CONFIG;
  process.env.OC_UNIFIED_CONFIG = overridePath;
  const overriddenPolicy = lifelinePolicy();
  check("toolBoundsMs override lands", (overriddenPolicy as any).toolBoundsMs?.read, 60_000);
  check("unnamed tools keep shipped bounds", (overriddenPolicy as any).toolBoundsMs?.grep, 180_000);
  check("ceilingSeconds override lands", (overriddenPolicy as any).ceilingMs, 300_000);
  process.env.OC_UNIFIED_CONFIG = realCfg;
  rmSync(overridePath, { force: true });

  // N5 state dir: platform default with an explicit override for trees that
  // keep historical paths.
  checkTrue("state dir resolves under no override", typeof resolveStateDir() === "string" && resolveStateDir().length > 0);
  check("state dir env override wins", resolveStateDir({ OC_UNIFIED_STATE: join(tmpdir(), "oc-state") }), join(tmpdir(), "oc-state"));
  check("state dir options override wins", resolveStateDir({}, { stateDir: join(tmpdir(), "oc-opt-state") }), join(tmpdir(), "oc-opt-state"));

  // N6 pulse gate is a plain policy boolean (source: no regex on config text).
  // The status RPC reports the gate; the plugin renders nothing either way.
  const daemonSrc = readUnitSource("lifeline.ts");
  checkTrue("pulse gate reads the policy boolean", daemonSrc.includes("policy.pulseEnabled"));
  checkTrue("pulse gate renders nothing", daemonSrc.includes("this plugin renders nothing"));
  checkTrue("pulse gate keeps no config-text regex", !/indexOf\('"lifeline"'\)/.test(daemonSrc));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
