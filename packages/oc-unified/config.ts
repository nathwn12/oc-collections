// ═══════════════════════════════════════════════════════════════════════════
//  oc-unified - THE shared configuration resolver.
//
//  ONE place owns where configuration comes from. Every feature reads its block
//  through a reader below; no feature resolves a path of its own.
//
//  The config file defaults to `oc-unified.jsonc` inside the platform's config
//  directory (`XDG_CONFIG_HOME`, else `~/.config` - the same layout on macOS
//  and Windows, so no committed byte carries a user path). It is neutral by
//  default: an absent file, an absent block, or an unparseable document means
//  "unconfigured", and each feature falls back to its own documented neutral
//  defaults (observe-only - no enforced vocabulary, no terminal tokens, no
//  recipient) exactly as this file's readers describe.
//
//  OVERRIDES, highest first: an explicit plugin option (`config`, or
//  `oc-unified.config` - the `{package, options}` spec form; a bare-string
//  spec carries no options and simply skips this rung), then the
//  `OC_UNIFIED_CONFIG` env var (the same override idiom the fleet watcher
//  already used for `OC_FLEET_STATUS` / `OC_FLEET_ESCALATIONS` /
//  `OC_FLEET_MARKER`: the headless fixture points it at its own temp copy, so
//  a proof never reads the live file), then the default above.
//
//  BLOCKS. `fleet` (the fleet watcher) and `masthead` (the title renamer) arrive
//  through the block readers below. Lifeline's `lifeline` / `caution` are turned
//  into its Policy by `lifelinePolicy`, which owns their defaults and their
//  validation - and reads them through the SAME resolver path, so this unit
//  has exactly one config path and one JSONC pass.
//
//  The advisory context nudger is GONE (replaced by the DCP plugin): the
//  `context` block is no longer read and carries no meaning here.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

// The default config file name. A previous generation defaulted to a
// harness-specific file; that name now lives only in that harness's own
// explicit override, never here.
export const DEFAULT_CONFIG_NAME = "oc-unified.jsonc"

// The platform config directory, XDG-aware: `XDG_CONFIG_HOME` wins, else the
// home-rooted `.config` lane (same layout on macOS and Windows). Env-derived,
// never a literal user path.
export function configDir(env: Record<string, string | undefined> = process.env): string {
  const xdg = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : ""
  if (xdg) return xdg
  return join(homedir(), ".config")
}

// The explicit path a registration-options object names, if any. Both plugin
// spec forms are supported: a bare string names the file directly, and an
// options object names it under `config` (or the per-feature `oc-unified`
// sub-object's `config`). Absent options behave exactly as before.
export function optionsConfigPath(options: unknown): string | undefined {
  if (typeof options === "string" && options.trim()) return options.trim()
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined
  const record = options as Record<string, unknown>
  const sub = record["oc-unified"]
  const nested =
    sub && typeof sub === "object" && !Array.isArray(sub)
      ? (sub as Record<string, unknown>)["config"]
      : undefined
  const candidate = nested ?? record["config"]
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined
}

// The config file path: registration options win over the env var, which wins
// over the platform default. Every block reader resolves through here, so a
// tree that shares one file (options or env pointing at it) is honoured.
export function configPath(
  env: Record<string, string | undefined> = process.env,
  options?: unknown,
): string {
  const fromOptions = optionsConfigPath(options)
  if (fromOptions) return fromOptions
  const override = typeof env.OC_UNIFIED_CONFIG === "string" ? env.OC_UNIFIED_CONFIG.trim() : ""
  if (override) return override
  return join(configDir(env), "opencode", DEFAULT_CONFIG_NAME)
}

// The basename of the resolved file, for policy `source` tokens: human-useful,
// stable across machines, and never a user path.
export function configSource(path: string): string {
  try {
    return basename(path)
  } catch {
    return DEFAULT_CONFIG_NAME
  }
}

// The platform state directory for marker/diagnostic files: an explicit
// plugin option (`stateDir`, or `oc-unified.stateDir`) wins, then the
// `OC_UNIFIED_STATE` env var, then the platform default (XDG_STATE_HOME on
// POSIX, ~/Library on macOS, %LOCALAPPDATA% on Windows). A tree that keeps
// historical paths pins them with the override; a stranger gets the platform
// convention with no configuration.
export function stateDir(
  env: Record<string, string | undefined> = process.env,
  options?: unknown,
): string {
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const record = options as Record<string, unknown>
    const sub = record["oc-unified"]
    const nested =
      sub && typeof sub === "object" && !Array.isArray(sub)
        ? (sub as Record<string, unknown>)["stateDir"]
        : undefined
    const candidate = nested ?? record["stateDir"]
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  const override = typeof env.OC_UNIFIED_STATE === "string" ? env.OC_UNIFIED_STATE.trim() : ""
  if (override) return override
  if (process.platform === "win32") {
    const local = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()
      ? env.LOCALAPPDATA.trim()
      : join(homedir(), "AppData", "Local")
    return join(local, "opencode")
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "opencode")
  const xdg = typeof env.XDG_STATE_HOME === "string" ? env.XDG_STATE_HOME.trim() : ""
  if (xdg) return join(xdg, "opencode")
  return join(homedir(), ".local", "state", "opencode")
}

// JSONC in, JSON out: strip comments only OUTSIDE string literals, so a URL in
// the `$schema` line survives. Same proven pass the fleet watcher used.
function stripJsonc(text: string): string {
  let out = ""
  let inString = false
  let escaped = false
  let inLine = false
  let inBlock = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inLine) {
      if (char === "\n") {
        inLine = false
        out += char
      }
      continue
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false
        index += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === "/" && next === "/") {
      inLine = true
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      inBlock = true
      index += 1
      continue
    }
    out += char
  }
  return out
}

// The parsed harness config document, or {} when it is absent or unparseable.
// A non-object document (an array, a bare literal) is the same verdict: nothing.
export function readConfig(path = configPath()): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(readFileSync(path, "utf8")))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

// One block, or undefined when the file, the block, or its shape is missing.
// Undefined is the feature's signal to fall back to its own documented neutral
// defaults. The path resolves through the one precedence (options > env >
// default), so a tree sharing one file is honoured whichever way it points.
export function readBlock(
  name: string,
  path?: string,
  options?: unknown,
): Record<string, unknown> | undefined {
  const value = readConfig(path ?? configPath(process.env, options))[name]
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function fleetBlock(path?: string, options?: unknown): Record<string, unknown> | undefined {
  return readBlock("fleet", path, options)
}

export function mastheadBlock(
  path?: string,
  options?: Readonly<Record<string, unknown>> | string,
): Record<string, unknown> | undefined {
  const file = readBlock("masthead", path, options)
  // Registration options win over the file (host forwards them via ctx.options);
  // absent options behave byte-identically to today. Selection mirrors fleet.ts:
  // the per-feature `oc-masthead` sub-object wins, else the whole options object.
  // A bare-string options form names the FILE (resolved above), never a block.
  if (options === undefined || typeof options === "string") return file
  const deck: unknown = options["oc-masthead"] ?? options
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) return file
  const overlay = deck as Record<string, unknown>
  if (!file) return Object.keys(overlay).length ? { ...overlay } : undefined
  return { ...file, ...overlay }
}

// Lifeline's blocks: raw, exactly as written in the shared file. Lifeline owns
// every key's meaning and default; these readers only find them, and
// `lifelinePolicy` below is the one place they become a policy.
export function lifelineBlock(path?: string, options?: unknown): Record<string, unknown> | undefined {
  return readBlock("lifeline", path, options)
}

export function cautionBlock(path?: string, options?: unknown): Record<string, unknown> | undefined {
  return readBlock("caution", path, options)
}

// NOTE: there is deliberately no `contextBlock` reader. The advisory context
// nudger was removed (the DCP plugin owns that surface now): a `context` block,
// if present in the file, is unread and meaningless.
//
// NOTE: there is deliberately no reader for the `panel` key. The display
// surface is gone (this plugin renders nothing): a leftover `panel` block,
// if present in the file, is unread and meaningless - never an error and
// never a render.

// ---------------------------------------------------------------------------
//  LIFELINE POLICY - the one place lifeline's two blocks are read, defaulted,
//  and validated. (moved from plugins/oc-lifeline/index.ts readPolicy)
//
//  The path is the resolver's (`configPath`), never a literal, so a fixture that
//  points OC_UNIFIED_CONFIG at its own copy is honoured. The defaults and the
//  validation are the live plugin's, key for key: an absent file, an unparseable
//  document, or a bad value falls back exactly where it did before.
//
//  The advisory context nudger is GONE (replaced by the DCP plugin), so no
//  `context` block is read and no band/threshold/cap key exists on this policy.
// ---------------------------------------------------------------------------

export type LifelinePolicy = {
  exempt: string[]
  fallbackMs: number
  toolBoundsMs: Record<string, number>
  ceilingMs: number
  source: string
  lifelineEnabled: boolean
  repairArmed: boolean
  pulseEnabled: boolean
}

// The built-in exempt list, used when `caution.exemptTools` is absent or empty:
// these tools are long-running BY NATURE, so "slow" is not an anomaly for them.
const DEFAULT_EXEMPT = [
  "question",
  "task",
  "subagent",
  "agent",
  "delegate",
  "delegate_many",
  "delegate_task",
  "tools.delegate",
  "tools.delegate_many",
  "tools.subagent",
  "tools.task",
]

// The global fallback bound when `caution.toolCautionSeconds` is absent.
const FALLBACK_WATCH_MS = 420_000

// The shipped per-tool watch table: generically sensible bounds for the tools
// a host exposes, kept as the default every install starts from. A
// `caution.toolBoundsMs` object overrides individual tools (validated positive
// finite milliseconds); tools it does not name keep these values, and tools
// neither names fall back to the policy's `fallbackMs`.
// `execute` runs the Code Mode catalog only: nothing it can await is
// background-by-design, so its bound sits under the ceiling (see below).
export const DEFAULT_TOOL_WATCH_MS: Record<string, number> = {
  read: 120_000,
  grep: 180_000,
  glob: 180_000,
  webfetch: 180_000,
  shell: 600_000,
  execute: 300_000,
}

// The shipped hard global ceiling, matching the historical 600 s default. A
// NON-exempt call older than this is WEDGED whatever its per-tool bound says;
// the effective bound is Math.min(per-tool-or-fallback, ceilingMs). The
// per-tool table is unchanged by it - the ceiling only ever LOWERS the limit.
// Overridable with `caution.ceilingSeconds`.
export const DEFAULT_CEILING_MS = 600_000

export function lifelinePolicy(
  path?: string,
  options?: Readonly<Record<string, unknown>> | string,
): LifelinePolicy {
  const resolved = path ?? configPath(process.env, options)
  // Registration options win over the file (host forwards them via ctx.options);
  // absent options behave byte-identically to today. Selection mirrors fleet.ts:
  // the per-feature `oc-lifeline` sub-object wins, else the whole options object.
  // Each block below is the file's block with the options block shallow-merged
  // over it, so the file stays the fallback and the file source is kept when
  // options win (the options-keep-file-source invariant). A bare-string options
  // form names the FILE (resolved above), never a block overlay.
  const deck: unknown =
    options === undefined || typeof options === "string"
      ? {}
      : (options as Record<string, unknown>)["oc-lifeline"] ?? options
  const overlayFor = (name: string): Record<string, unknown> | undefined => {
    const block = (deck as Record<string, unknown>)[name]
    return block && typeof block === "object" && !Array.isArray(block)
      ? (block as Record<string, unknown>)
      : undefined
  }
  const over = (name: string, fileBlock: unknown): any => {
    const base =
      fileBlock && typeof fileBlock === "object" && !Array.isArray(fileBlock)
        ? (fileBlock as Record<string, unknown>)
        : {}
    const overlay = overlayFor(name)
    return overlay ? { ...base, ...overlay } : base
  }
  // One derivation for both paths: merged blocks in, validated Policy out. Only
  // the reported source differs, so it rides along as an argument.
  const derive = (lifeline: any, caution: any, source: string): LifelinePolicy => {
    const exempt =
      Array.isArray(caution.exemptTools) && caution.exemptTools.length
        ? caution.exemptTools.filter((value: unknown): value is string => typeof value === "string")
        : DEFAULT_EXEMPT
    const fallbackMs =
      typeof caution.toolCautionSeconds === "number"
        ? caution.toolCautionSeconds * 1_000
        : FALLBACK_WATCH_MS
    // Per-tool overrides ride over the shipped table; the table itself is the
    // neutral default every install starts from.
    const toolBoundsMs = { ...DEFAULT_TOOL_WATCH_MS }
    const bounds = caution.toolBoundsMs
    if (bounds && typeof bounds === "object" && !Array.isArray(bounds)) {
      for (const [tool, ms] of Object.entries(bounds as Record<string, unknown>)) {
        if (typeof tool === "string" && tool && typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
          toolBoundsMs[tool] = ms
        }
      }
    }
    const ceilingMs =
      typeof caution.ceilingSeconds === "number" &&
      Number.isFinite(caution.ceilingSeconds) &&
      caution.ceilingSeconds > 0
        ? caution.ceilingSeconds * 1_000
        : DEFAULT_CEILING_MS
    return {
      exempt,
      fallbackMs,
      toolBoundsMs,
      ceilingMs,
      source,
      lifelineEnabled: lifeline.enabled !== false,
      repairArmed: lifeline.repair === true,
      pulseEnabled: lifeline.pulse !== false,
    }
  }
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(resolved, "utf8")))
    return derive(
      over("lifeline", parsed?.lifeline),
      over("caution", parsed?.caution),
      configSource(resolved),
    )
  } catch {
    // Absent or unparseable: the documented defaults, with the registration-
    // options overlay still applied (fleet.ts mirror: options win even with no
    // file block, and the source then reads "options"). Without options this is
    // byte-identical to the old fallback, same source token included.
    if (options === undefined) return derive({}, {}, "defaults (policy unreadable)")
    return derive(
      over("lifeline", undefined),
      over("caution", undefined),
      "options",
    )
  }
}
