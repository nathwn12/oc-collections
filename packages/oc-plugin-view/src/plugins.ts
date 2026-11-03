export type PluginSource = {
  readonly type: string
  readonly target?: string
  readonly path?: string
}

export type PluginState = {
  readonly status: "active" | "failed"
  readonly error?: string
}

export type InstalledPlugin = {
  readonly id?: string
  readonly source: PluginSource
  readonly state: PluginState
}

export function labelOf(plugin: InstalledPlugin): string {
  return plugin.id ?? plugin.source.target ?? plugin.source.path ?? "plugin"
}

const SELF_HOST_ID = "oc-plugin-view.host"

export function installedPlugins(items: readonly InstalledPlugin[]): InstalledPlugin[] {
  return items
    .filter(
      (item) =>
        (item.source.type === "package" || item.source.type === "local") && item.id !== SELF_HOST_ID,
    )
    .sort((left, right) => {
      const a = labelOf(left).toLowerCase()
      const b = labelOf(right).toLowerCase()
      return a < b ? -1 : a > b ? 1 : 0
    })
}

export function counts(items: readonly InstalledPlugin[]): { active: number; errors: number } {
  let active = 0
  let errors = 0
  for (const item of items) {
    if (item.state.status === "active") active++
    if (item.state.status === "failed") errors++
  }
  return { active, errors }
}

export function statusLabel(status: InstalledPlugin["state"]["status"]): "Active" | "Error" {
  return status === "active" ? "Active" : "Error"
}
