import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { configPath, configSource, fleetBlock } from "./config.ts"

// ═══════════════════════════════════════════════════════════════════════════
//  oc-unified - the fleet watcher feature.
//  (moved from plugins/oc-fleet/index.ts)
//
//  The watcher subscribes to the event stream (the host exposes no session
//  enumeration) and writes the status file other tools read. Only escalation
//  classes queue a compact note for the recipient's next user turn:
//      error / stalled / wedged / terminal-all.
//  A note is never queued for a recipient that is finished (`done`) or no
//  longer resolvable: that destination is counted as suppressed, never written
//  to the history and never delivered.
//  Notes are added to outgoing model context; they never create chat messages.
//
//  Detection lives here (server side). The status file this module writes is
//  the boundary other tools read, so either side can restart without losing
//  the other.
//
//  Shape: an exported async `setupFleet(ctx)` that returns a disposer, wired by
//  index.ts into the single oc-unified plugin; a shared generation-guarded slot
//  on globalThis (setup runs once per location); and a pure decision core a
//  headless harness can import without running setup.
//
//  WATCH SET. The plugin host exposes no session enumeration, so the set is
//  built from the event stream: every session observed WITH a parentID (a
//  worker/child) is auto-watched when `autoWatchChildren` holds (the default),
//  plus any ids the owner lists in `watch` or in the registration options. A
//  member that stops resolving is dropped as a per-sweep transient: a close
//  that deletes its own sessions is by-design operation, never an escalation
//  and never a history line.
//
//  ESCALATION RECIPIENT. One strategy, configured by `recipient` / `target`:
//      "nearest-ancestor" (the default): the escalated session's nearest
//          ancestor (its spawner), which owns the work. A root session has no
//          ancestor, so its escalations are recorded out-of-band with no note.
//      a fixed session id in `target`: every escalation goes there.
//      "off" (`recipient: "off"`, or `target: "off"`): no note is ever queued;
//          escalations are recorded out-of-band only.
//  A `target` id wins over the strategy when both are set.
//
//  TERMINALITY. A session is terminal when the host says so first
//  (`data.status` / `data.state` matching `terminalTokens`), else when its
//  title's first token matches. `terminalTokens` is empty (nothing terminal)
//  until configured; a tree that closes sessions with a `done` title sets
//  `terminalTokens: ["done"]`.
//
//  REVERSIBILITY. policy `enabled:false` stops all detection; policy
//  `push:true` queues notes for ordinary transitions too.
//  Both are plain lines in the `fleet` block of the shared config file
//  (resolved by config.ts) - no code change, no file rename.
// ═══════════════════════════════════════════════════════════════════════════

// The runtime lane is derived from the ENVIRONMENT (LOCALAPPDATA, else the home
// root), never a literal user path.
const RUNTIME_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Temp", "opencode", "oc-fleet")
const STATUS_PATH = process.env.OC_FLEET_STATUS ?? join(RUNTIME_DIR, "status.json")
const ESCALATIONS_PATH = process.env.OC_FLEET_ESCALATIONS ?? join(RUNTIME_DIR, "escalations.jsonl")
// The diagnostic-lane default, from the same env-derived temp root.
export function defaultMarker(env: Record<string, string | undefined>): string {
  return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Temp", "opencode", "oc-fleet.log")
}
export function resolveMarker(env: Record<string, string | undefined>): string {
  return env.OC_FLEET_MARKER ?? defaultMarker(env)
}
const MARKER_PATH = resolveMarker(process.env)
const TICK_MS = 1000

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
    // diagnostics must never take the watcher down
  }
}

const CLAIM = Symbol.for("oc-fleet.v1")
const MAX_SESSIONS = 128
const ESCALATION_TTL_MS = 5 * 60_000

// Lifecycle tokens that mean "this session is finished", from the `fleet`
// block's `terminalTokens` (empty until configured - nothing is terminal for a
// stranger). The host's own status signal is preferred over title matching:
// `isTerminalSession` checks it first, and the title's first token is the
// documented fallback.
export type DeckClass = "ordinary" | "error" | "stalled" | "wedged" | "terminal-all"

export type RecipientStrategy = "nearest-ancestor" | "off"

export type Policy = {
  enabled: boolean
  report: boolean
  push: boolean
  target: string | null
  recipient: RecipientStrategy
  terminalTokens: string[]
  autoWatchChildren: boolean
  watch: string[]
  sweepSeconds: number
  stallSeconds: number
  doneTtlSeconds: number
  minNoteSeconds: number
  noteTtlSeconds: number
  writeMinMs: number
  everyTerminal: boolean
  source: string
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
function note(tag: string) {
  try {
    trimLogFile(MARKER_PATH)
    appendFileSync(MARKER_PATH, `${tag} ${new Date().toISOString()}\n`)
  } catch {
    // diagnostics must never take the watcher down
  }
}

// JSONC reading now lives in config.ts (one resolver for the whole unit); the
// `fleet` block arrives already parsed, so this file keeps no file-reading pass.
function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function asPositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
}

function asRecipient(value: unknown): RecipientStrategy {
  return value === "off" ? "off" : "nearest-ancestor"
}

export function readPolicy(ctx: { options?: unknown }): Policy {
  const policy: Policy = {
    enabled: true,
    report: true,
    push: false,
    target: null,
    recipient: "nearest-ancestor",
    terminalTokens: [],
    autoWatchChildren: true,
    watch: [],
    sweepSeconds: 5,
    stallSeconds: 600,
    doneTtlSeconds: 60,
    minNoteSeconds: 300,
    noteTtlSeconds: 900,
    writeMinMs: 100,
    everyTerminal: true,
    source: "defaults",
  }

  // 1. the shared config `fleet` block (optional; absent = neutral defaults).
  // The path resolves through the one precedence (options > env > default), so
  // both plugin spec forms (a bare string, or {package, options}) land here.
  const block = fleetBlock(undefined, ctx?.options)
  if (block) {
    policy.enabled = asBool(block.enabled, policy.enabled)
    policy.report = asBool(block.report, policy.report)
    policy.push = asBool(block.push, policy.push)
    policy.target = typeof block.target === "string" && block.target.trim() ? block.target.trim() : policy.target
    policy.recipient = asRecipient(block.recipient)
    policy.terminalTokens = asStringArray(block.terminalTokens).map((token) => token.toLowerCase())
    policy.autoWatchChildren = asBool(block.autoWatchChildren, policy.autoWatchChildren)
    policy.watch = asStringArray(block.watch)
    policy.sweepSeconds = asPositive(block.sweepSeconds, policy.sweepSeconds)
    policy.stallSeconds = asPositive(block.stallSeconds, policy.stallSeconds)
    policy.doneTtlSeconds = asPositive(block.doneTtlSeconds, policy.doneTtlSeconds)
    policy.minNoteSeconds = asPositive(block.minNoteSeconds, policy.minNoteSeconds)
    policy.noteTtlSeconds = asPositive(block.noteTtlSeconds, policy.noteTtlSeconds)
    policy.writeMinMs = asPositive(block.writeMinMs, policy.writeMinMs)
    policy.everyTerminal = asBool(block.everyTerminal, policy.everyTerminal)
    policy.source = configSource(configPath(process.env, ctx?.options))
  }

  // 2. registration options win over the file (host forwards them). A
  // bare-string options form names the FILE (resolved above), never a block.
  const opts: any =
    ctx?.options === undefined || typeof ctx?.options === "string" ? {} : (ctx.options as Record<string, unknown>)
  const deck = opts["oc-fleet"] ?? opts
  if (deck && typeof deck === "object") {
    if (typeof deck.enabled === "boolean") policy.enabled = deck.enabled
    if (typeof deck.report === "boolean") policy.report = deck.report
    if (typeof deck.push === "boolean") policy.push = deck.push
    if (typeof deck.target === "string" && deck.target.trim()) policy.target = deck.target.trim()
    if (typeof deck.recipient === "string") policy.recipient = asRecipient(deck.recipient)
    const terminalTokens = asStringArray(deck.terminalTokens).map((token) => token.toLowerCase())
    if (terminalTokens.length) policy.terminalTokens = terminalTokens
    if (typeof deck.autoWatchChildren === "boolean") policy.autoWatchChildren = deck.autoWatchChildren
    const watch = asStringArray(deck.watch)
    if (watch.length) policy.watch = watch
    policy.sweepSeconds = asPositive(deck.sweepSeconds, policy.sweepSeconds)
    policy.stallSeconds = asPositive(deck.stallSeconds, policy.stallSeconds)
    policy.doneTtlSeconds = asPositive(deck.doneTtlSeconds, policy.doneTtlSeconds)
    policy.minNoteSeconds = asPositive(deck.minNoteSeconds, policy.minNoteSeconds)
    policy.noteTtlSeconds = asPositive(deck.noteTtlSeconds, policy.noteTtlSeconds)
    policy.writeMinMs = asPositive(deck.writeMinMs, policy.writeMinMs)
    if (typeof deck.everyTerminal === "boolean") policy.everyTerminal = deck.everyTerminal
    if (policy.source === "defaults") policy.source = "options"
  }

  // `target: "off"` is the spelled-out off switch: no fixed recipient, and the
  // strategy reads off, so no note is ever queued.
  if (typeof policy.target === "string" && policy.target.toLowerCase() === "off") {
    policy.target = null
    policy.recipient = "off"
  }

  return policy
}

// ---------------------------------------------------------------------------
// Pure decision core (no host, no I/O) - exported for the headless harness
// ---------------------------------------------------------------------------

export function isTerminalTitle(title: string | undefined, tokens: readonly string[] = []): boolean {
  if (!title || tokens.length === 0) return false
  const token = title.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  return tokens.some((candidate) => candidate.toLowerCase() === token)
}

// Terminality with the host signal preferred: a live `status` (or `state`)
// matching the tokens wins first, and the title's first token is the
// documented fallback. Empty tokens mean nothing is terminal (observe-only).
export function isTerminalSession(
  input: { title?: string | undefined; status?: unknown },
  tokens: readonly string[] = [],
): boolean {
  if (tokens.length === 0) return false
  const lowered = tokens.map((token) => token.toLowerCase())
  if (typeof input.status === "string" && input.status.trim()) {
    if (lowered.includes(input.status.trim().toLowerCase())) return true
  }
  return isTerminalTitle(input.title, lowered)
}

// Coerce whatever an error field carries into one flat line. The host sends an
// OBJECT (SessionError.Error, schema/session-error.ts), sometimes a string, and
// sometimes nothing - and a non-string reaching `.replace` is a dropped
// escalation, so this never throws and never assumes a shape.
function asText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.message === "string") return record.message
    if (typeof record.type === "string") return record.type
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export function firstLine(text: unknown, max = 160): string {
  const flat = asText(text).replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat
}

export function classifyExecution(
  type: string,
  data: any,
): { class: DeckClass; detail: string } | undefined {
  if (type === "session.execution.failed") {
    return { class: "error", detail: firstLine(data?.error?.message ?? data?.error?.type ?? "execution failed") }
  }
  if (type === "session.execution.interrupted") {
    // A user cancel is intentional; only an INACTIVITY cut is a stall.
    if (String(data?.reason ?? "") === "inactivity") return { class: "stalled", detail: "execution interrupted (inactivity)" }
    return undefined
  }
  if (type === "session.step.failed") {
    return { class: "error", detail: firstLine(data?.error ?? "step failed") }
  }
  if (type === "session.status" && String(data?.status?.type ?? "") === "retry") {
    const attempt = Number(data?.status?.attempt ?? 0)
    const message = firstLine(data?.status?.message ?? data?.status?.action?.title ?? "provider retry")
    return { class: "stalled", detail: `provider retry attempt=${attempt} ${message}` }
  }
  return undefined
}

export type StatCounts = { total: number; watch: number; executing: number; blocked: number; errors: number; done: number }

export function countSessions(
  records: Iterable<{ terminal: boolean; gone: boolean; executing: boolean; blocked: boolean; error?: boolean }>,
): StatCounts {
  let total = 0
  let watch = 0
  let executing = 0
  let blocked = 0
  let errors = 0
  let done = 0
  for (const rec of records) {
    if (rec.gone) continue
    total += 1
    if (rec.terminal) {
      done += 1
      continue
    }
    watch += 1
    if (rec.executing) executing += 1
    if (rec.blocked) blocked += 1
    if (rec.error) errors += 1
  }
  return { total, watch, executing, blocked, errors, done }
}

// Status-file text builder: one writer, one shape.
// LIVE values only, no history: sticky latches (event/injected/targetGone)
// and the never-read `executing` count are not persisted, so a past
// escalation can never tint a later read after the sweep ends.
export function statusDocument(input: {
  stats: { at: number; sweptAt: number }
  counts: StatCounts
  enabled: boolean
}): string {
  return JSON.stringify({
    version: 1,
    enabled: input.enabled,
    at: input.stats.at,
    sweptAt: input.stats.sweptAt,
    total: input.counts.total,
    watch: input.counts.watch,
    blocked: input.counts.blocked,
    errors: input.counts.errors,
    done: input.counts.done,
    by: "oc-fleet",
  })
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
type SessionRec = {
  sid: string
  parentID?: string
  title: string
  status?: string
  agent?: string
  executing: boolean
  outcome: string
  blocked: boolean
  error: boolean
  terminal: boolean
  terminalAt?: number
  lastActivityAt: number
  lastSeenAt?: number
  gone: boolean
  stalledNotified: boolean
}

type Stats = {
  at: number
  sweptAt: number
}

export function createDeck(ctx: Plugin.Context, policy: Policy) {
  const pendingNotes = new Map<string, { text: string; queuedAt: number }>()
  const promptedAt = new Map<string, number>()
  const lastNoteAt = new Map<string, number>()
  const state = {
    generation: Math.random().toString(36).slice(2),
    alive: true,
    sessions: new Map<string, SessionRec>(),
    watch: new Set<string>(),
    stats: {
      at: Date.now(),
      sweptAt: Date.now(),
    } as Stats,
    escalated: new Map<string, number>(),
    suppressed: 0,
    terminalNotified: false,
    lastWriteAt: 0,
  }

  const watchIds = policy.watch
  for (const sid of watchIds) if (state.watch.size < MAX_SESSIONS) state.watch.add(sid)

  const record = (sid: string): SessionRec => {
    let rec = state.sessions.get(sid)
    if (!rec) {
      rec = {
        sid,
        title: "",
        executing: false,
        outcome: "",
        blocked: false,
        error: false,
        terminal: false,
        lastActivityAt: Date.now(),
        gone: false,
        stalledNotified: false,
      }
      state.sessions.set(sid, rec)
    }
    return rec
  }

  const setTerminal = (rec: SessionRec, terminal: boolean) => {
    rec.terminal = terminal
    if (terminal) {
      if (!rec.terminalAt) rec.terminalAt = Date.now()
    } else {
      rec.terminalAt = undefined
    }
  }

  // Renewed activity while still executing ends a stall: the sweep sets
  // blocked on silence, so activity must clear it (error latches stay until
  // idle/restart/rename).
  const clearStall = (rec: SessionRec) => {
    if (!rec.executing) return
    rec.stalledNotified = false
    if (!rec.error) rec.blocked = false
  }

  // LIVE view only: gone records are purged, and records terminal for longer
  // than doneTtlSeconds age out, so an empty fleet reads empty (idle).
  const counts = () => {
    const now = Date.now()
    const ttlMs = policy.doneTtlSeconds * 1000
    const live: SessionRec[] = []
    for (const [sid, rec] of state.sessions) {
      if (rec.gone) {
        state.sessions.delete(sid)
        continue
      }
      if (rec.terminal && rec.terminalAt !== undefined && now - rec.terminalAt > ttlMs) {
        state.sessions.delete(sid)
        continue
      }
      live.push(rec)
    }
    return countSessions(live)
  }

  const writeStatus = (force = false) => {
    if (!policy.enabled) return
    const now = Date.now()
    if (!force && now - state.lastWriteAt < policy.writeMinMs) return
    state.lastWriteAt = now
    state.stats.sweptAt = now
    const doc = statusDocument({ stats: state.stats, counts: counts(), enabled: policy.enabled })
    try {
      mkdirSync(dirname(STATUS_PATH), { recursive: true })
      writeFileSync(STATUS_PATH, doc)
    } catch (error) {
      note(`STATUS-WRITE-FAIL ${String(error)}`)
    }
  }

  const touch = () => {
    state.stats.at = Date.now()
  }

  const resolveRecipient = (sid: string): string | undefined => {
    if (policy.target) return policy.target
    if (policy.recipient === "off") return undefined
    const parent = state.sessions.get(sid)?.parentID
    if (!parent || parent === sid) return undefined
    return parent
  }

  const context = (event: any) => {
    if (!policy.enabled || !policy.report) return
    const recipient = typeof event?.sessionID === "string" ? event.sessionID : ""
    if (!recipient) return
    const promptAt = promptedAt.get(recipient)
    if (promptAt === undefined) return
    promptedAt.delete(recipient)
    const pending = pendingNotes.get(recipient)
    if (!pending) return
    const now = Date.now()
    if (now - pending.queuedAt > policy.noteTtlSeconds * 1000) {
      pendingNotes.delete(recipient)
      note(`ESCALATION-DROPPED recipient=${recipient} reason=ttl`)
      return
    }
    if (promptAt < pending.queuedAt) return
    if (now - (lastNoteAt.get(recipient) ?? 0) < policy.minNoteSeconds * 1000) return
    if (!Array.isArray(event?.system)) return
    event.system.push({ type: "text", text: firstLine(pending.text, 320) })
    pendingNotes.delete(recipient)
    lastNoteAt.set(recipient, now)
    note(`ESCALATION-NOTED recipient=${recipient}`)
  }

  // RECIPIENT LIVENESS GATE. A note is queued for a live turn-taker only. A
  // recipient the host reports as terminal, or whose title carries a terminal
  // token, is finished working: the note would be waited for by nobody, and
  // the destination is noise, not an incident. The host status is read first;
  // the title token is the fallback. Returns "" for a live recipient, else
  // the suppression reason.
  const deadRecipient = async (recipient: string): Promise<string> => {
    const known = state.sessions.get(recipient)
    if (isTerminalSession({ title: known?.title, status: known?.status }, policy.terminalTokens)) return "terminal"
    if (typeof ctx?.session?.get !== "function") return ""
    try {
      const info: any = await ctx.session.get({ sessionID: recipient })
      const data: any = info?.data ?? info
      const title = typeof data?.title === "string" && data.title ? data.title : known?.title
      const status =
        typeof data?.status === "string" && data.status
          ? data.status
          : typeof data?.state === "string" && data.state
            ? data.state
            : known?.status
      if (typeof title === "string") {
        const rec = state.sessions.get(recipient)
        if (rec) rec.title = title
      }
      if (typeof status === "string") {
        const rec = state.sessions.get(recipient)
        if (rec) rec.status = status
      }
      return isTerminalSession({ title, status }, policy.terminalTokens) ? "terminal" : ""
    } catch {
      return "absent"
    }
  }

  // Suppression is a counter and a diagnostic line, never a history record.
  const suppress = (recipient: string, reason: string, tag: string) => {
    state.suppressed += 1
    note(`ESCALATION-SUPPRESSED recipient=${recipient} reason=${reason} ${tag}`)
  }

  // Escalations are held for the recipient's next user-triggered model context.
  // `verified` means the caller already ran the liveness gate this turn.
  const inject = async (recipient: string | undefined, text: string, tag: string, verified = false): Promise<boolean> => {
    if (!policy.report) return false
    if (!recipient) {
      note(`ESCALATION-NO-RECIPIENT ${tag} (recorded out-of-band only)`)
      return false
    }
    if (!verified) {
      const reason = await deadRecipient(recipient)
      if (reason) {
        suppress(recipient, reason, tag)
        return false
      }
    }
    pendingNotes.set(recipient, { text: firstLine(text, 320), queuedAt: Date.now() })
    note(`ESCALATION-QUEUED recipient=${recipient} ${tag}`)
    return true
  }

  const escalationText = (kind: DeckClass, sid: string, detail: string, extra = ""): string => {
    const iso = new Date().toISOString()
    const parts = [
      "FLEET-ESCALATION",
      `target=${policy.target ?? "auto"}`,
      sid ? `session=${sid}` : "session=fleet",
      `class=${kind}`,
    ]
    if (detail) parts.push(`detail=${detail}`)
    if (extra) parts.push(extra)
    parts.push(`at=${iso}`)
    return parts.join(" | ")
  }

  const escalate = async (kind: DeckClass, sid: string, detail: string, extra = "") => {
    const key = `${kind}:${sid || "fleet"}`
    const now = Date.now()
    const last = state.escalated.get(key)
    if (last && now - last < ESCALATION_TTL_MS) return
    for (const [seen, at] of state.escalated) {
      if (now - at >= ESCALATION_TTL_MS) state.escalated.delete(seen)
    }
    state.escalated.set(key, now)
    touch()
    const recipient = sid ? resolveRecipient(sid) : policy.target ?? undefined
    const text = escalationText(kind, sid, detail, extra)
    // The status write lands before ANY recipient probe, so the status file
    // is current while the probe is still in flight.
    writeStatus(true)
    // Gate BEFORE the history line: a suppressed escalation is counted, never
    // recorded and never queued.
    if (recipient) {
      const reason = await deadRecipient(recipient)
      if (reason) {
        suppress(recipient, reason, `class=${kind} session=${sid || "fleet"}`)
        return
      }
    }
    try {
      mkdirSync(dirname(ESCALATIONS_PATH), { recursive: true })
      appendFileSync(ESCALATIONS_PATH, `${JSON.stringify({ at: new Date().toISOString(), kind, sid: sid ?? null, recipient: recipient ?? null, detail, text })}\n`)
    } catch {
      // escalation history must never take the watcher down
    }
    await inject(recipient, text, `class=${kind} session=${sid || "fleet"}`, Boolean(recipient))
  }

  // ---- event handling ----
  const silentTouch = new Set([
    "session.step.streamed",
    "session.message.content.updated",
    "session.viewed",
    "session.metadata.updated",
    "session.permissions",
  ])

  const handleEvent = async (event: any) => {
    if (!policy.enabled) return
    const type = String(event?.type ?? "")
    const data: any = event?.data ?? {}
    const sid = typeof data?.sessionID === "string" ? data.sessionID : ""
    if (silentTouch.has(type)) {
      if (sid) {
        const touched = record(sid)
        touched.lastActivityAt = Date.now()
        clearStall(touched)
      }
      return
    }

    if (type === "session.created") {
      if (!sid) return
      const rec = record(sid)
      const parentID = typeof data.parentID === "string" && data.parentID ? data.parentID : undefined
      if (parentID) rec.parentID = parentID
      if (typeof data.title === "string") rec.title = data.title
      if (typeof data.agent === "string") rec.agent = data.agent
      if (typeof data.status === "string") rec.status = data.status
      else if (typeof data.state === "string") rec.status = data.state
      rec.lastActivityAt = Date.now()
      // Auto-watch a worker (a session with a spawner) when the policy keeps
      // the default. Root sessions are watched only when listed in
      // policy/config: watching every root would count the
      // owner's own session as fleet activity.
      if (policy.autoWatchChildren && parentID && state.watch.size < MAX_SESSIONS) state.watch.add(sid)
      touch()
      writeStatus()
      return
    }

    if (!sid) return
    const rec = record(sid)

    switch (type) {
      case "session.renamed": {
        if (typeof data.title === "string") rec.title = data.title
        setTerminal(rec, isTerminalSession(rec, policy.terminalTokens))
        // A rename to a non-terminal title ends the activity: clear the flags.
        if (!rec.terminal) {
          rec.blocked = false
          rec.error = false
        }
        if (state.watch.has(sid)) {
          touch()
          writeStatus()
          if (policy.report && policy.push) await inject(resolveRecipient(sid), escalationText("ordinary", sid, `renamed ${firstLine(rec.title, 40)}`), "push")
        }
        return
      }
      case "session.execution.started":
      case "session.step.started": {
        rec.executing = true
        // New activity ends the old one: clear the flags.
        rec.blocked = false
        rec.error = false
        rec.lastActivityAt = Date.now()
        if (state.watch.has(sid)) {
          touch()
          writeStatus()
        }
        return
      }
      case "session.execution.succeeded": {
        rec.executing = false
        rec.stalledNotified = false
        rec.outcome = "succeeded"
        rec.blocked = false
        rec.error = false
        rec.lastActivityAt = Date.now()
        if (state.watch.has(sid)) {
          touch()
          writeStatus()
          if (policy.report && policy.push) await inject(resolveRecipient(sid), escalationText("ordinary", sid, "execution succeeded"), "push")
        }
        return
      }
      case "session.idle": {
        rec.executing = false
        rec.stalledNotified = false
        // Idle ends the activity: a resolved error/block must clear.
        rec.blocked = false
        rec.error = false
        rec.lastActivityAt = Date.now()
        if (state.watch.has(sid)) {
          touch()
          writeStatus()
          if (policy.report && policy.push) await inject(resolveRecipient(sid), escalationText("ordinary", sid, "turn ended (idle)"), "push")
        }
        return
      }
      case "session.status": {
        const statusType = String(data?.status?.type ?? "")
        if (statusType) rec.status = statusType
        if (statusType === "busy") {
          rec.executing = true
          rec.lastActivityAt = Date.now()
          clearStall(rec)
          return
        }
        if (statusType === "idle") {
          rec.executing = false
          rec.stalledNotified = false
          // Idle ends the activity: a resolved error/block must clear.
          rec.blocked = false
          rec.error = false
          rec.lastActivityAt = Date.now()
          if (state.watch.has(sid)) {
            touch()
            writeStatus()
          }
          return
        }
        break // retry falls through to the escalation classifier below
      }
      case "session.shell.started":
      case "session.shell.ended":
      case "session.inbox.enqueued":
      case "session.inbox.delivered":
      case "session.skill.activated": {
        if (type === "session.inbox.enqueued" && policy.report && data?.item?.type === "user" && pendingNotes.has(sid)) {
          promptedAt.set(sid, Date.now())
        }
        rec.lastActivityAt = Date.now()
        clearStall(rec)
        if (state.watch.has(sid)) {
          touch()
          writeStatus()
        }
        return
      }
    }

    // Any remaining type may carry an escalation signal.
    const classified = classifyExecution(type, data)
    if (classified && state.watch.has(sid)) {
      if (classified.class === "error") {
        rec.blocked = true
        rec.error = true
      }
      if (classified.class === "stalled") {
        rec.blocked = true
        rec.error = false
      }
      rec.lastActivityAt = Date.now()
      if (type === "session.execution.failed" || type === "session.execution.interrupted") rec.executing = false
      if (policy.report) await escalate(classified.class, sid, classified.detail)
      else {
        touch()
        writeStatus()
      }
    }
  }

  // ---- periodic sweep: liveness, terminality, stalls ----
  const sweep = async () => {
    if (!policy.enabled) return
    if (!policy.report) {
      writeStatus(true)
      return
    }
    const now = Date.now()
    const stallMs = policy.stallSeconds * 1000

    for (const sid of [...state.watch]) {
      const rec = record(sid)
      // -watch may name a session the plugin never saw born.
      if (typeof ctx?.session?.get === "function") {
        try {
          const info: any = await ctx.session.get({ sessionID: sid })
          const data: any = info?.data ?? info
          if (typeof data?.title === "string" && data.title) rec.title = data.title
          if (typeof data?.status === "string" && data.status) rec.status = data.status
          else if (typeof data?.state === "string" && data.state) rec.status = data.state
          if (typeof data?.parentID === "string" && data.parentID) rec.parentID = data.parentID
          if (data?.time?.updated) rec.lastSeenAt = Number(data.time.updated)
          const outcome = String(data?.outcome ?? "")
          if (outcome) {
            rec.outcome = outcome
            rec.blocked = outcome === "failed"
            rec.error = outcome === "failed"
          }
        } catch {
          // Unresolvable member: dropped as a per-sweep transient. A session's
          // own close deletes it, so a vanished watch member is BY-DESIGN
          // operation, not an incident: it is purged from the live view by
          // counts() and logged out-of-band, and it never reaches the
          // escalation history nor a recipient note.
          if (!rec.gone) {
            rec.gone = true
            state.watch.delete(sid)
            touch()
            note(`WATCH-GONE session=${sid} (no longer resolvable)`)
          }
          continue
        }
      }

      setTerminal(rec, isTerminalSession(rec, policy.terminalTokens))

      if (!rec.terminal && rec.executing && now - rec.lastActivityAt > stallMs && !rec.stalledNotified) {
        rec.stalledNotified = true
        rec.blocked = true
        await escalate("stalled", sid, `no activity for ${Math.round((now - rec.lastActivityAt) / 1000)}s while executing`)
      }
      if (!rec.executing) rec.stalledNotified = false
    }

    const c = counts()
    if (policy.everyTerminal && c.total > 0 && c.done === c.total) {
      if (!state.terminalNotified) {
        state.terminalNotified = true
        await escalate("terminal-all", "", `${c.total} watched session(s) terminal`)
      }
    } else {
      state.terminalNotified = false
    }

    writeStatus(true)
  }

  let ticks = 0
  let sweepBusy = false
  const tick = () => {
    state.stats.sweptAt = Date.now() // liveness even when nothing changed
    ticks += 1
    const sweepEvery = Math.max(1, Math.round(policy.sweepSeconds))
    if (ticks % sweepEvery === 0 && !sweepBusy) {
      sweepBusy = true
      void sweep()
        .catch((error) => note(`sweep failed: ${String(error)}`))
        .finally(() => {
          sweepBusy = false
        })
    } else {
      writeStatus()
    }
  }

  // A serialized queue preserves event ordering while each arrival drains now.
  const queue: any[] = []
  let drainBusy = false
  const enqueue = (event: any) => {
    if (queue.length < 1024) {
      queue.push(event)
      void handleDirty()
    }
  }
  const handleDirty = async () => {
    if (drainBusy) return
    drainBusy = true
    try {
      while (queue.length) {
        const event = queue.shift()
        try {
          await handleEvent(event)
        } catch (error) {
          note(`event failed type=${String(event?.type)} err=${String(error)}`)
        }
      }
    } finally {
      drainBusy = false
    }
  }

  const stop = () => {
    state.alive = false
    pendingNotes.clear()
    promptedAt.clear()
  }

  return {
    state,
    enqueue,
    handleEvent,
    handleDirty,
    context,
    sweep,
    tick,
    stop,
    resolveRecipient,
    writeStatus,
  }
}

// ---------------------------------------------------------------------------
// Feature entry - wired by index.ts into the single oc-unified plugin.
// ---------------------------------------------------------------------------
export async function setupFleet(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const globals = globalThis as Record<PropertyKey, any>
  const previous = globals[CLAIM]
  const generation = Math.random().toString(36).slice(2)

  const policy = readPolicy(ctx)
  note(`setup generation=${generation} enabled=${policy.enabled} push=${policy.push} target=${policy.target ?? "auto"} watch=${policy.watch.length} source=${policy.source}`)

  if (!policy.enabled) {
    // The off switch is a policy line, never a file rename: nothing ticks and
    // nothing is written.
    note("DISABLED by policy (oc-fleet.enabled=false): idle, nothing registered")
    if (globals[CLAIM]) globals[CLAIM].alive = false
    return async () => {}
  }

  // Ownership is process-wide: setup runs once per location, so a module-level
  // guard is not enough. The generation lets a torn-down owner stop cleanly.
  const owner = !(previous && previous.alive)
  const deck = owner ? createDeck(ctx, policy) : previous.deck
  if (owner) {
    globals[CLAIM] = { generation, alive: true, deck }
  } else {
    note(`follower generation=${generation} (owner ${previous.generation}) - reusing the live deck`)
  }

  if (!owner) {
    // Followers still feed the same deck nothing new; they must not double-subscribe.
    return async () => {}
  }

  const contextHook = await ctx.session.hook("context", (event: any) => deck.context(event))

  const controller = new AbortController()
  try {
    if (ctx?.event?.subscribe) {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            deck.enqueue(event)
          }
        } catch {
          // the subscription ends when aborted
        }
      })()
    } else {
      note("no ctx.event.subscribe on this host: detection is sweep-only")
    }
  } catch (error) {
    note(`subscribe failed: ${String(error)}`)
  }

  const timer = setInterval(() => {
    if (!deck.state.alive) return
    try {
      deck.tick()
    } catch (error) {
      note(`tick failed: ${String(error)}`)
    }
  }, TICK_MS)

  // Write the status file immediately so readers never wait a whole tick.
  deck.writeStatus(true)

  return async () => {
    clearInterval(timer)
    controller.abort()
    deck.stop()
    await contextHook.dispose()
    if (globals[CLAIM]?.generation === generation) globals[CLAIM].alive = false
    note(`cleanup generation=${generation}`)
  }
}

// ---------------------------------------------------------------------------
// Status file shape: the watcher is the one writer, other tools read this
// file. No host imports, no timers, no I/O below - so every rule can be
// exercised headlessly (see fixtures/run.ts).
//
// The shape answers ONE question out of band: how many sessions the fleet
// watcher is holding, how many of them are blocked, and how long since
// anything changed.

export type Reading = {
  at: number // ms epoch of the last detected change
  sweptAt: number // ms epoch of the last sweep (liveness)
  total: number
  watch: number // live (non-terminal, present) sessions
  blocked: number // errored + wedged + stalled
  errors: number // errored only (severity escalation)
  done: number // terminal titles (done)
  // Deprecated sticky fields from older status files: still parsed
  // tolerantly, never surfaced.
  event?: string
  injected?: boolean
  targetGone?: boolean
}

// A sweep must have landed inside this window or the file is stale: the default
// interval is 10s, so 90s is three missed sweeps plus slack.
export const STALE_MS = 90_000

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

// Tolerant reader: a status file that is absent, half-written, or from a future
// version is "unknown", never a crash. Returns undefined when nothing usable.
export function parseStatus(raw: string, now = Date.now()): Reading | undefined {
  if (!raw) return undefined
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    // a torn write (read mid-write) is not an error - the next poll gets it
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  if (num(parsed.version, 1) !== 1) return undefined
  const sweptAt = num(parsed.sweptAt)
  // A file with no sweep stamp cannot claim liveness.
  if (sweptAt <= 0) return undefined
  return {
    at: num(parsed.at, sweptAt),
    sweptAt,
    total: Math.max(0, num(parsed.total)),
    watch: Math.max(0, num(parsed.watch)),
    blocked: Math.max(0, num(parsed.blocked)),
    errors: Math.max(0, num(parsed.errors)),
    done: Math.max(0, num(parsed.done)),
    event: typeof parsed.event === "string" ? parsed.event : undefined,
    injected: parsed.injected === true,
    targetGone: parsed.targetGone === true,
  }
}

export function stale(reading: Reading | undefined, now: number, staleMs = STALE_MS): boolean {
  if (!reading) return true
  return now - reading.sweptAt > staleMs
}
