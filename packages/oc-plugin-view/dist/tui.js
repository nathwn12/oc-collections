// @bun
// src/tui.tsx
import { Plugin } from "@opencode/plugin/tui";

// src/plugins.ts
function labelOf(plugin) {
  const id = plugin.id?.endsWith(".host") === true ? plugin.id.slice(0, -".host".length) : plugin.id;
  return id ?? plugin.source.target ?? plugin.source.path ?? "plugin";
}
var SELF_NAME = "oc-plugin-view";
function isSelf(plugin) {
  const candidates = [plugin.id, plugin.source.target, plugin.source.path];
  return candidates.some((value) => typeof value === "string" && value.includes(SELF_NAME));
}
function installedPlugins(items) {
  return items.filter((item) => (item.source.type === "package" || item.source.type === "local") && !isSelf(item)).sort((left, right) => {
    const failedLeft = left.state.status === "failed" ? 0 : 1;
    const failedRight = right.state.status === "failed" ? 0 : 1;
    if (failedLeft !== failedRight)
      return failedLeft - failedRight;
    const a = labelOf(left).toLowerCase();
    const b = labelOf(right).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
function counts(items) {
  let active = 0;
  let errors = 0;
  for (const item of items) {
    if (item.state.status === "active")
      active++;
    if (item.state.status === "failed")
      errors++;
  }
  return { active, errors };
}
function statusLabel(status) {
  return status === "active" ? "Active" : "Error";
}

// src/tui.tsx
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
function SidebarPlugins(props) {
  const theme = props.context.theme;
  const items = props.items;
  const open = props.open;
  const totals = counts(items);
  return /* @__PURE__ */ jsx("box", {
    children: items.length > 0 ? /* @__PURE__ */ jsxs("box", {
      children: [
        /* @__PURE__ */ jsxs("box", {
          flexDirection: "row",
          gap: 1,
          children: [
            items.length > 2 ? /* @__PURE__ */ jsx("text", {
              fg: theme.text.base,
              onMouseUp: props.onToggle,
              children: open ? "\u25BC" : "\u25B6"
            }) : null,
            /* @__PURE__ */ jsxs("text", {
              fg: theme.text.base,
              wrapMode: "none",
              truncate: true,
              onMouseUp: props.onToggle,
              children: [
                /* @__PURE__ */ jsx("b", {
                  children: "Plugins"
                }),
                !open ? /* @__PURE__ */ jsxs("span", {
                  style: { fg: theme.text.muted },
                  children: [
                    " ",
                    "(",
                    totals.active,
                    " active",
                    totals.errors > 0 ? `, ${totals.errors} error${totals.errors > 1 ? "s" : ""}` : "",
                    ")"
                  ]
                }) : null
              ]
            })
          ]
        }),
        items.length <= 2 || open ? items.map((item) => {
          const failed = () => item.state.status === "failed";
          const openList = () => props.context.keymap.dispatch("plugins.list");
          return /* @__PURE__ */ jsxs("box", {
            flexDirection: "row",
            gap: 1,
            minWidth: 0,
            children: [
              /* @__PURE__ */ jsx("text", {
                flexShrink: 0,
                onMouseUp: openList,
                style: {
                  fg: failed() ? theme.text.feedback.error.base : theme.text.feedback.success.base
                },
                children: "\u2022"
              }),
              /* @__PURE__ */ jsx("text", {
                fg: theme.text.base,
                wrapMode: "none",
                truncate: true,
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                onMouseUp: openList,
                children: /* @__PURE__ */ jsx("b", {
                  children: labelOf(item)
                })
              }),
              /* @__PURE__ */ jsx("text", {
                fg: failed() ? theme.text.feedback.error.base : theme.text.muted,
                wrapMode: "none",
                flexShrink: 0,
                onMouseUp: openList,
                children: statusLabel(item.state.status)
              })
            ]
          });
        }) : null
      ]
    }) : null
  });
}
var tui_default = Plugin.define({
  id: "oc-plugin-view",
  setup(context) {
    const [state, update] = context.storage.memory("plugins", {
      initial: { items: [] }
    });
    const [view, updateView] = context.storage.store("view", { initial: { open: true } });
    const toggle = () => {
      if (state.items.length <= 2)
        return;
      updateView((draft) => {
        draft.open = !draft.open;
      }).catch((error) => console.error("Failed to persist Plugins sidebar state", error));
    };
    let generation = 0;
    let disposed = false;
    const load = () => {
      const id = ++generation;
      context.client.plugin.list({ location: context.location ?? context.data.location.default() }).then((result) => {
        if (disposed || id !== generation)
          return;
        update((draft) => {
          draft.items = installedPlugins(result.data);
        });
      }).catch((error) => console.warn("Failed to load plugins for the sidebar", error));
    };
    load();
    const unsubscribe = context.data.on("plugin.updated", load);
    const disposeSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const items = state.items;
        const open = view.open;
        return /* @__PURE__ */ jsx(SidebarPlugins, {
          context,
          items,
          open,
          onToggle: toggle
        });
      }
    });
    return () => {
      disposed = true;
      disposeSlot();
      unsubscribe();
    };
  }
});
export {
  SidebarPlugins,
  tui_default as default
};
