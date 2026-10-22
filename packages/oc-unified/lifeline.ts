// ═══════════════════════════════════════════════════════════════════════════
//  oc-unified - the lifeline feature.
//  (moved from plugins/oc-lifeline/index.ts + plugins/oc-lifeline/status.ts)
//
//  SECTION 1 is the headless daemon: the liveness sweep (per-tool bounds, the
//  600 s ceiling, the observation ledger) and the reader freshness exports.
//  (The advisory context nudger that used to live here - the band ladder, the
//  dynamic nudge point, the projection and safety paths - was removed; the DCP
//  plugin owns that surface now.) SECTION 2 is the event/RPC/tool wiring: an
//  exported async `setupLifeline(ctx)` returning a disposer, wired by index.ts
//  into the single oc-unified plugin, plus the SILENT `context` hook through
//  which escalation notes reach a session's outgoing model context. (There is
//  no SECTION 3: the display row that used to live here is gone - this
//  plugin renders nothing.)
//
//  Detection is AGE-BASED, read from the persisted projection
//  (`ctx.session.context`). An in-flight tool IS persisted with `state.status`
//  "running" at call time and stays that way until it settles, so age against a
//  per-tool threshold is the only honest signal. Progress events are ephemeral and
//  carry no projector: there is no progress signal to design around.
//
//  ACTION: whole-session interrupt is the ONLY lever (there is no API to fail or
//  settle an in-flight call). Interrupt settles the stale call at drain start and
//  `resume: true` restarts the work. Repair is OFF by default: this build records
//  what it WOULD have done and never acts.
//
//  DECLINED: `ctx.tool.list()` returns live executors, and a plugin could build a
//  Tool.Context and invoke one directly, bypassing permission gating and the
//  before/after hooks. Nothing here needs it. It is recorded in the ledger as
//  declined.
//
//  SHAPE CANARY: the projection's shape is asserted at startup and on every sweep.
//  If tool parts stop carrying a known `state.status`, the daemon says so loudly
//  and stops acting rather than going quiet.
//
//  CONFIG: the `lifeline` / `caution` blocks are read, defaulted and
//  validated by config.ts (`lifelinePolicy`) through the one resolver path. The
//  two marker paths sit under the platform state directory (config.ts
//  `stateDir`, overridable with `OC_UNIFIED_STATE`), never a literal user path
// ═══════════════════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode/plugin"
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CEILING_MS, DEFAULT_TOOL_WATCH_MS, lifelinePolicy, stateDir } from "./config.ts"

// The daemon's own marker: the ledger of what the sweep saw and would have done.
// Under the platform state directory (config.ts `stateDir`: an explicit
// `OC_UNIFIED_STATE` override wins, else the platform convention), so no
// committed byte carries a user path.
export const MARKER = join(stateDir(), "oc-lifeline.log")
// The READER's own marker: freshness must be measured against the reader's writes,
// never against this file, or the check measures the daemon's own heartbeat and
// produces a self-licking DEAD/LIVE loop.
export const READER_MARKER = join(stateDir(), "oc-lifeline-reader.log")

// Bound the append-only diagnostic log: past the cap, keep only the final
// KEEP bytes, trimmed to the next newline so no partial line survives.
export const LOG_CAP_BYTES = 1_048_576
export const LOG_KEEP_BYTES = 262_144
export function trimLogFile(path: string) {
  try {
    if (statSync(path).size <= LOG_CAP_BYTES) return
    const tail = readFileSync(path).subarray(-LOG_KEEP_BYTES)
    const cut = tail.indexOf(10)
    writeFileSync(path, cut < 0 ? tail : tail.subarray(cut + 1))
  } catch {
    // never let diagnostics take the daemon down
  }
}

const CLAIM = Symbol.for("oc-lifeline.daemon.v1")
const TICK_MS = 1_000
const SWEEP_EVERY_TICKS = 5
// ORPHAN ADOPTION horizon. A slot whose `stats.at` is older than this is treated
// as a DEAD owner and may be claimed by any setup or status read. 90 s = 18x
// the 5 s sweep cadence (SWEEP_EVERY_TICKS x TICK_MS): only a genuinely frozen
// heartbeat is adopted, never a tick that is merely late or an event loop
// briefly blocked.
const ORPHAN_STALE_MS = 90_000
export const READER_STALE_MS = 10_000
export const SESSION_TTL_MS = 30 * 60_000
const MAX_SESSIONS = 64
// STORAGE NAMESPACE. The fused plugin owns ONE plugin-scoped storage namespace,
// shared by all three features, so every lifeline key carries an explicit
// `lifeline:` prefix and the three features can never collide inside it. The
// only lifeline storage left is the observation ledger.
const STORAGE_NS = "lifeline:"
const LEDGER_PREFIX = `${STORAGE_NS}ledger:`

// The per-tool watch table and the hard global ceiling ship in config.ts
// (`DEFAULT_TOOL_WATCH_MS` / `DEFAULT_CEILING_MS`) and arrive here merged with
// the `caution` block's overrides (`toolBoundsMs` / `ceilingSeconds`) through
// the lifeline policy - re-exported here so readers keep their import site,
// with exactly one value behind them. A background shell is EXEMPT
// (`state.input.timeout === 0` means running by design), and the policy's own
// exempt list applies on top.
//
// A NON-exempt call older than the ceiling is WEDGED whatever its per-tool
// bound says; the effective bound is Math.min(per-tool-or-fallback, ceiling).
// The per-tool table is unchanged by it - the ceiling only ever LOWERS the
// limit. Both stay overridable without a code change.
// `execute` runs the Code Mode catalog ONLY: nothing it can await is
// background-by-design (see config.ts), so its shipped bound sits under the
// ceiling and catches a wedged `execute` two minutes earlier than the 420 s
// fallback it used to inherit by accident.
export { DEFAULT_TOOL_WATCH_MS as PER_TOOL_WATCH_MS, DEFAULT_CEILING_MS as CEILING_WATCH_MS }
const STATUSES = new Set([
  "running",
  "streaming",
  "pending",
  "completed",
  "error",
  "aborted",
  "cancelled",
])
const UNSETTLED = new Set(["running", "streaming", "pending"])

// JSON-compatible stored value: mirrors `Schema.Json` from the storage contract
// (`ctx.storage.set` takes `Schema.Json`). Ledger entries are plain JSON, so the
// stored-value channel is typed as JSON here instead of `unknown` - no runtime
// change, the stored bytes are identical.
export type LedgerValue = string | number | boolean | null | readonly LedgerValue[] | {
  readonly [key: string]: LedgerValue
}

export type PendingContextNote = {
  message: string
  band: string
  pct: number
  used: number
  limit: number
  safety: boolean
  decidedBy: string
  projectionFields: Record<string, LedgerValue>
}

function note(tag: string) {
  try {
    trimLogFile(MARKER)
    appendFileSync(MARKER, `${tag} ${new Date().toISOString()}\n`)
  } catch {
    // never let diagnostics take the daemon down
  }
}

// ---------------------------------------------------------------------------
// NOTE CHANNEL - the silent `context` hook below delivers pending notes into a
// session's outgoing model context. Notes are armed with `armPendingContextNote`
// (per-session, spacing-throttled) and delivered once, then cleared.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// READER FRESHNESS - exported so a headless test can import it WITHOUT running
// the daemon. The daemon stamps MARKER on every sweep; external readers stamp
// READER_MARKER on every poll. Freshness is measured against the
// READER's writes only - never against the daemon's own MARKER, or the check
// measures its own heartbeat and produces a self-licking DEAD/LIVE loop.
// Absent, non-finite, or non-positive mtime is stale (false), never live.
// (No in-repo reader remains: this plugin claims no display surface, so a
// reader marker left by an older version simply ages out as stale.)
// ---------------------------------------------------------------------------

export function isReaderFresh(
  readerAtMs: unknown,
  nowMs: number,
  staleMs: number = READER_STALE_MS,
): boolean {
  if (typeof readerAtMs !== "number" || !Number.isFinite(readerAtMs) || readerAtMs <= 0) return false
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return false
  if (typeof staleMs !== "number" || !Number.isFinite(staleMs) || staleMs < 0) return false
  return nowMs - readerAtMs <= staleMs
}

// ---------------------------------------------------------------------------
// LIVE MAXIMUM OCCUPANCY - the current maximum pct across live sessions.
// Pure: same inputs, same number. A drop lowers the result - nothing is
// max-latched, so the snapshot and the reader always answer what is happening
// NOW, never latched.
// ---------------------------------------------------------------------------

export function liveMaxPct(pcts: Iterable<number | undefined | null>): number {
  let max = 0
  for (const pct of pcts) {
    if (typeof pct === "number" && Number.isFinite(pct) && pct > max) max = pct
  }
  return max
}

// LIVE-ONLY PRUNING (pure, headless-testable). `slot.sessions` is add-only on
// observed events, so dead sessions must be pruned or the count and the sweep
// keep iterating the dead. `isPresent` is the host liveness
// probe (session.get succeeds); when the host exposes no probe the caller
// passes an age check against `lastSeen` instead. Returns the removed ids.
export function pruneDeadSessions<T>(
  sessions: Map<string, T>,
  isPresent: (sessionID: string) => boolean,
): string[] {
  const removed: string[] = []
  for (const id of [...sessions.keys()]) {
    let live = false
    try {
      live = isPresent(id)
    } catch {
      live = false
    }
    if (!live) {
      sessions.delete(id)
      removed.push(id)
    }
  }
  return removed
}

// LIVE-ONLY PCT (pure, headless-testable). Maxes over LIVE sessions only, so
// a dead session's high-water mark never pins the reader's pct tail: a stale
// entry is skipped here because its session is not in `liveIds`.
export function livePctOverLive(
  bandState: Map<string, { pct: number }>,
  liveIds: Iterable<string>,
): number {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds)
  const pcts: number[] = []
  for (const [id, entry] of bandState) {
    if (live.has(id) && typeof entry?.pct === "number") pcts.push(entry.pct)
  }
  return liveMaxPct(pcts)
}

// LIVENESS VERDICT (pure, headless-testable). The liveness probe reports ONE of
// four shapes, and the sweep's decision is a table over (shape, pastBound):
//
//   live            not idle, and the session's timestamp moved since the call
//                   began: a plain live wedge past the bound.
//   unknown-stalled not idle, but the session's `time.updated` still PREDATES the
//                   call's start. This is the NORMAL shape of a hung call, not a
//                   dead row: the tool part is written before it runs, so nothing
//                   touches the session while the tool blocks. It is a real
//                   signal - the sweep pruned every dead session earlier (its
//                   `session.get` throw drops the row), so the session EXISTS and
//                   is not idle - therefore past the bound it WEDGES. Reading it
//                   as "no signal" is what disabled repair on both recorded
//                   incidents (`execute` 304s and 425s, never repaired).
//   stale           idle since the call began (`time.idle`, or `session.wait`
//                   resolved inside 1500ms): a stale row, never a wedge.
//   unknown-probe   the probe itself FAILED (the `catch`). That is no signal at
//                   all - a repair fired off a failed probe is a false positive -
//                   so it stays unactioned and is recorded as `unknown-liveness`.
//
// Repair stays the SINGLE interrupt rung; this only decides whether it is due.
export type LivenessShape = "live" | "stale" | "unknown-stalled" | "unknown-probe"
export type WedgeVerdict = "wedge" | "watch" | "stale-row" | "unknown-liveness"
export function decideWedge(shape: LivenessShape, pastBound: boolean): WedgeVerdict {
  if (!pastBound) return "watch"
  if (shape === "stale") return "stale-row"
  if (shape === "unknown-probe") return "unknown-liveness"
  return "wedge"
}

// ---------------------------------------------------------------------------
// SNAPSHOT DOCUMENT - the status shape the reader polls over RPC. Exported as
// a pure builder so a headless test can assert the shape WITHOUT running
// setup. `snapshot()` inside setup delegates to this; the wire shape lives
// here, once.
// ---------------------------------------------------------------------------

export type LifelineSnapshot = {
  heartbeat: number
  at: number
  state: string
  counts: { wedged: number; watch: number }
  canary: string
  canaryDetail: string
  policy: string
  sessions: number
  ledger: number
  // LIVE current maximum context occupancy across active sessions, or null when
  // nothing is measurable. Readers report it from the snapshot's pct tail.
  pct: number | null
}

export function buildSnapshot(stats: {
  heartbeat: number
  at?: number
  state: string
  counts: { wedged: number; watch: number }
  canary: string
  canaryDetail: string
  policy: string
  sessions: number
  ledger: number
  pct?: number | null
}): LifelineSnapshot {
  const pct = typeof stats.pct === "number" && Number.isFinite(stats.pct) ? Math.round(stats.pct) : null
  return {
    heartbeat: stats.heartbeat,
    at: Date.now(),
    state: stats.canary === "failed" ? "wedged" : stats.state,
    counts: stats.counts,
    canary: stats.canary,
    canaryDetail: stats.canaryDetail,
    policy: stats.policy,
    sessions: stats.sessions,
    ledger: stats.ledger,
    pct,
  }
}

export function armPendingContextNote(
  sessionID: string,
  pendingNotes: Map<string, PendingContextNote>,
  lastDeliveredAt: Map<string, number>,
  pendingNote: PendingContextNote,
  minNoteSeconds = 300,
  now = Date.now(),
): boolean {
  if (!sessionID || pendingNotes.has(sessionID)) return false
  const last = lastDeliveredAt.get(sessionID)
  if (last !== undefined && now - last < Math.max(0, minNoteSeconds) * 1_000) return false
  pendingNotes.set(sessionID, pendingNote)
  return true
}

export async function registerSilentContextHook(
  ctx: any,
  pendingNotes: Map<string, PendingContextNote>,
  lastDeliveredAt: Map<string, number>,
  onDelivered?: (sessionID: string, pendingNote: PendingContextNote) => void | Promise<void>,
): Promise<boolean> {
  if (typeof ctx.session?.hook !== "function") return false
  await ctx.session.hook("context", (event: any) => {
    const sessionID = String(event?.sessionID ?? "")
    const pendingNote = pendingNotes.get(sessionID)
    if (!sessionID || !pendingNote || !Array.isArray(event?.system)) return
    event.system.push({ type: "text", text: pendingNote.message })
    pendingNotes.delete(sessionID)
    lastDeliveredAt.set(sessionID, Date.now())
    try {
      void Promise.resolve(onDelivered?.(sessionID, pendingNote)).catch((error) =>
        note(`context note delivery callback failed: ${String(error)}`),
      )
    } catch (error) {
      note(`context note delivery callback failed: ${String(error)}`)
    }
  })
  return true
}

// Module-level RPC definition (consumed by name by another worker): the id,
// method names, and input/output shapes below are byte-identical to the
// previously inline literal.
export const lifelineRpcDefinition = {
  id: "oc-lifeline",
  methods: {
    snapshot: {
      // Any input: the handler takes none, and the CLI's --data sends the
      // body as a JSON string, which a strict object schema rejects.
      input: {},
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const

// ---------------------------------------------------------------------------
// Feature entry - wired by index.ts into the single oc-unified plugin.
//
// The daemon, the silent note channel, the RPC, and the `lifeline` tool are the
// whole of the live oc-lifeline unit's setup, moved here verbatim: the slot key,
// the RPC id and method, the tool's two actions, the per-tool bounds, the
// ceiling, and the ledger are contracts other things read, so none of them may
// drift.
// ---------------------------------------------------------------------------
export async function setupLifeline(ctx: Plugin.Context): Promise<() => void> {
  // Ownership is process-wide: the plugin instantiates once per LOCATION (a
  // burst of ~13 setups inside 100 ms was observed here) and each location
  // re-evaluates this module, so a module-level variable is NOT a shared guard.
  // The slot carries a generation, so a torn-down owner cannot disarm its
  // successor and the next setup re-arms instead of going silent.
  const globals = globalThis as Record<PropertyKey, any>
  const generation = Math.random().toString(36).slice(2)
  // `slot` is REASSIGNED whenever this instance claims a slot, so every closure
  // below reads the slot THIS instance actually owns - never a stale one.
  let slot = globals[CLAIM]

  // ORPHAN ADOPTION. `alive` alone is not a liveness test: an owner that dies
  // without running its cleanup leaves `alive: true` behind, and a successor
  // that evaluated the election while the incumbent was still alive became a
  // follower and claimed nothing - after which the incumbent's cleanup cleared
  // the ONLY timer and no later setup re-armed. The horizon closes that hole: a
  // slot whose heartbeat stopped is claimable again, however it got that way.
  const shouldAdopt = (candidate: any): boolean =>
    !(
      candidate &&
      candidate.alive &&
      Date.now() - Number(candidate?.stats?.at ?? 0) <= ORPHAN_STALE_MS
    )

  // Claim the process-wide slot for THIS generation. Two live owners must never
  // both sweep, so adopting DISARMS the predecessor first: its interval and its
  // event subscription are the only sweep drivers, and both hang off the slot.
  const claimSlot = (): boolean => {
    const current = globals[CLAIM]
    if (!shouldAdopt(current)) return false
    if (current) {
      try {
        if (current.timer) clearInterval(current.timer)
      } catch {
        // a dead handle is not a reason to refuse ownership
      }
      try {
        current.controller?.abort?.()
      } catch {
        // same
      }
      current.alive = false
    }
    globals[CLAIM] = {
      generation,
      alive: true,
      stats: {
        heartbeat: 0,
        at: Date.now(),
        state: "idle",
        counts: { wedged: 0, watch: 0 },
        canary: "unproven",
        canaryDetail: "no session observed yet",
        policy: "unread",
        sessions: 0,
        ledger: 0,
        stale: 0,
        unknown: 0,
        blind: 0,
        reader: "unknown",
        readerAt: 0,
      },
      sessions: new Map<string, string>(),
      lastSeen: new Map<string, number>(),
      recorded: new Map<string, number>(),
      pendingContextNotes: new Map<string, PendingContextNote>(),
      lastContextNoteAt: new Map<string, number>(),
      status: "claimed: no session observed yet",
    }
    slot = globals[CLAIM]
    return true
  }

  const incumbent = globals[CLAIM]
  const owner = claimSlot()
  slot.pendingContextNotes ??= new Map<string, PendingContextNote>()
  slot.lastContextNoteAt ??= new Map<string, number>()
  note(
    `setup generation=${generation} ${owner ? (incumbent ? "owner (adopted a stopped slot)" : "owner") : "follower"}`,
  )

  // The two lifeline blocks, read and validated by the one resolver in
  // config.ts. The path is the resolver's, never a literal; the registration
  // options ride along so an override actually takes effect.
  const policy = lifelinePolicy(undefined, ctx.options)
  if (!policy.lifelineEnabled) {
    // The off switch is a policy line, never a file rename: nothing registers,
    // nothing ticks, and no heartbeat is ever published.
    note("DISABLED by policy (lifeline.enabled=false): idle, nothing registered")
    if (globals[CLAIM]) globals[CLAIM].alive = false
    return () => {}
  }
  if (owner) {
    slot.stats.policy = policy.source
    note(`policy source=${policy.source} exempt=${policy.exempt.length} fallbackMs=${policy.fallbackMs}`)
  }

  const ledgerKey = (sessionID: string, partID: string) =>
    `${LEDGER_PREFIX}${Date.now().toString(36)}:${sessionID}:${partID}`

  const assertShape = (messages: any[]) => {
    let sawTool = 0
    let sawStatus = 0
    for (const message of messages) {
      for (const part of (message?.parts ?? message?.content ?? []) as any[]) {
        if (!part || part.type !== "tool") continue
        sawTool += 1
        if (typeof part?.state?.status === "string" && STATUSES.has(part.state.status)) sawStatus += 1
      }
    }
    if (sawTool === 0) return // nothing to assert against; stay "unproven"
    if (sawStatus === 0) {
      if (slot.stats.canary !== "failed") {
        slot.stats.canary = "failed"
        slot.stats.canaryDetail = `${sawTool} tool part(s) read, none carried a known state.status`
        slot.status = "canary failed: refusing to act on this shape"
        note(`CANARY FAILED ${slot.stats.canaryDetail}`)
      }
      return
    }
    slot.stats.canary = "ok"
    slot.stats.canaryDetail = `${sawStatus}/${sawTool} tool parts carried a known state.status`
  }

  // The whole owner body, as a FUNCTION, so a later status read can re-arm a
  // daemon that died between setups. Idempotent: it refuses to arm a slot this
  // instance does not own, a slot that is not alive, or a slot already armed.
  const armOwner = () => {
    if (globals[CLAIM] !== slot || !slot.alive || slot.timer) return
    let blindRecorded = false
    const controller = new AbortController()

    const readContext = async (sessionID: string): Promise<any[]> => {
      try {
        const first: unknown = await ctx.session.context({ sessionID })
        const value: unknown =
          first !== null && typeof first === "object" && "data" in first ? first.data : first
        if (Array.isArray(value)) return value
        if (value !== null && typeof value === "object" && "messages" in value && Array.isArray(value.messages))
          return value.messages
      } catch (error) {
        note(`context read failed for ${sessionID}: ${String(error)}`)
      }
      return []
    }

    const thresholdFor = (tool: string, input: any): number | undefined => {
      if (policy.exempt.includes(tool)) return undefined
      if (tool === "shell" && input && input.timeout === 0) return undefined // background
      // Hard global ceiling: min(the tool's own bound, the configured ceiling).
      return Math.min(policy.toolBoundsMs[tool] ?? policy.fallbackMs, policy.ceilingMs)
    }

    // The ceiling is BINDING only when the tool's own bound sits above it. With
    // the shipped table at the 600s default that is never true; it is recorded
    // honestly anyway so a lowered ceiling reports as a ceiling hit.
    const ceilingBinds = (tool: string): boolean =>
      (policy.toolBoundsMs[tool] ?? policy.fallbackMs) > policy.ceilingMs

    const record = async (entry: Record<string, LedgerValue>) => {
      try {
        await ctx.storage.set(ledgerKey(String(entry.sessionID), String(entry.partID)), entry)
        slot.stats.ledger += 1
      } catch (error) {
        note(`ledger write failed: ${String(error)}`)
      }
    }

    // Drop one dead session from every live set: the sessions map (which
    // drives the displayed count and the sweep) and the pending note sets.
    const dropSession = (sessionID: string, reason: string) => {
      slot.sessions.delete(sessionID)
      slot.pendingContextNotes?.delete?.(sessionID)
      slot.lastContextNoteAt?.delete?.(sessionID)
      slot.stats.sessions = slot.sessions.size
      note(`session pruned (${reason}) -> ${sessionID}`)
    }
    slot.dropSession = dropSession
    // A session-end event prunes immediately when the host exposes one;
    // otherwise the sweep's liveness probe (or the lastSeen age-out when no
    // probe exists) prunes below.
    const isSessionEndEvent = (type: string) =>
      /clos|end|remov|delet|destroy/.test(type) && !type.includes("compact")

    // The note channel's delivery record: every note the silent `context` hook
    // pushes is observed in the ledger, the same way a would-repair is.
    slot.onContextNoteDelivered = async (sessionID: string, pendingNote: PendingContextNote) => {
      const deliveredAt = Date.now()
      await record({
        at: new Date(deliveredAt).toISOString(),
        kind: "context-note",
        sessionID,
        partID: `note:${deliveredAt.toString(36)}`,
        rung: "silent-context",
        repair: "advisory-only",
        text: String(pendingNote.message).slice(0, 320),
      })
      note(`context note delivered -> ${sessionID}`)
    }

    // LIVE WEDGE vs STALE ROW vs UNKNOWN - two factors, and an honest unknown.
    // Factor 1: a session that went idle AFTER the call began is not executing
    // that call - the row is stale. Factor 2: the drain must still be running
    // (`session.wait` resolves when the session goes idle; a stuck drain never
    // lets it resolve). A session that EXISTS and is not idle but has not been
    // touched since the call began is the NORMAL shape of a hung call - the
    // `unknown-stalled` shape, which WEDGES past the bound. Only a probe
    // EXCEPTION is a true unknown: no signal, nothing actioned. The verdict
    // table itself lives in `decideWedge` (exported, headless-tested).
    const liveness = async (
      sessionID: string,
      callStartedAt: number,
    ): Promise<LivenessShape> => {
      try {
        const info = await ctx.session.get({ sessionID })
        const data: any = (info as any)?.data ?? info
        const idleAt = Number(data?.time?.idle ?? 0)
        const updatedAt = Number(data?.time?.updated ?? 0)
        if (idleAt > 0 && idleAt >= callStartedAt) return "stale"
        const wait = ctx.session?.wait?.({ sessionID })
        const idle =
          wait && typeof wait.then === "function"
            ? await Promise.race([
                wait.then(() => true).catch(() => true),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
              ])
            : false
        if (idle) return "stale"
        if (updatedAt > 0 && updatedAt < callStartedAt) return "unknown-stalled"
        return "live"
      } catch {
        return "unknown-probe"
      }
    }

    const sweep = async () => {
      let wedged = 0
      let watch = 0
      let ceilingHits = 0
      const now = Date.now()
      for (const sessionID of [...slot.sessions.keys()]) {
        // PRUNE: a dead session must drop out of the set, or the count only
        // grows and the sweep keeps iterating the dead. Probe
        // liveness first; when the host exposes no probe, age out sessions
        // not observed within the window.
        if (typeof ctx.session?.get === "function") {
          try {
            await ctx.session.get({ sessionID })
          } catch {
            dropSession(sessionID, "session.get failed")
            continue
          }
        } else {
          const seen = (slot.lastSeen as Map<string, number> | undefined)?.get(sessionID) ?? 0
          if (seen > 0 && now - seen > SESSION_TTL_MS) {
            dropSession(sessionID, "aged out")
            continue
          }
        }
        const messages = await readContext(sessionID)
        assertShape(messages)
        if (slot.stats.canary === "failed" && !blindRecorded) {
          // BLIND is not CALM: an empty ledger and a shape-blind detector look
          // identical from outside, and only one of them is good news. Say which.
          blindRecorded = true
          slot.stats.blind = 1
          await record({
            at: new Date().toISOString(),
            kind: "canary-blind",
            sessionID,
            partID: "canary",
            note: slot.stats.canaryDetail,
            rung: "none",
            repair: "n/a",
          })
          note(`CANARY BLIND recorded: ${slot.stats.canaryDetail}`)
        }
        if (slot.stats.canary === "failed") break
        let shape: LivenessShape | undefined
        for (const message of messages) {
          for (const part of (message?.parts ?? message?.content ?? []) as any[]) {
            if (!part || part.type !== "tool") continue
            const status = part?.state?.status
            if (typeof status !== "string" || !UNSETTLED.has(status)) continue
            const tool = String(part.name ?? "unknown")
            const threshold = thresholdFor(tool, part?.state?.input)
            if (threshold === undefined) continue
            const ceilingHit = ceilingBinds(tool)
            const startedAt = Number(part?.time?.ran ?? part?.time?.created ?? 0)
            if (!startedAt) continue
            const age = now - startedAt
            if (age < threshold * 0.7) continue
            const isWedged = age >= threshold
            const partID = String(part.id ?? "unknown")
            const key = `${sessionID}:${partID}`
            if (!isWedged) {
              watch += 1
              continue
            }
            shape = shape ?? (await liveness(sessionID, startedAt))
            const verdict = decideWedge(shape, true)
            if (verdict === "stale-row") {
              if (slot.recorded.get(key) === undefined) {
                slot.recorded.set(key, age)
                slot.stats.stale += 1
                await record({
                  at: new Date().toISOString(),
                  kind: "stale-row",
                  sessionID,
                  partID,
                  tool,
                  ageMs: age,
                  thresholdMs: threshold,
                  rung: "none",
                  repair: "n/a",
                  note: "session idle since the call began: a stale row, not a wedge",
                  canary: slot.stats.canary,
                })
                note(`stale-row ${tool} ${Math.round(age / 1000)}s in ${sessionID} (idle session, no action)`)
              }
              continue
            }
            if (verdict === "unknown-liveness") {
              if (slot.recorded.get(key) === undefined) {
                slot.recorded.set(key, age)
                slot.stats.unknown += 1
                await record({
                  at: new Date().toISOString(),
                  kind: "unknown-liveness",
                  sessionID,
                  partID,
                  tool,
                  ageMs: age,
                  thresholdMs: threshold,
                  rung: "none",
                  repair: "n/a",
                  note: "the liveness probe failed; no signal, acting on nothing",
                  canary: slot.stats.canary,
                })
                note(`unknown liveness ${tool} ${Math.round(age / 1000)}s in ${sessionID} (probe failed, no action)`)
              }
              continue
            }
            wedged += 1
            if (ceilingHit) ceilingHits += 1
            if (slot.recorded.get(key) === undefined) {
              slot.recorded.set(key, age)
              const excess2x = age >= threshold * 2
              await record({
                at: new Date().toISOString(),
                kind: "wedge",
                sessionID,
                partID,
                tool,
                ageMs: age,
                thresholdMs: threshold,
                // The effective (ceiling-capped) bound is thresholdMs; ceilingHit
                // says the ceiling was the binding limit.
                ceilingHit,
                ceilingMs: policy.ceilingMs,
                // ONE rung, TWO gates (not idle + past the effective bound), and
                // the rung is a RETRY not a kill. `liveness` records which shape
                // carried the wedge: a timestamp-stalled session is the normal
                // shape of a hung call, not a stale row. excess2x is recorded for
                // context only: with the ceiling in force repair fires at the bound.
                liveness: shape,
                gates: {
                  liveSession: shape === "live",
                  stalledSinceCall: shape === "unknown-stalled",
                  pastEffectiveBound: true,
                  ceilingHit,
                  excess2x,
                },
                rung: "interrupt-retry",
                repair: policy.repairArmed ? "armed" : "disabled",
                wouldDo:
                  "ctx.session.interrupt({ sessionID, resume: true }) - sheds the stuck branch and the session continues",
                liveDiscriminator:
                  shape === "live"
                    ? "not idle (session.wait did not resolve inside 1500ms) and touched since the call began"
                    : "not idle (session.wait did not resolve inside 1500ms) and not touched since the call began - the normal shape of a hung call",
                declined: "tool.list() executors exist and are deliberately unused",
                canary: slot.stats.canary,
                frozenSignal: "session.active can report a stale liveness reading",
              })
              if (ceilingHit) {
                // Distinct alarm: the global ceiling, not the per-tool bound, is
                // what caught this call.
                note(
                  `CEILING ALARM ${policy.ceilingMs}ms hit: ${tool} ${Math.round(age / 1000)}s in ${sessionID} (effective bound ${Math.round(threshold / 1000)}s)`,
                )
              }
              note(`would-repair ${tool} ${Math.round(age / 1000)}s in ${sessionID} (repair off)`)
              if (policy.repairArmed) {
                try {
                  await ctx.session.interrupt({ sessionID, resume: true })
                  note(`REPAIRED (retry, resume:true) ${tool} ${Math.round(age / 1000)}s in ${sessionID}`)
                } catch (error) {
                  note(`repair failed for ${sessionID}: ${String(error)}`)
                }
              }
            }
          }
        }
      }
      slot.stats.counts = { wedged, watch }
      slot.stats.state = wedged > 0 ? "wedged" : watch > 0 ? "watch" : "idle"
      slot.status =
        wedged > 0
          ? `wedged: ${wedged} call(s) past their bound${ceilingHits > 0 ? ` - ${ceilingHits} at the ${policy.ceilingMs / 1000}s ceiling` : ""}`
          : watch > 0
            ? `watch: ${watch} call(s) approaching their bound`
            : `holding: ${slot.sessions.size} session(s) observed, nothing past its bound`
      slot.stats.sessions = slot.sessions.size
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          slot.stats.heartbeat += 1
          const data: any = (event as any)?.data ?? {}
          const sessionID = String(data.sessionID ?? "")
          if (!sessionID) continue
          const type = String((event as any)?.type ?? "")
          // A session-end event prunes immediately when the host exposes one.
          if (isSessionEndEvent(type)) {
            dropSession(sessionID, `end event ${type || "unknown-type"}`)
            continue
          }
          if (!slot.sessions.has(sessionID) && slot.sessions.size < MAX_SESSIONS) {
            slot.sessions.set(sessionID, String(data.title ?? data.agent ?? ""))
          }
          slot.stats.sessions = slot.sessions.size
          ;(slot.lastSeen ??= new Map()).set(sessionID, Date.now())
        }
      } catch {
        // the subscription ends when aborted
      }
    })()

    let ticks = 0
    // The tick is the daemon's own liveness: it drives the heartbeat readers
    // poll over the snapshot RPC. The sweep is armed only while a session
    // is known.
    slot.timer = setInterval(() => {
      slot.stats.heartbeat += 1
      slot.stats.at = Date.now()
      ticks += 1
      // INVERTED FRESHNESS: the reader's own marker mtime is a dated signal, so
      // a silent reader can never be misread as "fine" - the absence of writes
      // is itself the evidence. Three states: reader live, reader dead, unknown.
      // Measured against the READER's writes only (isReaderFresh), never the
      // daemon's own MARKER.
      const fresh = (() => {
        try {
          const at = statSync(READER_MARKER).mtimeMs
          slot.stats.readerAt = at
          return isReaderFresh(at, Date.now())
        } catch {
          return false
        }
      })()
      const nextReader = fresh ? "live" : "dead"
      if (slot.stats.reader !== nextReader) {
        slot.stats.reader = nextReader
        note(`READER ${fresh ? "LIVE" : `DEAD (no marker write within ${READER_STALE_MS}ms)`}`)
      }
      if (ticks % SWEEP_EVERY_TICKS === 0 && slot.sessions.size > 0) {
        void sweep().catch((error) => note(`sweep failed: ${String(error)}`))
      }
    }, TICK_MS)
    slot.controller = controller
  }
  if (owner) armOwner()

  try {
    const registered = await registerSilentContextHook(
      ctx,
      slot.pendingContextNotes,
      slot.lastContextNoteAt,
      (sessionID, pendingNote) => slot.onContextNoteDelivered?.(sessionID, pendingNote),
    )
    if (!registered) note("silent context hook unavailable on this host")
  } catch (error) {
    note(`silent context hook registration failed: ${String(error)}`)
  }

  // Registered on EVERY instance: the plugin host is a location node, so a
  // registration made in one location is not visible from another. Every
  // handler reads the single shared slot, so any caller sees the same daemon.
  // The snapshot carries the LIVE pct so readers can report it. A status READ
  // is the natural re-arm hook: any reader polling this RPC reaches the
  // handler, which is registered on EVERY instance, so a daemon that
  // died between setups is noticed and re-claimed quickly - with no
  // fresh setup, no config touch and no restart. The handler runs in a LIVE
  // location, so its `ctx` is viable (unlike a follower's stale setup closure).
  // It never throws and never latches: a failure is noted and the snapshot still
  // returns, so a read can never become a stop condition.
  const rearm = () => {
    try {
      if (!claimSlot()) return
      armOwner()
      note(`re-armed from a status read: generation=${generation}`)
    } catch (error) {
      note(`re-arm from a status read failed: ${String(error)}`)
    }
  }

  const snapshot = () => {
    rearm()
    return buildSnapshot({ ...slot.stats, sessions: slot.sessions.size })
  }

  try {
    await ctx.rpc.register(lifelineRpcDefinition, { snapshot: async () => snapshot() })
  } catch (error) {
    note(`rpc register failed: ${String(error)}`)
  }

  try {
    await ctx.tool.transform((tools: any) => {
      tools.add({
        name: "lifeline",
        description:
          "lifeline status: fleet liveness (idle/watch/wedged) plus the observation ledger. Repair is disabled in this build.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["status", "repair"] },
            sessionID: { type: "string" },
          },
        },
        execute: async (args: any) => {
          const action = args?.action ?? "status"
          if (slot.stats.canary === "failed") {
            return {
              content: `lifeline CANARY FAILED - ${slot.stats.canaryDetail}; refusing to act. Sessions observed: ${slot.stats.sessions}.`,
            }
          }
          if (action === "repair") {
            return {
              content: `lifeline repair is DISABLED (observation only). Would interrupt ${args?.sessionID ?? "the wedged session"} with resume:true. Ledger holds ${slot.stats.ledger} would-repair event(s).`,
            }
          }
          // Any status read re-arms: the same hook the reader's RPC poll uses.
          rearm()
          let recent = ""
          try {
            const scanned = await ctx.storage.scan({ prefix: LEDGER_PREFIX, limit: 20 })
            const entries = (scanned?.entries ?? [])
              .map((entry: any) => entry?.value)
              .filter(Boolean)
              .slice(-5)
            recent = entries
              .map((entry: any) => {
                if (entry.kind === "context-note") {
                  return `note (${entry.sessionID})`
                }
                if (entry.kind === "canary-blind") return `canary BLIND (${entry.sessionID})`
                if (typeof entry.ageMs === "number")
                  return `${entry.kind ?? "call"} ${entry.tool ?? "?"} ${Math.round(entry.ageMs / 1000)}s (${entry.sessionID})`
                return `${entry.kind ?? "entry"} (${entry.sessionID})`
              })
              .join("; ")
          } catch (error) {
            note(`ledger scan failed: ${String(error)}`)
          }
          return {
            content: [
              `claimed: daemon ${slot.alive ? "up" : "stale"}, generation ${slot.generation}, policy ${slot.stats.policy}, canary ${slot.stats.canary}`,
              `heartbeat age: ${slot.stats.at ? Math.round((Date.now() - slot.stats.at) / 1000) : "never"}s (a stale generation cannot pretend to be fresh)`,
              `proven: ${slot.stats.canaryDetail}`,
              slot.status,
              `stale rows: ${slot.stats.stale} (running row, idle session - observed, never actioned)`,
              `unknown liveness: ${slot.stats.unknown} (probe FAILURES only - a hung call is a wedge, never an unknown); canary blind: ${slot.stats.blind === 1 ? "YES" : "no"}`,
              `reader: ${slot.stats.reader} (marker mtime ${slot.stats.readerAt || "none"})`,
              `pulse: ${policy.pulseEnabled ? "on" : "OFF by policy"} (accepted, no display: this plugin renders nothing)`,
              `cadence: sweeps are owned by THIS server process`,
              recent ? `ledger: ${recent}` : "ledger: empty (no would-repair events yet)",
            ].join("\n"),
          }
        },
      })
    })
  } catch (error) {
    note(`tool register failed: ${String(error)}`)
  }

  return () => {
    // A newer generation owns the daemon: its timer is not ours to clear, and
    // clearing it from here is exactly how the tree ended up with no live owner.
    if (globals[CLAIM] !== slot) return
    // This instance is STILL the claim holder, so it is the last live owner and
    // the interval below is the only sweep driver left. The slot is deliberately
    // left READABLE and ADOPTABLE - `alive: false` with `stats.at` frozen - so the
    // next setup, or the next status read, re-arms instead of leaving a silent
    // tree. Ownership is claimed synchronously in setup, before any await, so a
    // successor can never be mid-flight while this runs.
    slot.alive = false
    if (slot.timer) clearInterval(slot.timer)
    slot.timer = undefined
    if (slot.controller) slot.controller.abort()
    note(`cleanup generation=${generation}`)
  }
}
