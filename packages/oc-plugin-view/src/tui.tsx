import { Plugin } from "@opencode/plugin/tui"
import { counts, installedPlugins, labelOf, statusLabel, type InstalledPlugin } from "./plugins"

export function SidebarPlugins(props: {
  context: Plugin.Context
  items: InstalledPlugin[]
  open: boolean
  onToggle: () => void
}) {
  const theme = props.context.theme
  const items = props.items
  const open = props.open
  const totals = counts(items)

  return (
    <box>
      {items.length > 0 ? (
        <box>
          <box flexDirection="row" gap={1}>
            {items.length > 2 ? (
              <text fg={theme.text.base} onMouseUp={props.onToggle}>
                {open ? "▼" : "▶"}
              </text>
            ) : null}
            <text fg={theme.text.base} wrapMode="none" truncate onMouseUp={props.onToggle}>
              <b>Plugins</b>
              {!open ? (
                <span style={{ fg: theme.text.muted }}>
                  {" "}
                  ({totals.active} active
                  {totals.errors > 0 ? `, ${totals.errors} error${totals.errors > 1 ? "s" : ""}` : ""})
                </span>
              ) : null}
            </text>
          </box>
          {items.length <= 2 || open
            ? items.map((item) => {
                const failed = () => item.state.status === "failed"
                const openList = () => props.context.keymap.dispatch("plugins.list")
                return (
                  <box flexDirection="row" gap={1} minWidth={0}>
                    <text
                      flexShrink={0}
                      onMouseUp={openList}
                      style={{
                        fg: failed()
                          ? theme.text.feedback.error.base
                          : theme.text.feedback.success.base,
                      }}
                    >
                      •
                    </text>
                    <text
                      fg={theme.text.base}
                      wrapMode="none"
                      truncate
                      flexGrow={1}
                      flexShrink={1}
                      minWidth={0}
                      onMouseUp={openList}
                    >
                      <b>{labelOf(item)}</b>
                    </text>
                    <text
                      fg={failed() ? theme.text.feedback.error.base : theme.text.muted}
                      wrapMode="none"
                      flexShrink={0}
                      onMouseUp={openList}
                    >
                      {statusLabel(item.state.status)}
                    </text>
                  </box>
                )
              })
            : null}
        </box>
      ) : null}
    </box>
  )
}

export default Plugin.define({
  id: "oc-plugin-view",
  setup(context) {
    const [state, update] = context.storage.memory("plugins", {
      initial: { items: [] as InstalledPlugin[] },
    })
    const [view, updateView] = context.storage.store("view", { initial: { open: true } })

    const toggle = () => {
      if (state.items.length <= 2) return
      void updateView((draft) => {
        draft.open = !draft.open
      }).catch((error) => console.error("Failed to persist Plugins sidebar state", error))
    }

    let generation = 0
    let disposed = false
    const load = () => {
      const id = ++generation
      context.client.plugin
        .list({ location: context.location ?? context.data.location.default() })
        .then((result) => {
          if (disposed || id !== generation) return
          update((draft) => {
            draft.items = installedPlugins(result.data)
          })
        })
        .catch((error) => console.warn("Failed to load plugins for the sidebar", error))
    }

    load()
    const unsubscribe = context.data.on("plugin.updated", load)
    const disposeSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const items = state.items
        const open = view.open
        return <SidebarPlugins context={context} items={items} open={open} onToggle={toggle} />
      },
    })

    return () => {
      disposed = true
      disposeSlot()
      unsubscribe()
    }
  },
})
