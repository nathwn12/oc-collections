// Shared, dependency-free RPC contract between the server plugin (which owns the
// real per-session store) and the TUI plugin (which only reads it).
//
// `Rpc.define` from `@opencode/plugin/rpc` is an identity helper — it validates
// reserved error names and returns the definition unchanged — so a plain JSON
// Schema object is exactly equivalent. This matters for a LOCAL directory plugin:
// the server runtime does not resolve the bare `@opencode/plugin` specifier, so
// importing it (or `/rpc`) would fail to load. Keeping the contract import-free
// makes both entrypoints load on the stock binary.
//
// `sessionID` is a plain string rather than the branded `Session.ID`, because the
// TUI reads whatever id the host hands it and passes it straight back.
export const Todo = {
  id: "todo",
  methods: {
    list: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string" },
                priority: { type: "string" },
                notes: { type: "array", items: { type: "string" } },
                createdAt: { type: "number" },
                updatedAt: { type: "number" },
              },
              required: ["id", "content", "status", "priority"],
              additionalProperties: false,
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
    // Cross-session roll-up: unfinished todos across ALL stored sessions, each
    // tagged with the session that owns it. Read-only, like `list`.
    open: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sessionID: { type: "string" },
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string" },
                priority: { type: "string" },
                updatedAt: { type: "number" },
              },
              required: ["sessionID", "id", "content", "status", "priority", "updatedAt"],
              additionalProperties: false,
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
  },
  events: {
    // Emitted after every durable write so a live TUI can refresh without polling.
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
} as const
