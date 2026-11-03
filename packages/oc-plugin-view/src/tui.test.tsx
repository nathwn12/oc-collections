/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { testRender } from "@opentui/solid"
import { createStore, produce } from "solid-js/store"
import type { InstalledPlugin } from "./plugins"
import definition, { SidebarPlugins } from "./tui"

const color = RGBA.fromInts(200, 200, 200)

function context() {
  return {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: {
          success: { base: color },
          error: { base: color },
        },
      },
    },
    keymap: {
      dispatch: () => {},
    },
  } as unknown as Plugin.Context
}

function plugin(id: string, status: "active" | "failed"): InstalledPlugin {
  return { id, source: { type: "package", target: id }, state: { status } }
}

/** Mirrors the slot render: the store lives at the host boundary, the rendered props are plain values. */
function harness(items: InstalledPlugin[], open = true) {
  const [state, setState] = createStore({ items, open })
  const onToggle = () => {
    if (state.items.length <= 2) return
    setState("open", (value) => !value)
  }
  const ctx = context()

  return () => {
    const items = state.items
    const open = state.open
    return <SidebarPlugins context={ctx} items={items} open={open} onToggle={onToggle} />
  }
}

async function frame(items: InstalledPlugin[], open = true) {
  const app = await testRender(() => harness(items, open), { width: 44, height: 10 })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

test("hides the section when no plugins are installed", async () => {
  expect(await frame([])).not.toContain("Plugins")
})

test("renders labels and states when the section is open", async () => {
  const output = await frame([plugin("oc-plugin-view", "active"), plugin("broken", "failed")])
  expect(output).toContain("Plugins")
  expect(output).toContain("oc-plugin-view")
  expect(output).toContain("broken")
  expect(output).toContain("Active")
  expect(output).toContain("Error")
})

test("renders the collapsed summary", async () => {
  const output = await frame([plugin("a", "active"), plugin("b", "active"), plugin("c", "failed")], false)
  expect(output).toContain("Plugins (2 active, 1 error)")
  expect(output).not.toContain("oc-plugin-view")
})

test("header click collapses and expands the section", async () => {
  const view = harness([plugin("a", "active"), plugin("b", "active"), plugin("c", "active")])
  const app = await testRender(() => view, { width: 44, height: 10 })
  try {
    await app.renderOnce()
    const expanded = app.captureCharFrame()
    expect(expanded).toContain("Plugins")
    expect(expanded).toContain("▼ Plugins")
    expect(expanded).toContain("• a")
    expect(expanded).toContain("• b")
    expect(expanded).toContain("• c")

    await app.mockMouse.click(2, 0)
    await app.renderOnce()
    const collapsed = app.captureCharFrame()
    expect(collapsed).toContain("▶ Plugins (3 active)")
    expect(collapsed).not.toContain("• a")
    expect(collapsed).not.toContain("• b")
    expect(collapsed).not.toContain("• c")

    await app.mockMouse.click(2, 0)
    await app.renderOnce()
    const reopened = app.captureCharFrame()
    expect(reopened).toContain("▼ Plugins")
    expect(reopened).toContain("• a")
    expect(reopened).toContain("• b")
    expect(reopened).toContain("• c")
  } finally {
    app.renderer.destroy()
  }
})

test("a click toggles exactly once, even when held past 200 ms", async () => {
  const view = harness([plugin("a", "active"), plugin("b", "active"), plugin("c", "active")])
  const app = await testRender(() => view, { width: 44, height: 10 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▼ Plugins")

    await app.mockMouse.click(2, 0)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▶ Plugins (3 active)")

    const reopen = harness([plugin("a", "active"), plugin("b", "active"), plugin("c", "active")])
    const held = await testRender(() => reopen, { width: 44, height: 10 })
    try {
      await held.renderOnce()
      expect(held.captureCharFrame()).toContain("▼ Plugins")
      await held.mockMouse.pressDown(2, 0)
      await Bun.sleep(250)
      await held.mockMouse.release(2, 0)
      await held.renderOnce()
      expect(held.captureCharFrame()).toContain("▶ Plugins (3 active)")
    } finally {
      held.renderer.destroy()
    }
  } finally {
    app.renderer.destroy()
  }
})

test("a row click dispatches plugins.list", async () => {
  let dispatched: string | undefined
  const ctx = {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: {
          success: { base: color },
          error: { base: color },
        },
      },
    },
    keymap: {
      dispatch: (action: string) => {
        dispatched = action
      },
    },
  } as unknown as Plugin.Context
  const items = [plugin("alpha", "active"), plugin("beta", "failed")]
  const view = () => <SidebarPlugins context={ctx} items={items} open={true} onToggle={() => {}} />
  const app = await testRender(() => view, { width: 44, height: 10 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("alpha")
    await app.mockMouse.click(4, 1)
    await app.renderOnce()
    expect(dispatched).toBe("plugins.list")
  } finally {
    app.renderer.destroy()
  }
})

test("setup loads the filtered list, subscribes, and disposes the slot plus subscription on cleanup", async () => {
  let store: { items: InstalledPlugin[] } | undefined
  let view: { key: string; initial: { open: boolean } } | undefined
  let listed: string | undefined
  let subscribed: string | undefined
  let unsubscribed = false
  let slotDisposed = false
  let claim: { append?: string } | undefined
  const context = {
    location: { directory: "/workspace" },
    client: {
      plugin: {
        list: async (input: { location: { directory: string } }) => {
          listed = input.location.directory
          return {
            data: [
              { id: "internal", source: { type: "builtin" }, state: { status: "active" } },
              { id: "zeta", source: { type: "package", target: "zeta" }, state: { status: "active" } },
              {
                id: "broken",
                source: { type: "package", target: "broken" },
                state: { status: "failed", error: "boom" },
              },
              { source: { type: "local", path: "/plugins/a.ts" }, state: { status: "active" } },
              { id: "oc-plugin-view.host", source: { type: "package", target: "oc-plugin-view" }, state: { status: "active" } },
              { source: { type: "package", target: "oc-plugin-view" }, state: { status: "active" } },
            ],
          }
        },
      },
    },
    data: {
      location: { default: () => ({ directory: "/fallback" }) },
      on: (type: string) => {
        subscribed = type
        return () => {
          unsubscribed = true
        }
      },
    },
    storage: {
      memory: (_key: string, { initial }: { initial: { items: InstalledPlugin[] } }) => {
        const [state, set] = createStore(initial)
        store = state
        return [state, (mutation: (draft: { items: InstalledPlugin[] }) => void) => set(produce(mutation))]
      },
      store: (key: string, { initial }: { initial: { open: boolean } }) => {
        view = { key, initial }
        const [state, set] = createStore(initial)
        return [state, async (mutation: (draft: { open: boolean }) => void) => set(produce(mutation))]
      },
    },
    ui: {
      slot: (value: { append?: string }) => {
        claim = value
        return () => {
          slotDisposed = true
        }
      },
    },
  } as unknown as Plugin.Context

  const cleanup = await definition.setup(context)
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(listed).toBe("/workspace")
  expect(subscribed).toBe("plugin.updated")
  expect(claim?.append).toBe("sidebar.content")
  expect(view).toEqual({ key: "view", initial: { open: true } })
  expect(store?.items.map((item) => item.id ?? item.source.path)).toEqual(["/plugins/a.ts", "broken", "zeta"])
  cleanup?.()
  expect(unsubscribed).toBe(true)
  expect(slotDisposed).toBe(true)
})

test("a stale load result is dropped and no write happens after teardown", async () => {
  let store: { items: InstalledPlugin[] } | undefined
  let reloader: (() => void) | undefined
  let slotDisposed = false
  const resolvers: Array<(value: { data: InstalledPlugin[] }) => void> = []
  const context = {
    location: { directory: "/workspace" },
    client: {
      plugin: {
        list: () => new Promise<{ data: InstalledPlugin[] }>((resolve) => resolvers.push(resolve)),
      },
    },
    data: {
      location: { default: () => ({ directory: "/fallback" }) },
      on: (_type: string, callback: () => void) => {
        reloader = callback
        return () => {}
      },
    },
    storage: {
      memory: (_key: string, { initial }: { initial: { items: InstalledPlugin[] } }) => {
        const [state, set] = createStore(initial)
        store = state
        return [state, (mutation: (draft: { items: InstalledPlugin[] }) => void) => set(produce(mutation))]
      },
      store: (_key: string, { initial }: { initial: { open: boolean } }) => {
        const [state, set] = createStore(initial)
        return [state, async (mutation: (draft: { open: boolean }) => void) => set(produce(mutation))]
      },
    },
    ui: {
      slot: () => () => {
        slotDisposed = true
      },
    },
  } as unknown as Plugin.Context

  const cleanup = await definition.setup(context)
  expect(resolvers.length).toBe(1)
  reloader?.()
  expect(resolvers.length).toBe(2)

  resolvers[1]({
    data: [{ id: "zeta", source: { type: "package", target: "zeta" }, state: { status: "active" } }],
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(store?.items.map((item) => item.id)).toEqual(["zeta"])

  resolvers[0]({
    data: [{ id: "alpha", source: { type: "package", target: "alpha" }, state: { status: "active" } }],
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(store?.items.map((item) => item.id)).toEqual(["zeta"])

  reloader?.()
  expect(resolvers.length).toBe(3)
  cleanup?.()
  expect(slotDisposed).toBe(true)
  resolvers[2]({
    data: [{ id: "late", source: { type: "package", target: "late" }, state: { status: "active" } }],
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(store?.items.map((item) => item.id)).toEqual(["zeta"])
})
