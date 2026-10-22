/**
 * Compatibility reporter — the honesty layer.
 *
 * Nothing is ever silently dropped. Every V1 hook is either bridged (full),
 * approximated (partial), or refused out loud (unsupported).
 */
import type { HookReport, SupportLevel } from "./types.js"
import { log } from "./log.js"

export interface Reporter {
  readonly id: string
  readonly correlationId?: string
  record(hook: string, level: SupportLevel, note?: string): void
  warn(message: string): void
  readonly reports: HookReport[]
}

export interface ReporterOptions {
  strict?: boolean
  verbose?: boolean
  /**
   * Durable mirror of every emitted line. The host discards stdout when it runs
   * as a background service or a stdio server, so console-only reporting is
   * unreachable there; the sink is the proof surface that survives. Best-effort:
   * a throwing sink must never break a mount.
   */
  sink?: (line: string) => void
  /** Correlation id of the bridge invocation that owns this reporter. */
  correlationId?: string
}

export function createReporter(id: string, opts: ReporterOptions = {}): Reporter {
  const reports: HookReport[] = []
  const tag = `[oc-bifrost:${id}]`

  const emit = (event: string, message: string) => {
    // Structured JSON line: level + event + plugin id + correlation id. The
    // human message rides in `detail` so existing greps keep matching.
    const line = log("warn", event, { plugin: id, correlationId: opts.correlationId, detail: message })
    try {
      opts.sink?.(line)
    } catch {
      // Reporting is additive; a broken sink is the sink's problem, not a mount's.
    }
  }

  return {
    id,
    correlationId: opts.correlationId,
    reports,
    record(hook, level, note) {
      reports.push(note === undefined ? { hook, level } : { hook, level, note })
      if (level === "unsupported") {
        const line = `unsupported V1 hook "${hook}"${note ? ` — ${note}` : ""}`
        if (opts.strict) throw new Error(`${tag} ${line}`)
        emit("hook.unsupported", `${line}; skipped`)
      } else if (level === "partial" && opts.verbose !== false) {
        emit("hook.partial", `partial bridge for "${hook}"${note ? ` — ${note}` : ""}`)
      }
    },
    warn(message) {
      emit("bridge.warn", message)
    },
  }
}

export function renderReport(reporter: Reporter): string {
  const order: Record<SupportLevel, number> = { full: 0, mounted: 1, partial: 2, unsupported: 3 }
  const rows = [...reporter.reports].sort((a, b) => order[a.level] - order[b.level])
  return rows.map((row) => `  ${row.level.padEnd(11)} ${row.hook}${row.note ? ` — ${row.note}` : ""}`).join("\n")
}
