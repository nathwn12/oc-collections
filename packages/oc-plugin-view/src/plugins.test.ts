import { describe, expect, test } from "bun:test"
import { counts, installedPlugins, labelOf, statusLabel, type InstalledPlugin } from "./plugins"

function plugin(overrides: Partial<InstalledPlugin> & Pick<InstalledPlugin, "source">): InstalledPlugin {
  return {
    state: { status: "active" },
    ...overrides,
  }
}

const builtin = plugin({ id: "internal", source: { type: "builtin" } })
const sdk = plugin({ id: "sdk", source: { type: "sdk" } })
const pkg = plugin({ id: "other-plugin", source: { type: "package", target: "other-plugin" } })
const broken = plugin({
  id: "broken",
  source: { type: "package", target: "broken" },
  state: { status: "failed", error: "boom" },
})
const local = plugin({ source: { type: "local", path: "/plugins/local.ts" } })
const host = plugin({ id: "oc-plugin-view.host", source: { type: "package", target: "oc-plugin-view" } })

describe("installedPlugins", () => {
  test("keeps package and local sources and drops builtins and sdk entries", () => {
    expect(installedPlugins([builtin, pkg, sdk, local])).toEqual([local, pkg])
  })

  test("drops its own no-op server entry while keeping other package and local plugins", () => {
    expect(installedPlugins([host])).toEqual([])
    expect(installedPlugins([host, builtin, pkg, local])).toEqual([local, pkg])
  })

  test("excludes any entry whose id names oc-plugin-view", () => {
    const selfById = plugin({ id: "oc-plugin-view", source: { type: "package", target: "other" } })
    expect(installedPlugins([selfById])).toEqual([])
    expect(installedPlugins([selfById, pkg])).toEqual([pkg])
  })

  test("excludes any entry whose target or path names oc-plugin-view", () => {
    const selfByTarget = plugin({ source: { type: "package", target: "oc-plugin-view" } })
    const selfByPath = plugin({ source: { type: "local", path: "/plugins/oc-plugin-view.ts" } })
    expect(installedPlugins([selfByTarget])).toEqual([])
    expect(installedPlugins([selfByPath])).toEqual([])
    expect(installedPlugins([selfByTarget, selfByPath, pkg, local])).toEqual([local, pkg])
  })

  test("sorts case-insensitively by label", () => {
    const items = [
      plugin({ id: "zeta", source: { type: "package", target: "zeta" } }),
      plugin({ id: "Alpha", source: { type: "package", target: "Alpha" } }),
      plugin({ id: "beta", source: { type: "package", target: "beta" } }),
    ]
    expect(installedPlugins(items).map(labelOf)).toEqual(["Alpha", "beta", "zeta"])
  })
})

describe("labelOf", () => {
  test("falls back from id to target to path to plugin", () => {
    expect(labelOf(pkg)).toBe("other-plugin")
    expect(labelOf(plugin({ source: { type: "package", target: "@scope/name" } }))).toBe("@scope/name")
    expect(labelOf(local)).toBe("/plugins/local.ts")
    expect(labelOf(plugin({ source: { type: "local" } }))).toBe("plugin")
  })
})

describe("counts", () => {
  test("totals active and failed entries", () => {
    expect(counts([pkg, broken, local])).toEqual({ active: 2, errors: 1 })
    expect(counts([])).toEqual({ active: 0, errors: 0 })
  })
})

describe("statusLabel", () => {
  test("maps active to Active and failed to Error", () => {
    expect(statusLabel("active")).toBe("Active")
    expect(statusLabel("failed")).toBe("Error")
  })
})
