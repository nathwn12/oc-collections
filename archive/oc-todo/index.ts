// oc-todo - a V1-style per-session todo list for OpenCode V2.
//
// The list is REAL, per-session state: every mutation is written to the plugin
// storage under a session-scoped key, and every read returns exactly what is
// stored. Nothing here is ephemeral UI text.
//
// Three surfaces, one store:
//   - the `todo` tool, so the model/agent can add, update, complete, and clear
//   - this server plugin's `todo.list` RPC, so external clients can read it
//   - the `tui.tsx` CLI plugin, a read-only checklist renderer over the RPC
//
// `Plugin.define` is an identity helper, so the plugin is exported as a plain
// `{ id, setup }` definition. That keeps the server entry loadable even where
// the bare `@opencode/plugin` specifier is not resolvable (observed on the
// stock 2.0.22 binary for local directory plugins).
//
// Wire format, all JSON-serializable:
//   { version: 1, todos: [{ id, content, status, priority, createdAt, updatedAt }] }
// status:   "pending" | "in_progress" | "completed" | "cancelled"
// priority: "high" | "medium" | "low"

import { Todo } from "./contract.js"

export { Todo } from "./contract.js"

interface TodoItem {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
  notes?: string[]
  createdAt: number
  updatedAt: number
}

interface TodoListState {
  version: 1
  todos: TodoItem[]
}

const STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const
const PRIORITIES = ["high", "medium", "low"] as const

const isStatus = (value: unknown): value is TodoItem["status"] =>
  (STATUSES as readonly unknown[]).includes(value)
const isPriority = (value: unknown): value is TodoItem["priority"] =>
  (PRIORITIES as readonly unknown[]).includes(value)

// Storage keys are global to the plugin, so the session is folded into the key.
// This is what makes the list session-scoped and durable across server restarts.
const OPEN_PREFIX = "todos/session/"
const keyOf = (sessionID: string) => `${OPEN_PREFIX}${sessionID}`

function emptyState(): TodoListState {
  return { version: 1, todos: [] }
}

/**
 * Coerce arbitrary input into a valid `notes` array, or `undefined` when there is
 * nothing usable. Keeps only string entries, trims each, drops empties. Used by
 * both the write path and `coerce`, so stored and incoming notes repair alike.
 */
export function coerceNotes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const notes: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string") continue
    const trimmed = entry.trim()
    if (trimmed) notes.push(trimmed)
  }
  return notes.length > 0 ? notes : undefined
}

/** Array equality, order-sensitive. Used for the notes no-op check. */
function sameNotes(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Read stored state defensively: a hand-edited or partially-written row must
 * never make `todo.list` violate its output contract (that would reject the
 * whole call and blank the TUI). Every field is repaired to a valid value.
 */
export function coerce(raw: unknown): TodoListState {
  if (!raw || typeof raw !== "object") return emptyState()
  const value = raw as Partial<TodoListState>
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  if (Array.isArray(value.todos)) {
    for (const item of value.todos) {
      if (!item || typeof item !== "object") continue
      const todo = item as Partial<TodoItem>
      if (typeof todo.id !== "string" || todo.id === "") continue
      // A duplicated store row is permanent unless repaired here: keep the
      // first row owning an id and drop later repeats, so a duplicate reloads
      // as a single addressable row.
      if (seen.has(todo.id)) continue
      seen.add(todo.id)
      const repaired: TodoItem = {
        id: todo.id,
        content: typeof todo.content === "string" ? todo.content : "",
        status: isStatus(todo.status) ? todo.status : "pending",
        priority: isPriority(todo.priority) ? todo.priority : "medium",
        createdAt: typeof todo.createdAt === "number" && Number.isFinite(todo.createdAt) ? todo.createdAt : 0,
        updatedAt: typeof todo.updatedAt === "number" && Number.isFinite(todo.updatedAt) ? todo.updatedAt : 0,
      }
      const notes = coerceNotes(todo.notes)
      if (notes) repaired.notes = notes
      todos.push(repaired)
    }
  }
  return { version: 1, todos }
}

async function readState(
  store: { get(key: string): Promise<any> },
  sessionID: string,
): Promise<TodoListState> {
  return coerce(await store.get(keyOf(sessionID)))
}

async function writeState(
  store: { set(key: string, value: any): Promise<void> },
  sessionID: string,
  state: TodoListState,
): Promise<void> {
  await store.set(keyOf(sessionID), state as never)
}

/**
 * Enumerate every stored session todo row through the host storage scan. Pages by
 * `after`/`next`; a page that returns no `next` ends the walk, and a hostile
 * repeating `next` cannot loop forever because each step must advance strictly.
 * An empty page with a `next` still continues: a sparse backend may return one.
 */
export async function scanSessionRows(
  storage: { scan(options: { prefix: string; after?: string; limit?: number }): Promise<any> },
): Promise<Array<{ key: string; value: unknown }>> {
  const rows: Array<{ key: string; value: unknown }> = []
  let after: string | undefined
  for (;;) {
    const page = await storage.scan({ prefix: `${OPEN_PREFIX}`, after, limit: 1000 })
    const entries: Array<{ key: string; value: unknown }> = Array.isArray(page?.entries) ? page.entries : []
    rows.push(...entries)
    const next = page?.next
    if (typeof next !== "string" || next === after) break
    after = next
  }
  return rows
}

/**
 * Resolve a todo by exact id, then by a unique prefix. An ambiguous prefix is
 * an error, never a silent pick of the first match.
 */
export function findTodo(todos: TodoItem[], id: string | undefined): { index: number; error?: string } {
  if (!id) return { index: -1, error: "no id given" }
  const exact = todos.findIndex((todo) => todo.id === id)
  if (exact >= 0) return { index: exact }
  const matches = todos.flatMap((todo, index) => (todo.id.startsWith(id) ? [index] : []))
  if (matches.length === 0) return { index: -1, error: `no todo matching id "${id}"` }
  if (matches.length > 1) return { index: -1, error: `ambiguous id "${id}" matches ${matches.length} todos` }
  return { index: matches[0] }
}

/** The `todo` tool's human/agent-facing description (kept beside the schema so the
 *  move selector rule reads the same in both). */
export const TODO_TOOL_DESCRIPTION =
  "Use for any multi-step task to track progress across turns.\n" +
  "Manage the current session's todo list. Read back the real stored list for this session with action 'list'. " +
  "Mutations: 'write' (V1 todowrite parity: replace the whole list from `todos`), 'add' (content [status] [priority] [notes]), " +
  "'update' (id [content] [status] [priority] [notes]), 'complete' (id), " +
  "'move' (id plus EXACTLY ONE of before/after/position), 'clear' (wipes the list). " +
  "'open' lists unfinished todos across ALL sessions. Statuses: pending, in_progress, completed, cancelled. " +
  "Priorities: high, medium, low. The list persists per session across turns and is not auto-pruned."

/**
 * The `todo` tool's input schema. Extracted (and exported) so a test can assert
 * the move selector guard is scoped to action 'move' — the guard's whole point is
 * that it does not reject a non-move call carrying extra selector keys.
 *
 * The move rule is "give EXACTLY ONE of before/after/position". The schema pins
 * that rule to 'move' (via `if`/`then`), so:
 *   - action 'move' with 2+ selectors is refused before execute runs;
 *   - action 'move' with 0 or 1 selector passes the schema (whether 0 is an error
 *     depends on nothing else) and the runtime gives the exact summary;
 *   - any non-'move' action is never touched by the guard, whatever keys it sends.
 * Runtime `applyMutation` stays authoritative for the zero/one/many cases and for
 * the exact `move: give exactly one of before, after, or position` summary.
 */
export function todoToolSchema() {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "open", "add", "update", "complete", "move", "clear", "write"],
        description: "What to do with the session todo list. Start with 'list' or 'write' for multi-step work.",
      },
      todos: {
        type: "array",
        description:
          "Full replacement list for action 'write' (V1 todowrite parity). Each item needs content; " +
          "id/status/priority/notes are optional (id keeps an existing item's identity and createdAt).",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            priority: { type: "string", enum: ["high", "medium", "low"] },
            notes: { type: "array", items: { type: "string" } },
          },
          required: ["content"],
        },
      },
      id: {
        type: "string",
        description: "Todo id (exact, or an unambiguous prefix) for update/complete/move.",
      },
      content: { type: "string", description: "Todo text for add, or replacement text for update." },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "cancelled"],
        description: "Status for update.",
      },
      priority: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Priority for add or update.",
      },
      notes: {
        type: "array",
        items: { type: "string" },
        description: "Notes for add, or the replacement notes array for update (empty clears).",
      },
      before: {
        type: "string",
        description:
          "For action 'move': insert the item before the todo with this id. Give EXACTLY ONE of before/after/position.",
      },
      after: {
        type: "string",
        description:
          "For action 'move': insert the item after the todo with this id. Give EXACTLY ONE of before/after/position.",
      },
      position: {
        type: "number",
        description: "For action 'move': 0-based target index (clamped). Give EXACTLY ONE of before/after/position.",
      },
    },
    required: ["action"],
    additionalProperties: false,
    // The move selector rule, pinned to action 'move'. Without the pin the guard
    // would reject any non-move call that happened to carry two of those keys,
    // even though no other action reads them.
    allOf: [
      {
        if: { properties: { action: { const: "move" } }, required: ["action"] },
        then: {
          oneOf: [
            { not: { anyOf: [{ required: ["before"] }, { required: ["after"] }, { required: ["position"] }] } },
            {
              oneOf: [{ required: ["before"] }, { required: ["after"] }, { required: ["position"] }],
              allOf: [
                { not: { required: ["before", "after"] } },
                { not: { required: ["before", "position"] } },
                { not: { required: ["after", "position"] } },
              ],
            },
          ],
        },
      },
      // The write rule: a 'write' MUST carry `todos`, so `{action:"write"}` alone
      // cannot silently wipe the list. `todos: []` is still an explicit clear.
      {
        if: { properties: { action: { const: "write" } }, required: ["action"] },
        then: { required: ["todos"] },
      },
    ],
  }
}

/** Apply one mutation, purely, to an immutable state and return the next state. */
export function applyMutation(
  state: TodoListState,
  input: {
    action: "add" | "update" | "complete" | "clear" | "write" | "move"
    id?: string
    content?: string
    status?: string
    priority?: string
    notes?: string[]
    before?: string
    after?: string
    position?: number
    todos?: ReadonlyArray<{ id?: string; content?: string; status?: string; priority?: string; notes?: string[] }>
  },
): { state: TodoListState; summary: string } {
  const now = Date.now()
  const todos = state.todos.map((todo) => ({ ...todo }))

  switch (input.action) {
    case "clear":
      if (todos.length === 0) return { state, summary: "List is already empty" }
      return { state: { version: 1, todos: [] }, summary: `Cleared ${todos.length} todo(s)` }

    // V1 `todowrite` parity: the caller supplies the whole list and it replaces
    // the previous one. Existing ids are kept, new items get fresh ids, blank
    // items are dropped, and a repeated id within one write is de-duplicated.
    case "write": {
      if (!Array.isArray(input.todos)) return { state, summary: "write requires todos" }
      const previous = new Map(state.todos.map((todo) => [todo.id, todo]))
      const used = new Set<string>()
      const next: TodoItem[] = []
      for (const [index, entry] of (input.todos ?? []).entries()) {
        if (!entry || typeof entry !== "object") continue
        const content = typeof entry.content === "string" ? entry.content.trim() : ""
        if (!content) continue
        const status = isStatus(entry.status) ? entry.status : "pending"
        const priority = isPriority(entry.priority) ? entry.priority : "medium"
        const explicit = typeof entry.id === "string" && entry.id ? entry.id : undefined
        let id = explicit ?? `${now.toString(36)}${(index + 1).toString(36)}`
        // Any id must be unique against ids already taken in this write. A GENERATED
        // id (and any id we regenerate to) must additionally be unique against ids
        // owned by the previous list, so a regeneration can never silently inherit
        // another row's identity. A caller-supplied id is kept as given (that is how
        // write preserves identity across a replace) until it duplicates one used in
        // this same write. Bounded so a pathological input cannot spin forever.
        const ownedByPrevious = (candidate: string) => candidate !== explicit && previous.has(candidate)
        for (let attempt = 0; used.has(id) || ownedByPrevious(id); attempt++) {
          id = `${now.toString(36)}${(index + 1).toString(36)}${next.length.toString(36)}${attempt ? attempt.toString(36) : ""}`
          if (attempt > 64) break
        }
        // The bounded loop above can still hold a colliding id when every
        // predictable candidate is taken. Escape the predictable space with a
        // random suffix (reassigned onto the colliding id, so each iteration
        // differs even with a pinned clock) instead of accepting the collision.
        while (used.has(id) || ownedByPrevious(id)) {
          id = `${id}-${now.toString(36)}${Math.random().toString(36).slice(2)}`
        }
        used.add(id)
        const prior = previous.get(id)
        const item: TodoItem = { id, content, status, priority, createdAt: prior?.createdAt ?? now, updatedAt: now }
        const notes = coerceNotes(entry.notes)
        if (notes) item.notes = notes
        next.push(item)
      }
      return { state: { version: 1, todos: next }, summary: `Wrote ${next.length} todo(s)` }
    }

    case "add": {
      const content = typeof input.content === "string" ? input.content.trim() : ""
      if (!content) return { state, summary: "add requires content" }
      const status = isStatus(input.status) ? input.status : "pending"
      const priority = isPriority(input.priority) ? input.priority : "medium"
      // The mint is timestamp plus length, so a planted row (an explicit `write`
      // id or a hand-edited store entry) can already own the next mint. Suffix
      // until the id is unique, mirroring the `write` regeneration. Bounded so a
      // pathological store cannot spin forever.
      let id = `${now.toString(36)}${(todos.length + 1).toString(36)}`
      if (todos.some((todo) => todo.id === id)) {
        const base = id
        for (let attempt = 0; todos.some((todo) => todo.id === id); attempt++) {
          id = `${base}${todos.length.toString(36)}${attempt ? attempt.toString(36) : ""}`
          if (attempt > 64) break
        }
        // Same escape as `write`: the bounded loop can still hold a colliding
        // id when every predictable candidate is planted. Suffix randomly off
        // the colliding id (each iteration differs even with a pinned clock)
        // instead of minting a duplicate.
        while (todos.some((todo) => todo.id === id)) {
          id = `${id}-${now.toString(36)}${Math.random().toString(36).slice(2)}`
        }
      }
      const item: TodoItem = {
        id,
        content,
        status,
        priority,
        createdAt: now,
        updatedAt: now,
      }
      const notes = coerceNotes(input.notes)
      if (notes) item.notes = notes
      todos.push(item)
      return { state: { version: 1, todos }, summary: `Added "${content}" (${status}, ${priority})` }
    }

    case "update": {
      // Refuse an out-of-vocabulary status/priority up front: a typo must be an
      // error, not a silent no-op that reports "nothing to change".
      if (input.status !== undefined && !isStatus(input.status)) {
        return { state, summary: "update: status must be one of pending, in_progress, completed, cancelled" }
      }
      if (input.priority !== undefined && !isPriority(input.priority)) {
        return { state, summary: "update: priority must be one of high, medium, low" }
      }
      const found = findTodo(todos, input.id)
      if (found.index < 0) return { state, summary: `update: ${found.error}` }
      const todo = todos[found.index]
      let changed = false
      if (input.content !== undefined) {
        if (typeof input.content !== "string") return { state, summary: "update: content must be a string" }
        const content = input.content.trim()
        if (!content) return { state, summary: "update: content must not be blank" }
        if (content !== todo.content) {
          todo.content = content
          changed = true
        }
      }
      if (input.status !== undefined && isStatus(input.status) && input.status !== todo.status) {
        todo.status = input.status
        changed = true
      }
      if (input.priority !== undefined && isPriority(input.priority) && input.priority !== todo.priority) {
        todo.priority = input.priority
        changed = true
      }
      if (Array.isArray(input.notes)) {
        const next = coerceNotes(input.notes)
        if (!sameNotes(next, todo.notes)) {
          if (next) todo.notes = next
          else delete todo.notes
          changed = true
        }
      }
      if (!changed) return { state, summary: `update: nothing to change for "${todo.content}"` }
      todo.updatedAt = now
      return { state: { version: 1, todos }, summary: `Updated "${todo.content}" -> ${todo.status}` }
    }

    case "complete": {
      const found = findTodo(todos, input.id)
      if (found.index < 0) return { state, summary: `complete: ${found.error}` }
      const todo = todos[found.index]
      if (todo.status === "completed") return { state, summary: `"${todo.content}" is already completed` }
      todo.status = "completed"
      todo.updatedAt = now
      return { state: { version: 1, todos }, summary: `Completed "${todo.content}"` }
    }

    // Reorder one item. EXACTLY one of before/after/position; before/after take a
    // target id (resolved the same defensively way as every other action).
    case "move": {
      const found = findTodo(todos, input.id)
      if (found.index < 0) return { state, summary: `move: ${found.error}` }

      // Enforce exactly one selector BEFORE any mutation, so a malformed call can
      // never half-apply. `before`/`after` count when defined; `position` counts
      // when it is a finite number.
      const selectors =
        (input.before !== undefined ? 1 : 0) +
        (input.after !== undefined ? 1 : 0) +
        (typeof input.position === "number" && Number.isFinite(input.position) ? 1 : 0)
      if (selectors === 0) return { state, summary: "move: give before, after, or position" }
      if (selectors > 1) return { state, summary: "move: give exactly one of before, after, or position" }

      const from = found.index
      const [item] = todos.splice(from, 1)

      let target: number
      if (input.before !== undefined) {
        const anchor = findTodo(todos, input.before)
        if (anchor.index < 0) return { state, summary: `move: before ${anchor.error}` }
        target = anchor.index
      } else if (input.after !== undefined) {
        const anchor = findTodo(todos, input.after)
        if (anchor.index < 0) return { state, summary: `move: after ${anchor.error}` }
        target = anchor.index + 1
      } else {
        target = Math.trunc(input.position as number)
      }

      // Clamp against the list the item was just removed from.
      target = Math.max(0, Math.min(target, todos.length))
      if (target === from) {
        // No-op: the item already sits at the target index. Never rewrite state.
        return { state, summary: `move: nothing to change for "${item.content}"` }
      }
      item.updatedAt = now
      todos.splice(target, 0, item)
      return { state: { version: 1, todos }, summary: `Moved "${item.content}" to position ${target}` }
    }

    default:
      return { state, summary: `Unknown action "${(input as { action: string }).action}"` }
  }
}

/**
 * The counts summary line: numbers then words, space-middot-space separators.
 * `cancelled` is a terminal state like `completed` and is counted in none of the
 * three buckets. Exported so the cross-session `todo.open` render shares it.
 */
export function countsLine(state: { todos: readonly { status: string }[] }): string {
  const count = (status: string) => state.todos.filter((todo) => todo.status === status).length
  return `${count("pending")} open · ${count("in_progress")} in progress · ${count("completed")} done`
}

/** One compact line per todo, the same text a caller reads back. */
export function format(state: TodoListState): string {
  if (state.todos.length === 0) return "No todos."
  const mark = (s: TodoItem["status"]) =>
    s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : s === "cancelled" ? "[-]" : "[ ]"
  const lines: string[] = []
  for (const todo of state.todos) {
    lines.push(`${mark(todo.status)} (${todo.id}) [${todo.priority}] ${todo.content}`)
    for (const note of todo.notes ?? []) lines.push(`  - ${note}`)
  }
  // The summary is always the final line, after any notes rows.
  lines.push(countsLine(state))
  return lines.join("\n")
}

/** One open todo across all sessions, tagged with the session that owns it. */
export interface OpenTodo {
  sessionID: string
  id: string
  content: string
  status: string
  priority: string
  updatedAt: number
}

/**
 * Roll up every NON-completed, NON-cancelled todo the plugin has stored, across
 * all sessions. Input is the scanned storage rows (`{ key, value }`) so this is
 * pure; the caller owns enumeration (paged via `ctx.storage.scan`). Rows that are
 * not session todo keys, and rows that fail `coerce`, are skipped — this is a
 * read, never a repair-write.
 */
export function aggregateOpen(entries: ReadonlyArray<{ key: string; value: unknown }>): { todos: OpenTodo[] } {
  const todos: OpenTodo[] = []
  for (const entry of entries) {
    if (typeof entry.key !== "string" || !entry.key.startsWith(OPEN_PREFIX)) continue
    const sessionID = entry.key.slice(OPEN_PREFIX.length)
    if (!sessionID) continue
    const state = coerce(entry.value)
    for (const todo of state.todos) {
      if (todo.status === "completed" || todo.status === "cancelled") continue
      todos.push({
        sessionID,
        id: todo.id,
        content: todo.content,
        status: todo.status,
        priority: todo.priority,
        updatedAt: todo.updatedAt,
      })
    }
  }
  // Deterministic order: priority high -> medium -> low, then updatedAt DESCENDING.
  // Decorate with the input index and break ties by it, so equal rows never
  // reorder (a stable sort without relying on the engine's stability).
  const ordered = todos
    .map((todo, index) => ({ todo, index }))
    .sort((a, b) => {
      const rank = priorityRank(a.todo.priority) - priorityRank(b.todo.priority)
      if (rank !== 0) return rank
      if (a.todo.updatedAt !== b.todo.updatedAt) return b.todo.updatedAt - a.todo.updatedAt
      return a.index - b.index
    })
    .map((entry) => entry.todo)
  return { todos: ordered }
}

/** Rank for ordering: high first, low last; anything unknown sits with medium. */
const priorityRank = (priority: string): number => (priority === "high" ? 0 : priority === "low" ? 2 : 1)

/** The `todo open` render: one line per open todo, then the counts summary last. */
export function formatOpen(todos: readonly OpenTodo[]): string {
  if (todos.length === 0) return `No open todos.\n${countsLine({ todos: [] })}`
  const lines = todos.map((todo) => `(${todo.sessionID}) [${todo.priority}] ${todo.content}`)
  lines.push(countsLine({ todos }))
  return lines.join("\n")
}

export default {
  id: "oc-todo",
  async setup(ctx: any) {
    // The context the tool closes over, narrowed to just what the store needs.
    const store = {
      get: (key: string) => ctx.storage.get(key),
      set: (key: string, value: unknown) => ctx.storage.set(key, value as never),
    }

    // Storage has no compare-and-swap, so read → mutate → write for one session
    // must not interleave. Concurrent tool calls are normal (and code-mode makes
    // them easy), so each session gets a serial queue.
    const queues = new Map<string, Promise<unknown>>()
    const serialize = <T>(sessionID: string, task: () => Promise<T>): Promise<T> => {
      const previous = queues.get(sessionID) ?? Promise.resolve()
      const next = previous.then(task, task)
      const tracked = next.catch(() => {})
      queues.set(sessionID, tracked)
      // A settled entry with no newer task chained is dead weight: every
      // distinct sessionID would otherwise leak one entry for the process
      // lifetime. Delete only when this task is still the tail, so a newer
      // chained task is never unlinked.
      tracked.then(() => {
        if (queues.get(sessionID) === tracked) queues.delete(sessionID)
      })
      return next
    }

    const registration = await ctx.rpc.register(Todo, {
      // The TUI's read path: real stored state. A backend ERROR (not corrupt
      // data, which `coerce` already repairs) degrades to an empty list rather
      // than failing the read. Writes never catch: a failed read inside a
      // mutation must fail, not silently overwrite storage from empty state.
      async list(input: { sessionID: string }) {
        const { sessionID } = input
        try {
          const state = await readState(store, sessionID)
          return { todos: state.todos }
        } catch {
          return { todos: [] }
        }
      },
      // Cross-session roll-up. Enumerates every stored session row via the host
      // storage scan, paged by `next`, then aggregates purely.
      async open() {
        try {
          return aggregateOpen(await scanSessionRows(ctx.storage))
        } catch {
          return { todos: [] }
        }
      },
    })

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "todo",
        description: TODO_TOOL_DESCRIPTION,
        input: todoToolSchema(),
        options: { codemode: false },
        async execute(input: any, context: any) {
          const request = input as {
            action: "list" | "open" | "add" | "update" | "complete" | "move" | "clear" | "write"
            id?: string
            content?: string
            status?: string
            priority?: string
            notes?: string[]
            before?: string
            after?: string
            position?: number
            todos?: ReadonlyArray<{
              id?: string
              content?: string
              status?: string
              priority?: string
              notes?: string[]
            }>
          }
          // Session scope comes from the tool call context, not from the caller.
          const sessionID = String(context.sessionID)

          if (request.action === "list") {
            try {
              const state = await readState(store, sessionID)
              return { content: `${format(state)}\n${state.todos.length} todo(s) for session ${sessionID}.` }
            } catch {
              const degraded = emptyState()
              return { content: `${format(degraded)}\n${degraded.todos.length} todo(s) for session ${sessionID}.` }
            }
          }

          if (request.action === "open") {
            try {
              const { todos } = aggregateOpen(await scanSessionRows(ctx.storage))
              return { content: formatOpen(todos) }
            } catch {
              return { content: formatOpen([]) }
            }
          }

          const { state, summary } = await serialize(sessionID, async () => {
            const current = await readState(store, sessionID)
            // `list` and `open` returned above; the rest are mutations.
            const outcome = applyMutation(current, request as Parameters<typeof applyMutation>[1])
            // A no-op must not rewrite storage or fire a change event.
            if (JSON.stringify(outcome.state) !== JSON.stringify(current)) {
              await writeState(store, sessionID, outcome.state)
              await registration.events.emit("changed", { sessionID })
            }
            return outcome
          })
          return {
            content: `${summary}\n\n${format(state)}\n${state.todos.length} todo(s) for session ${sessionID}.`,
          }
        },
      })
    })

    return async () => {
      queues.clear()
      await registration.dispose()
    }
  },
}
