// @bun
// src/tui.tsx
import { Plugin } from "@opencode/plugin/tui";

// src/plugins.ts
function labelOf(plugin) {
  return plugin.id ?? plugin.source.target ?? plugin.source.path ?? "plugin";
}
var SELF_HOST_ID = "oc-plugin-view.host";
function installedPlugins(items) {
  return items.filter((item) => (item.source.type === "package" || item.source.type === "local") && item.id !== SELF_HOST_ID).sort((left, right) => {
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
          onMouseDown: props.onToggle,
          onMouseUp: props.onToggle,
          children: [
            items.length > 2 ? /* @__PURE__ */ jsx("text", {
              fg: theme.text.base,
              onMouseDown: props.onToggle,
              onMouseUp: props.onToggle,
              children: open ? "\u25BC" : "\u25B6"
            }) : null,
            /* @__PURE__ */ jsxs("text", {
              fg: theme.text.base,
              onMouseDown: props.onToggle,
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
          return /* @__PURE__ */ jsxs("box", {
            flexDirection: "row",
            gap: 1,
            minWidth: 0,
            onMouseUp: () => props.context.keymap.dispatch("plugins.list"),
            children: [
              /* @__PURE__ */ jsx("text", {
                flexShrink: 0,
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
                children: /* @__PURE__ */ jsx("b", {
                  children: labelOf(item)
                })
              }),
              /* @__PURE__ */ jsx("text", {
                fg: failed() ? theme.text.feedback.error.base : theme.text.muted,
                wrapMode: "none",
                flexShrink: 0,
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
    let lastToggle = 0;
    const toggle = () => {
      const now = Date.now();
      if (now - lastToggle < 200)
        return;
      lastToggle = now;
      if (state.items.length <= 2)
        return;
      updateView((draft) => {
        draft.open = !draft.open;
      }).catch((error) => console.error("Failed to persist Plugins sidebar state", error));
    };
    const load = () => {
      context.client.plugin.list({ location: context.location ?? context.data.location.default() }).then((result) => update((draft) => {
        draft.items = installedPlugins(result.data);
      })).catch((error) => console.warn("Failed to load plugins for the sidebar", error));
    };
    load();
    const unsubscribe = context.data.on("plugin.updated", load);
    context.ui.slot({
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
    return () => unsubscribe();
  }
});
export {
  SidebarPlugins,
  tui_default as default
};
