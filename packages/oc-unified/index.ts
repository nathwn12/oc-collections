// ═══════════════════════════════════════════════════════════════════════════
//  oc-unified - ONE plugin carrying the fleet watcher, the lifeline daemon, and
//  the title renamer as internal features. A silent background helper: it
//  claims no display surface - no panel, no rows, no render tick, no host
//  display claim.
//
//  ONE module = ONE plugin. This default export is a single object with an `id`
//  and a `setup`; an ARRAY is rejected by both loaders. Distinct RPC ids coexist
//  (the daemon keeps `oc-lifeline`, the renamer keeps `oc-masthead`).
//
//  Wiring order: fleet, lifeline, masthead.
//
//  Each feature keeps its own internal guards and its own config block, resolved
//  through the single resolver in config.ts. A feature that is switched off
//  (the `fleet` block's `enabled:false`, or the `lifeline` block's
//  `enabled:false`) returns a no-op disposer and leaves the others running,
//  exactly as the standalone units behaved.
//
//  FEATURE ISOLATION. As three separate plugins, one unit's setup could not stop
//  another's: the host wired each independently. The fusion must not create that
//  coupling, so each feature is wired in its own guarded step - a feature whose
//  setup rejects is REPORTED through this unit's note sink and never prevents the
//  remaining features from wiring. Nothing is swallowed: the failure lands in the
//  note path (one timestamped line) and the other features still run.
// ═══════════════════════════════════════════════════════════════════════════

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import type { Plugin } from "@opencode/plugin"
import { stateDir } from "./config.ts"
import { setupFleet } from "./fleet.ts"
import { setupLifeline } from "./lifeline.ts"
import { setupMasthead } from "./masthead.ts"

// The unified unit's own note sink: the report path for a feature that failed to
// wire or to tear down. `OC_UNIFIED_NOTE` overrides the path - the same override
// idiom the fleet watcher already used for `OC_FLEET_MARKER` - so a proof can
// point the note at a staged path instead of the live state root. The default
// sits under the platform state directory (config.ts `stateDir`), so no
// committed byte carries a literal user path.
const notePath = () =>
  process.env.OC_UNIFIED_NOTE ?? join(stateDir(), "oc-unified.log")

function note(tag: string) {
  try {
    const path = notePath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${tag} ${new Date().toISOString()}\n`)
  } catch {
    // a failed note is never fatal
  }
}

type Disposer = () => Promise<void> | void

const defaultExport = {
  id: "oc-unified",
  setup: async (ctx: Plugin.Context) => {
    // Each feature wires in its own guarded step, so one failure is isolated to
    // that feature - exactly the independence the three standalone plugins had.
    const wired: Disposer[] = []
    const wire = async (name: string, feature: (ctx: Plugin.Context) => Promise<Disposer>) => {
      try {
        wired.push(await feature(ctx))
      } catch (error) {
        note(`feature ${name} failed to wire: ${String(error)}`)
      }
    }
    await wire("fleet", setupFleet)
    await wire("lifeline", setupLifeline)
    await wire("masthead", setupMasthead)

    // Teardown in reverse: the renamer, then the daemon, then the watcher. A
    // feature that never wired has no disposer here, and a disposer that throws
    // is reported and never stops the others from tearing down.
    return async () => {
      for (const dispose of [...wired].reverse()) {
        try {
          await dispose()
        } catch (error) {
          note(`feature teardown failed: ${String(error)}`)
        }
      }
    }
  },
}

export default defaultExport
