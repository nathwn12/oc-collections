/**
 * Structured bridge log — dependency-free JSON lines.
 *
 * Every line the bridge emits carries `level`, a short `event` name, the
 * plugin id (`plugin`) where relevant, and the `correlationId` of the bridge
 * invocation that produced it. One line per call, JSON, on the matching
 * console stream (`info` -> stdout, `warn`/`error` -> stderr).
 *
 * Payload rule: NEVER pass plugin code or user data here. Accepted fields
 * are identifiers and operational notes (`plugin`, `correlationId`,
 * `detail`, plus small safe scalars such as `messageLength`). A denylist of
 * payload-shaped keys is stripped defensively so a mistaken caller cannot
 * smuggle a body, input, output, or option bag into the log; `detail` itself
 * stays the caller's responsibility — keep it to specs, hook names, paths,
 * digests, and error text, never message bodies or option values.
 */

export type LogLevel = "info" | "warn" | "error"

export interface LogFields {
  plugin?: string
  correlationId?: string
  detail?: string
  [key: string]: unknown
}

/**
 * Payload-shaped keys that must never reach a log line. Stripped
 * defensively in `formatLogLine`; callers must still avoid smuggling
 * payloads inside `detail`.
 */
const PAYLOAD_KEYS = new Set([
  "body",
  "message",
  "input",
  "output",
  "code",
  "content",
  "parts",
  "data",
  "args",
  "env",
  "options",
])

/** One correlation id per bridge invocation; passed to every reporter and log call it makes. */
export function createCorrelationId(): string {
  try {
    const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    if (typeof crypto?.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    }
  } catch {
    // Fall through to the Math.random fallback below.
  }
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")}`
}

/** Render one JSON log line without writing it. Payload keys are dropped. */
export function formatLogLine(level: LogLevel, event: string, fields: LogFields = {}): string {
  const out: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  }
  if (typeof fields.plugin === "string") out.plugin = fields.plugin
  if (typeof fields.correlationId === "string") out.correlationId = fields.correlationId
  for (const [key, value] of Object.entries(fields)) {
    if (key === "plugin" || key === "correlationId") continue
    if (value === undefined) continue
    if (PAYLOAD_KEYS.has(key)) continue
    out[key] = value
  }
  return JSON.stringify(out)
}

/**
 * Write one structured line to the matching console stream and return it,
 * so callers can mirror the SAME line into the durable sink.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): string {
  const line = formatLogLine(level, event, fields)
  if (level === "info") console.log(line)
  else console.warn(line)
  return line
}
