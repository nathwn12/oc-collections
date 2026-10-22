import { describe, expect, test } from "bun:test"
import plugin, {
  aggregateOpen,
  applyMutation,
  coerce,
  findTodo,
  format,
  formatOpen,
  scanSessionRows,
  TODO_TOOL_DESCRIPTION,
  todoToolSchema,
} from "../index.js"
import { Todo } from "../contract.js"
import { CONTENT_WIDTH, refreshedRows, sidebarLines } from "../tui.js"
import {
  clampIndex,
  detailColumnWidth,
  formatStamp,
  inspectorFooter,
  listColumnWidth,
  listRows,
  metadataLines,
  moveSelection,
  proseLines,
  resolveSelection,
  SELECT_MARK,
  wrapText,
} from "../tui.js"
import Ajv from "ajv"

const empty = { version: 1 as const, todos: [] as any[] }

describe("applyMutation", () => {
  test("add appends a pending/medium item and reports a summary", () => {
    const { state, summary } = applyMutation(empty, { action: "add", content: "write docs" })
    expect(state.todos).toHaveLength(1)
    expect(state.todos[0]).toMatchObject({ content: "write docs", status: "pending", priority: "medium" })
    expect(summary).toContain("write docs")
  })

  test("add honours valid status and priority", () => {
    const { state } = applyMutation(empty, {
      action: "add",
      content: "ship it",
      status: "in_progress",
      priority: "high",
    })
    expect(state.todos[0]).toMatchObject({ status: "in_progress", priority: "high" })
  })

  test("add rejects blank content", () => {
    const { state, summary } = applyMutation(empty, { action: "add", content: "   " })
    expect(state.todos).toHaveLength(0)
    expect(summary).toContain("requires content")
  })

  test("update changes status/priority by exact id", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const id = added.todos[0].id
    const next = applyMutation(added, { action: "update", id, status: "cancelled", priority: "low" }).state
    expect(next.todos[0]).toMatchObject({ status: "cancelled", priority: "low" })
  })

  test("update accepts an unambiguous id prefix", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const id = added.todos[0].id
    const next = applyMutation(added, { action: "update", id: id.slice(0, 4), status: "completed" }).state
    expect(next.todos[0].status).toBe("completed")
  })

  test("update with an unknown id leaves the list unchanged", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const next = applyMutation(added, { action: "update", id: "nope", status: "completed" }).state
    expect(next.todos).toEqual(added.todos)
  })

  test("complete marks the item completed", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const next = applyMutation(added, { action: "complete", id: added.todos[0].id }).state
    expect(next.todos[0].status).toBe("completed")
  })

  test("clear empties the list", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const { state, summary } = applyMutation(added, { action: "clear" })
    expect(state.todos).toHaveLength(0)
    expect(summary).toContain("Cleared 1")
  })

  test("write replaces the whole list (V1 todowrite parity)", () => {
    const first = applyMutation(empty, { action: "add", content: "old" }).state
    const { state, summary } = applyMutation(first, {
      action: "write",
      todos: [
        { content: "one", status: "in_progress", priority: "high" },
        { content: "two" },
      ],
    })
    expect(state.todos.map((t) => t.content)).toEqual(["one", "two"])
    expect(state.todos[0]).toMatchObject({ status: "in_progress", priority: "high" })
    expect(state.todos[1]).toMatchObject({ status: "pending", priority: "medium" })
    expect(summary).toContain("Wrote 2")
  })

  test("write keeps an existing item's id and createdAt", () => {
    const added = applyMutation(empty, { action: "add", content: "keep me" }).state
    const existing = added.todos[0]
    const { state } = applyMutation(added, {
      action: "write",
      todos: [{ id: existing.id, content: "keep me", status: "completed" }],
    })
    expect(state.todos[0].id).toBe(existing.id)
    expect(state.todos[0].createdAt).toBe(existing.createdAt)
    expect(state.todos[0].status).toBe("completed")
  })

  test("write drops blank entries and defaults unknown status/priority", () => {
    const { state } = applyMutation(empty, {
      action: "write",
      todos: [{ content: "  " }, { content: "ok", status: "bogus", priority: "bogus" }],
    })
    expect(state.todos).toHaveLength(1)
    expect(state.todos[0]).toMatchObject({ content: "ok", status: "pending", priority: "medium" })
  })

  test("write with an empty array clears the list", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const { state } = applyMutation(added, { action: "write", todos: [] })
    expect(state.todos).toHaveLength(0)
  })

  test("write without todos is refused and changes nothing", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const { state, summary } = applyMutation(added, { action: "write" } as any)
    expect(state.todos).toEqual(added.todos)
    expect(summary).toBe("write requires todos")
  })
})

describe("format", () => {
  test("empty state", () => {
    expect(format({ version: 1, todos: [] })).toBe("No todos.")
  })

  test("renders a mark, id, priority and content per item", () => {
    const state = {
      version: 1 as const,
      todos: [
        { id: "z1", content: "done", status: "completed", priority: "low", createdAt: 0, updatedAt: 0 },
      ] as any[],
    }
    expect(format(state).split("\n")[0]).toBe("[x] (z1) [low] done")
  })

  test("each status has a distinct mark", () => {
    const mk = (status: string) => ({ id: "i", content: "c", status, priority: "medium", createdAt: 0, updatedAt: 0 })
    const state = { version: 1 as const, todos: ["pending", "in_progress", "completed", "cancelled"].map(mk) as any[] }
    const lines = format(state).split("\n")
    expect(lines.slice(0, 4).map((l) => l.slice(0, 3))).toEqual(["[ ]", "[~]", "[x]", "[-]"])
  })
})

// #4 Counts summary line.
describe("counts summary (#4)", () => {
  const mk = (id: string, status: string) => ({ id, content: id, status, priority: "medium", createdAt: 0, updatedAt: 0 })

  test("empty list keeps exactly No todos.", () => {
    expect(format({ version: 1, todos: [] })).toBe("No todos.")
  })

  test("the summary is the final line, numbers then words", () => {
    const state = {
      version: 1 as const,
      todos: [mk("a", "pending"), mk("b", "pending"), mk("c", "in_progress"), mk("d", "completed")] as any[],
    }
    const lines = format(state).split("\n")
    expect(lines[lines.length - 1]).toBe("2 open · 1 in progress · 1 done")
  })

  test("cancelled is excluded from all three counts", () => {
    const state = {
      version: 1 as const,
      todos: [mk("a", "cancelled"), mk("b", "cancelled"), mk("c", "pending")] as any[],
    }
    expect(format(state).split("\n").pop()).toBe("1 open · 0 in progress · 0 done")
  })

  test("all-zero counts still render when the list is non-empty", () => {
    const state = { version: 1 as const, todos: [mk("a", "cancelled")] as any[] }
    expect(format(state).split("\n").pop()).toBe("0 open · 0 in progress · 0 done")
  })
})

describe("id resolution", () => {
  const withIds = (ids: string[]) =>
    ({ version: 1 as const, todos: ids.map((id) => ({ id, content: id, status: "pending", priority: "medium", createdAt: 0, updatedAt: 0 })) as any[] })

  test("an ambiguous prefix is refused, never a silent pick", () => {
    const state = withIds(["abc1", "abc2"])
    const { state: next, summary } = applyMutation(state, { action: "update", id: "abc", status: "completed" })
    expect(summary).toContain("ambiguous")
    expect(next.todos.map((t) => t.status)).toEqual(["pending", "pending"])
  })

  test("an exact id wins over a prefix match", () => {
    // "abcd" starts with "abc", but an item literally named "abc" must win.
    const state = withIds(["abcd", "abc"])
    const { state: next } = applyMutation(state, { action: "complete", id: "abc" })
    expect(next.todos[0].status).toBe("pending")
    expect(next.todos[1].status).toBe("completed")
  })

  test("a unique prefix still works", () => {
    const state = withIds(["zzz9"])
    const { state: next } = applyMutation(state, { action: "complete", id: "zzz" })
    expect(next.todos[0].status).toBe("completed")
  })

  test("findTodo reports the reason it failed", () => {
    const state = withIds(["abc1"])
    expect(findTodo(state.todos, undefined).error).toBe("no id given")
    expect(findTodo(state.todos, "nope").error).toContain("no todo matching")
  })
})

// #3 Notes on an item.
describe("notes (#3)", () => {
  test("add stores coerced notes", () => {
    const { state } = applyMutation(empty, {
      action: "add",
      content: "a",
      notes: ["  step one  ", "", "step two", 5 as any, "   "],
    })
    expect(state.todos[0].notes).toEqual(["step one", "step two"])
  })

  test("add with no usable notes omits the field", () => {
    const omitted = applyMutation(empty, { action: "add", content: "a" }).state
    const emptyish = applyMutation(empty, { action: "add", content: "b", notes: ["  ", ""] }).state
    expect(omitted.todos[0]).not.toHaveProperty("notes")
    expect(emptyish.todos[0]).not.toHaveProperty("notes")
  })

  test("a non-array notes on add is ignored, not a throw", () => {
    const { state } = applyMutation(empty, { action: "add", content: "a", notes: "nope" as any })
    expect(state.todos[0]).not.toHaveProperty("notes")
  })

  test("a non-array notes on update is ignored, not a delete", () => {
    const added = applyMutation(empty, { action: "add", content: "a", notes: ["keep"] }).state
    const before = added.todos[0].updatedAt
    const { state, summary } = applyMutation(added, { action: "update", id: added.todos[0].id, notes: "nope" as any })
    expect(state.todos[0].notes).toEqual(["keep"])
    expect(summary).toContain("nothing to change")
    expect(state.todos[0].updatedAt).toBe(before)
  })

  test("update replaces the notes array", () => {
    const added = applyMutation(empty, { action: "add", content: "a", notes: ["old"] }).state
    const next = applyMutation(added, { action: "update", id: added.todos[0].id, notes: ["new", "more"] }).state
    expect(next.todos[0].notes).toEqual(["new", "more"])
  })

  test("update with an empty array clears the field", () => {
    const added = applyMutation(empty, { action: "add", content: "a", notes: ["old"] }).state
    const next = applyMutation(added, { action: "update", id: added.todos[0].id, notes: [] }).state
    expect(next.todos[0]).not.toHaveProperty("notes")
  })

  test("update re-supplying the same notes is a no-op", () => {
    const added = applyMutation(empty, { action: "add", content: "a", notes: ["x"] }).state
    const before = added.todos[0].updatedAt
    const { state, summary } = applyMutation(added, { action: "update", id: added.todos[0].id, notes: ["x"] })
    expect(summary).toContain("nothing to change")
    expect(state.todos[0].updatedAt).toBe(before)
    expect(state.todos[0].notes).toEqual(["x"])
  })

  test("write carries notes through", () => {
    const { state } = applyMutation(empty, {
      action: "write",
      todos: [{ content: "one", notes: ["n1"] }, { content: "two" }],
    })
    expect(state.todos[0].notes).toEqual(["n1"])
    expect(state.todos[1]).not.toHaveProperty("notes")
  })

  test("coerce repairs a malformed stored notes array", () => {
    const state = coerce({
      version: 1,
      todos: [
        { id: "a", notes: ["ok", "", 5, "  pad  "] },
        { id: "b", notes: "not an array" },
        { id: "c", notes: [{}] },
      ],
    })
    expect(state.todos[0].notes).toEqual(["ok", "pad"])
    expect(state.todos[1]).not.toHaveProperty("notes")
    expect(state.todos[2]).not.toHaveProperty("notes")
  })

  test("format indents notes under the item line and keeps the summary last", () => {
    const added = applyMutation(empty, { action: "add", content: "with notes", notes: ["one", "two"] }).state
    const lines = format(added).split("\n")
    expect(lines[0]).toContain("with notes")
    expect(lines[1]).toBe("  - one")
    expect(lines[2]).toBe("  - two")
    expect(lines[lines.length - 1]).toBe("1 open · 0 in progress · 0 done")
  })

  test("coerce repairs non-finite timestamps so they never serialize to null", () => {
    const state = coerce({
      version: 1,
      todos: [
        { id: "a", createdAt: NaN, updatedAt: Infinity },
        { id: "b", createdAt: -Infinity, updatedAt: NaN },
      ],
    })
    for (const todo of state.todos) {
      expect(Number.isFinite(todo.createdAt)).toBe(true)
      expect(Number.isFinite(todo.updatedAt)).toBe(true)
    }
    // The contract declares both as numbers; JSON must never emit null here.
    const row = JSON.parse(JSON.stringify(state.todos[0]))
    expect(typeof row.createdAt).toBe("number")
    expect(typeof row.updatedAt).toBe("number")
  })
})

// #2 Move / reorder.
describe("move (#2)", () => {
  const three = applyMutation(empty, { action: "write", todos: [{ content: "a" }, { content: "b" }, { content: "c" }] }).state
  const ids = () => three.todos.map((t) => t.id)

  test("move by position reorders and bumps updatedAt", () => {
    const last = three.todos[2].id
    const before = three.todos[2].updatedAt
    // Pin the clock and advance it, so the moved item's own `updatedAt` is
    // strictly greater than its prior value regardless of how fast the test
    // runs — a same-millisecond move must still register the bump.
    const realNow = Date.now
    Date.now = () => before + 1000
    try {
      const { state, summary } = applyMutation(three, { action: "move", id: last, position: 0 })
      expect(state.todos.map((t) => t.content)).toEqual(["c", "a", "b"])
      expect(summary).toContain("Moved")
      expect(summary).toContain("position 0")
      // The MOVED item's own updatedAt must strictly increase — comparing against a
      // different item created at the same `now` would pass even if the bump were
      // removed (the bug this replaces).
      expect(state.todos[0].updatedAt).toBeGreaterThan(before)
    } finally {
      Date.now = realNow
    }
  })

  test("move by before inserts ahead of the target", () => {
    const [a, , c] = ids()
    const { state } = applyMutation(three, { action: "move", id: c, before: a })
    expect(state.todos.map((t) => t.content)).toEqual(["c", "a", "b"])
  })

  test("move by after inserts behind the target", () => {
    const [a, , c] = ids()
    const { state } = applyMutation(three, { action: "move", id: a, after: c })
    expect(state.todos.map((t) => t.content)).toEqual(["b", "c", "a"])
  })

  test("an out-of-range position is clamped after removal", () => {
    const low = applyMutation(three, { action: "move", id: ids()[0], position: 99 })
    const high = applyMutation(three, { action: "move", id: ids()[2], position: -5 })
    expect(low.state.todos.map((t) => t.content)).toEqual(["b", "c", "a"])
    expect(high.state.todos.map((t) => t.content)).toEqual(["c", "a", "b"])
  })

  test("a no-op move reports nothing to change and keeps updatedAt", () => {
    const before = three.todos[1].updatedAt
    const { state, summary } = applyMutation(three, { action: "move", id: ids()[1], position: 1 })
    expect(summary).toContain("nothing to change")
    expect(state.todos[1].updatedAt).toBe(before)
  })

  test("no selector is an explicit error", () => {
    const { state, summary } = applyMutation(three, { action: "move", id: ids()[0] })
    expect(summary).toBe("move: give before, after, or position")
    expect(state.todos.map((t) => t.content)).toEqual(["a", "b", "c"])
  })

  test("two selectors are refused and change nothing (before + after)", () => {
    const [a, b, c] = ids()
    const { state, summary } = applyMutation(three, { action: "move", id: c, before: a, after: b })
    expect(summary).toBe("move: give exactly one of before, after, or position")
    expect(state.todos.map((t) => t.content)).toEqual(["a", "b", "c"])
  })

  test("two selectors are refused and change nothing (before + position)", () => {
    const [a, , c] = ids()
    const { state, summary } = applyMutation(three, { action: "move", id: c, before: a, position: 2 })
    expect(summary).toBe("move: give exactly one of before, after, or position")
    expect(state.todos.map((t) => t.content)).toEqual(["a", "b", "c"])
  })

  test("an unknown target id names the failure and changes nothing", () => {
    const { state, summary } = applyMutation(three, { action: "move", id: ids()[0], before: "nope" })
    expect(summary).toContain("nope")
    expect(state.todos.map((t) => t.content)).toEqual(["a", "b", "c"])
  })

  test("an unknown move id itself changes nothing", () => {    const { state, summary } = applyMutation(three, { action: "move", id: "nope", position: 0 })
    expect(summary).toContain("move:")
    expect(state.todos.map((t) => t.content)).toEqual(["a", "b", "c"])
  })

  test("an ambiguous target id is refused", () => {
    const state = applyMutation(empty, { action: "write", todos: [{ id: "abc1", content: "a" }, { id: "abc2", content: "b" }, { id: "z", content: "c" }] }).state
    const { state: next, summary } = applyMutation(state, { action: "move", id: "z", before: "abc" })
    expect(summary).toContain("ambiguous")
    expect(next.todos.map((t) => t.content)).toEqual(["a", "b", "c"])
  })
})

// #L-a The move selector rule must be scoped to action 'move'. The schema guard
// is validated directly against the exported schema, so a non-move call carrying
// stray selector keys is proven to pass (it used to be rejected by the global
// oneOf), while a valid move and a two-selector move are proven to pass/refuse.
describe("tool schema move-selector scope", () => {
  const validate = (() => {
    const ajv = new Ajv({ allErrors: true })
    return ajv.compile(todoToolSchema() as object)
  })()

  test("schema compiles and accepts a valid move with exactly one selector", () => {
    expect(validate({ action: "move", id: "x", after: "y" })).toBe(true)
  })

  test("schema refuses a move with two selectors", () => {
    expect(validate({ action: "move", id: "x", before: "y", after: "z" })).toBe(false)
  })

  test("schema accepts a non-move action carrying two selector keys", () => {
    // 'add' never reads before/after/position; the guard must not touch it.
    expect(validate({ action: "add", content: "hi", before: "a", after: "b" })).toBe(true)
  })

  test("schema still enforces additionalProperties and required action", () => {
    expect(validate({ action: "add", content: "hi", nope: 1 })).toBe(false)
    expect(validate({ content: "hi" })).toBe(false)
  })

  test("schema requires todos for a write action", () => {
    expect(validate({ action: "write" })).toBe(false)
    expect(validate({ action: "write", todos: [] })).toBe(true)
  })
})

describe("input hardening", () => {
  test("add with a non-string content does not throw", () => {
    const { state, summary } = applyMutation(empty, { action: "add", content: 5 as any })
    expect(state.todos).toHaveLength(0)
    expect(summary).toContain("requires content")
  })

  test("update with a non-string content is refused", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const { state, summary } = applyMutation(added, { action: "update", id: added.todos[0].id, content: 5 as any })
    expect(summary).toContain("must be a string")
    expect(state.todos[0].content).toBe("a")
  })

  test("update with nothing to change does not bump updatedAt", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const before = added.todos[0].updatedAt
    const { state, summary } = applyMutation(added, { action: "update", id: added.todos[0].id })
    expect(summary).toContain("nothing to change")
    expect(state.todos[0].updatedAt).toBe(before)
  })

  test("update that re-supplies the same status is a no-op", () => {
    const added = applyMutation(empty, { action: "add", content: "a", status: "pending" }).state
    const before = added.todos[0].updatedAt
    const { state, summary } = applyMutation(added, {
      action: "update",
      id: added.todos[0].id,
      status: "pending",
    })
    expect(summary).toContain("nothing to change")
    expect(state.todos[0].updatedAt).toBe(before)
  })

  test("update that re-supplies the same priority is a no-op", () => {
    const added = applyMutation(empty, { action: "add", content: "a", priority: "medium" }).state
    const before = added.todos[0].updatedAt
    const { summary, state } = applyMutation(added, {
      action: "update",
      id: added.todos[0].id,
      priority: "medium",
    })
    expect(summary).toContain("nothing to change")
    expect(state.todos[0].updatedAt).toBe(before)
  })

  test("update that re-supplies the same content is a no-op", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const before = added.todos[0].updatedAt
    const { summary, state } = applyMutation(added, {
      action: "update",
      id: added.todos[0].id,
      content: "a",
    })
    expect(summary).toContain("nothing to change")
    expect(state.todos[0].updatedAt).toBe(before)
  })

  test("update still reports a change when one field genuinely differs", () => {
    const added = applyMutation(empty, { action: "add", content: "a", status: "pending", priority: "medium" }).state
    const { summary, state } = applyMutation(added, {
      action: "update",
      id: added.todos[0].id,
      status: "pending",
      priority: "high",
    })
    expect(summary).toContain("Updated")
    expect(state.todos[0].priority).toBe("high")
    expect(state.todos[0].status).toBe("pending")
  })

  test("update refuses an out-of-vocabulary status and changes nothing", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const before = added.todos[0].updatedAt
    const { state, summary } = applyMutation(added, {
      action: "update",
      id: added.todos[0].id,
      status: "in-progress",
    })
    expect(summary).toBe("update: status must be one of pending, in_progress, completed, cancelled")
    expect(state.todos).toEqual(added.todos)
    expect(state.todos[0].updatedAt).toBe(before)
  })

  test("update refuses an out-of-vocabulary priority and changes nothing", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const before = added.todos[0].updatedAt
    const { state, summary } = applyMutation(added, {
      action: "update",
      id: added.todos[0].id,
      priority: "urgent",
    })
    expect(summary).toBe("update: priority must be one of high, medium, low")
    expect(state.todos).toEqual(added.todos)
    expect(state.todos[0].updatedAt).toBe(before)
  })

  test("update with a valid status and priority still applies", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const { state, summary } = applyMutation(added, {
      action: "update",
      id: added.todos[0].id,
      status: "in_progress",
      priority: "high",
    })
    expect(state.todos[0]).toMatchObject({ status: "in_progress", priority: "high" })
    expect(summary).toContain("Updated")
  })

  test("write re-checks a regenerated id against both used and previous", () => {
    // Pin `now` so the regenerated id is predictable, then plant a colliding id
    // in `previous` so a single regeneration (the old behaviour) would still
    // collide and silently overwrite identity.
    const realNow = Date.now
    Date.now = () => 1_000_000
    try {
      const now36 = (1_000_000).toString(36)
      // Previous list already owns the id the regeneration would pick for entry 1.
      const previous = {
        version: 1 as const,
        todos: [
          { id: `${now36}21`, content: "old", status: "pending", priority: "medium", createdAt: 0, updatedAt: 0 },
        ] as any[],
      }
      const { state } = applyMutation(previous, {
        action: "write",
        todos: [
          { id: "dup", content: "one" },
          { id: "dup", content: "two" },
        ],
      })
      expect(state.todos).toHaveLength(2)
      expect(new Set(state.todos.map((t) => t.id)).size).toBe(2)
      // The second item must not have stolen the id age of the previous row.
      expect(state.todos[1].createdAt).toBe(1_000_000)
    } finally {
      Date.now = realNow
    }
  })

  test("write de-duplicates a repeated id", () => {
    const { state } = applyMutation(empty, {
      action: "write",
      todos: [
        { id: "dup", content: "one" },
        { id: "dup", content: "two" },
      ],
    })
    expect(state.todos).toHaveLength(2)
    expect(new Set(state.todos.map((t) => t.id)).size).toBe(2)
  })

  test("write skips non-object entries", () => {
    const { state } = applyMutation(empty, { action: "write", todos: [null as any, { content: "ok" }] })
    expect(state.todos.map((t) => t.content)).toEqual(["ok"])
  })

  test("write with a non-array todos is refused and changes nothing", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    for (const todos of [null, "nope"]) {
      let outcome: ReturnType<typeof applyMutation> | undefined
      expect(() => {
        outcome = applyMutation(added, { action: "write", todos } as any)
      }).not.toThrow()
      expect(outcome!.state.todos).toEqual(added.todos)
      expect(outcome!.summary).toBe("write requires todos")
    }
  })
})

describe("coerce", () => {
  test("repairs malformed stored rows instead of rejecting the list", () => {
    const state = coerce({
      version: 1,
      todos: [
        { id: "a", content: 5, status: "bogus", priority: null },
        { id: "b" },
        { content: "no id" },
        "junk",
      ],
    })
    expect(state.todos.map((t) => t.id)).toEqual(["a", "b"])
    expect(state.todos[0]).toMatchObject({ content: "", status: "pending", priority: "medium" })
    expect(state.todos[1]).toMatchObject({ content: "", status: "pending", priority: "medium" })
  })

  test("non-object input is an empty list", () => {
    expect(coerce(undefined).todos).toEqual([])
    expect(coerce("nope").todos).toEqual([])
  })
})

describe("cross-session open (#1)", () => {
  const row = (sessionID: string, todos: any[]) => ({ key: `todos/session/${sessionID}`, value: { version: 1, todos } })
  const t = (id: string, status: string) => ({ id, content: id, status, priority: "high", createdAt: 1, updatedAt: 7 })

  test("aggregates unfinished todos across sessions, tagged by sessionID", () => {
    const result = aggregateOpen([
      row("s1", [t("a", "pending"), t("b", "completed")]),
      row("s2", [t("c", "in_progress"), t("d", "cancelled")]),
    ])
    expect(result.todos.map((x) => x.id)).toEqual(["a", "c"])
    expect(result.todos.map((x) => x.sessionID)).toEqual(["s1", "s2"])
  })

  test("orders by priority (high -> medium -> low) then updatedAt descending", () => {
    const mk = (id: string, priority: string, updatedAt: number) => ({
      id,
      content: id,
      status: "pending",
      priority,
      createdAt: 1,
      updatedAt,
    })
    const rows = [
      row("s1", [mk("a", "low", 100), mk("b", "high", 5), mk("c", "medium", 50)]),
      row("s2", [mk("d", "high", 9), mk("e", "medium", 70)]),
    ]
    expect(aggregateOpen(rows).todos.map((x) => x.id)).toEqual(["d", "b", "e", "c", "a"])
    // Total order (every row distinct), so shuffling the input rows must not
    // change the rendered result.
    const shuffled = [
      row("s2", [mk("e", "medium", 70), mk("d", "high", 9)]),
      row("s1", [mk("c", "medium", 50), mk("a", "low", 100), mk("b", "high", 5)]),
    ]
    expect(JSON.stringify(aggregateOpen(shuffled))).toBe(JSON.stringify(aggregateOpen(rows)))
  })

  test("excludes completed and cancelled, and keeps the contract keys", () => {
    const result = aggregateOpen([row("s1", [t("a", "completed"), t("b", "cancelled")])])
    expect(result.todos).toHaveLength(0)
    const open = aggregateOpen([row("s1", [t("c", "pending")])]).todos[0]
    expect(Object.keys(open).sort()).toEqual(["content", "id", "priority", "sessionID", "status", "updatedAt"])
  })

  test("ignores keys that are not session todo rows", () => {
    const result = aggregateOpen([
      { key: "todos/session/s1", value: { version: 1, todos: [t("a", "pending")] } },
      { key: "wellknown:sources", value: ["https://example.com"] },
      { key: "todos/session/broken", value: null },
    ])
    expect(result.todos.map((x) => x.id)).toEqual(["a"])
  })

  test("empty storage is an empty result", () => {
    expect(aggregateOpen([])).toEqual({ todos: [] })
  })

  test("formatOpen renders one line per open todo plus the summary last", () => {
    const { todos } = aggregateOpen([
      row("s1", [t("a", "pending"), t("b", "completed")]),
      row("s2", [t("c", "in_progress")]),
    ])
    const lines = formatOpen(todos).split("\n")
    expect(lines[0]).toBe("(s1) [high] a")
    expect(lines[1]).toBe("(s2) [high] c")
    expect(lines[lines.length - 1]).toBe("1 open · 1 in progress · 0 done")
  })

  test("formatOpen with no open todos still ends in a summary line", () => {
    const lines = formatOpen([]).split("\n")
    expect(lines[lines.length - 1]).toBe("0 open · 0 in progress · 0 done")
  })
})

describe("RPC contract", () => {
  test("the contract declares the methods and event the plugin uses", () => {
    expect(Todo.id).toBe("todo")
    expect(Object.keys(Todo.methods)).toEqual(["list", "open"])
    expect(Object.keys(Todo.events)).toEqual(["changed"])
  })

  test("a list output row carries exactly the contract's required keys plus optional notes", () => {
    const added = applyMutation(empty, { action: "add", content: "x" }).state
    const item = added.todos[0]
    const schema = (Todo.methods.list.output as any).properties.todos.items
    const required = schema.required as string[]
    const declared = Object.keys(schema.properties).filter((key) => !(required as string[]).includes(key))
    // Required keys are always present; optional keys may be omitted.
    for (const key of required) expect(item).toHaveProperty(key)
    for (const key of Object.keys(item)) expect(schema.properties).toHaveProperty(key)
    expect(declared.sort()).toEqual(["createdAt", "notes", "updatedAt"])
  })

  test("the open method output tags each row with sessionID", () => {
    const schema = (Todo.methods.open.output as any).properties.todos.items
    expect(schema.required.sort()).toEqual(["content", "id", "priority", "sessionID", "status", "updatedAt"])
  })
})

// PART B/C: the TUI-native sidebar renderer. Assertions are cell widths, never
// screenshots, so the pure `sidebarLines` renderer is pinned independently of
// any renderer that may not carry the theme.
describe("sidebarLines (TUI-native sidebar)", () => {
  const LABEL_WIDTH = 1
  const fixture = [
    { id: "1", content: "write docs", status: "pending", priority: "high" },
    { id: "2", content: "review pr", status: "in_progress", priority: "medium" },
    { id: "3", content: "ship it", status: "completed", priority: "low" },
    { id: "4", content: "scrap it", status: "cancelled", priority: "low" },
  ]
  const expanded = sidebarLines(fixture, { expanded: true })

  test("renders the header then one row per item, with exact cell widths", () => {
    expect(expanded.map((line) => line.text)).toEqual([
      "\u25BC todos 2/4",
      "\u25CB write docs",
      "\u25D0 review pr",
      "\u25CF ship it",
      "\u2297 scrap it",
    ])
    expect(expanded.map((line) => Bun.stringWidth(line.text))).toEqual([11, 12, 11, 9, 10])
  })

  test("every line is a label column plus a separator before the value", () => {
    for (const line of expanded) {
      const label = line.text.slice(0, LABEL_WIDTH)
      expect(Bun.stringWidth(label)).toBe(LABEL_WIDTH)
      expect(line.text[LABEL_WIDTH]).toBe(" ")
      // The value can never begin inside the label column.
      expect(line.text.slice(0, LABEL_WIDTH + 1)).toBe(`${label} `)
    }
  })

  test("no line carries a wide/fullwidth character and none is an emoji", () => {
    for (const line of expanded) {
      for (const char of line.text) {
        expect(Bun.stringWidth(char)).toBe(1)
        expect(/\p{Extended_Pictographic}/u.test(char)).toBe(false)
      }
    }
    // Positive control: the guard itself detects a real wide glyph and a real emoji.
    expect(Bun.stringWidth("\u4e2d")).toBe(2)
    expect(Bun.stringWidth("\u{1f600}")).toBe(2)
  })

  test("the four status marks are distinct single cells", () => {
    const marks = ["pending", "in_progress", "completed", "cancelled"].map(
      (status) => sidebarLines([{ id: "a", content: "c", status, priority: "low" }], { expanded: true })[1].text[0],
    )
    expect(marks).toEqual(["\u25CB", "\u25D0", "\u25CF", "\u2297"])
    expect(new Set(marks).size).toBe(4)
  })

  test("muted marks closed rows only", () => {
    expect(expanded.map((line) => line.muted)).toEqual([false, false, false, true, true])
  })

  test("a long content is clipped to the value budget", () => {
    const long = sidebarLines([{ id: "a", content: "x".repeat(100), status: "pending", priority: "low" }], {
      expanded: true,
    })[1].text
    expect(long.endsWith("\u2026")).toBe(true)
    expect(Bun.stringWidth(long.slice(LABEL_WIDTH + 1))).toBe(CONTENT_WIDTH)
    expect(Bun.stringWidth(long)).toBe(LABEL_WIDTH + 1 + CONTENT_WIDTH)
  })

  test("a clipped surrogate pair is never left orphaned", () => {
    // The cut lands between the pair's halves: 26 chars, then the high surrogate.
    const row = sidebarLines(
      [{ id: "a", content: `${"a".repeat(26)}\u{1f600}b`, status: "pending", priority: "low" }],
      { expanded: true },
    )[1].text
    expect(row).not.toContain("\ufffd")
    expect(row.endsWith("\u2026")).toBe(true)
  })

  test("notes render as a suffix in the value column", () => {
    const withNotes = (notes: string[]) =>
      sidebarLines([{ id: "a", content: "x", status: "pending", priority: "low", notes }], { expanded: true })[1].text
    expect(withNotes(["one", "two"])).toBe("\u25CB x (2 notes)")
    expect(withNotes(["one"])).toBe("\u25CB x (1 note)")
    expect(withNotes([])).toBe("\u25CB x")
  })

  test("the collapsed and expanded headers share identical column offsets", () => {
    const collapsed = sidebarLines(fixture, { expanded: false })
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].text).toBe("\u25B6 todos 2/4")
    // The toggle is the only difference; the value begins at the same column.
    expect(collapsed[0].text.slice(LABEL_WIDTH)).toBe(expanded[0].text.slice(LABEL_WIDTH))
    expect(collapsed[0].text[LABEL_WIDTH]).toBe(" ")
  })

  test("empty list renders a one-line muted hint, and a fully closed list auto-collapses without a checkmark", () => {
    const hint = sidebarLines([])
    expect(hint).toHaveLength(1)
    expect(hint[0].muted).toBe(true)
    expect(hint[0].text[0]).toBe(String.fromCharCode(0x25CB))
    const closedFixture = [
      { id: "1", content: "a", status: "completed", priority: "low" },
      { id: "2", content: "b", status: "cancelled", priority: "low" },
    ]
    const auto = sidebarLines(closedFixture)
    expect(auto).toHaveLength(1)
    expect(auto[0].text).toBe("\u25B6 todos 2/2")
  })
})

describe("direct-tool registration (codemode false)", () => {
  test("the todo tool registers with codemode: false so it is a direct tool", async () => {
    const added: any[] = []
    const fakeCtx = {
      storage: {
        get: async () => undefined,
        set: async () => {},
        scan: async () => ({ entries: [] }),
      },
      rpc: {
        register: async () => ({ events: { emit: async () => {} }, dispose: async () => {} }),
      },
      tool: {
        transform: async (fn: any) => {
          await fn({
            add: (tool: any) => added.push(tool),
            list: () => [],
            get: () => undefined,
            namespace: () => {},
            update: () => {},
            remove: () => {},
          })
        },
      },
    }
    const dispose = await (plugin as any).setup(fakeCtx)
    try {
      const todo = added.find((tool) => tool.name === "todo")
      expect(todo).toBeDefined()
      expect(todo.options?.codemode).toBe(false)
    } finally {
      await dispose()
    }
  })

  test("TODO_TOOL_DESCRIPTION begins with the when-clause and its first line fits the catalog limit", () => {
    expect(TODO_TOOL_DESCRIPTION.startsWith("Use for any multi-step task")).toBe(true)
    const firstLine = TODO_TOOL_DESCRIPTION.split("\n")[0] ?? ""
    expect(firstLine.length).toBeLessThanOrEqual(120)
  })

  test("the action schema tells the model to start with list or write", () => {
    const schema = todoToolSchema() as any
    expect(String(schema.properties.action.description)).toContain("list")
    expect(String(schema.properties.action.description)).toContain("write")
  })

  test("the empty-state hint is one lowercase single-cell line within the content budget", () => {
    const hint = sidebarLines([])
    expect(hint).toHaveLength(1)
    expect(hint[0].muted).toBe(true)
    expect(hint[0].text).toBe(hint[0].text.toLowerCase())
    expect(hint[0].text).not.toContain("\n")
    for (const char of hint[0].text) {
      expect(Bun.stringWidth(char)).toBe(1)
      expect(/\p{Extended_Pictographic}/u.test(char)).toBe(false)
    }
    expect(Bun.stringWidth(hint[0].text.slice(1 + 1))).toBeLessThanOrEqual(CONTENT_WIDTH)
  })
})

describe("defect fixes (recon round)", () => {
  test("a wide-character content clips to the cell budget, not the string length", () => {
    const wide = String.fromCharCode(0x4e2d).repeat(100)
    const row = sidebarLines([{ id: "a", content: wide, status: "pending", priority: "low" }], {
      expanded: true,
    })[1].text
    const ellipsis = String.fromCharCode(0x2026)
    expect(row.endsWith(ellipsis)).toBe(true)
    // 100 chars but 200 cells without width-aware clipping; it must fit.
    expect(wide.length).toBeGreaterThan(CONTENT_WIDTH)
    expect(Bun.stringWidth(row.slice(1 + 1))).toBeLessThanOrEqual(CONTENT_WIDTH)
  })

  test("a failed refresh holds the last good rows", () => {
    const prev = [
      { id: "a", content: "keep me", status: "pending", priority: "medium", createdAt: 1, updatedAt: 2 },
    ] as any[]
    expect(refreshedRows(prev, { ok: false })).toBe(prev)
    expect(refreshedRows(prev, { ok: true, todos: [] })).toEqual([])
    const fresh = [{ id: "b", content: "new", status: "pending", priority: "low", createdAt: 3, updatedAt: 4 }] as any[]
    expect(refreshedRows(prev, { ok: true, todos: fresh })).toBe(fresh)
  })

  test("coerce drops empty-string ids that findTodo could never address", () => {
    const state = coerce({
      version: 1,
      todos: [
        { id: "", content: "ghost" },
        { id: "ok", content: "real" },
      ],
    })
    expect(state.todos.map((t) => t.id)).toEqual(["ok"])
  })

  test("update refuses blank content and trims padding like add", () => {
    const added = applyMutation(empty, { action: "add", content: "a" }).state
    const blank = applyMutation(added, { action: "update", id: added.todos[0].id, content: "   " })
    expect(blank.summary).toContain("must not be blank")
    expect(blank.state.todos[0].content).toBe("a")
    const padded = applyMutation(added, { action: "update", id: added.todos[0].id, content: "  b  " })
    expect(padded.state.todos[0].content).toBe("b")
  })

  test("add never mints an id a planted row already owns", () => {
    const realNow = Date.now
    Date.now = () => 1_000_000
    try {
      const now36 = (1_000_000).toString(36)
      // Plant the exact id the next add would mint (timestamp plus length suffix).
      const planted = applyMutation(empty, {
        action: "write",
        todos: [{ content: "first" }, { id: `${now36}3`, content: "planted" }],
      }).state
      expect(planted.todos).toHaveLength(2)
      const { state } = applyMutation(planted, { action: "add", content: "new" })
      expect(state.todos).toHaveLength(3)
      expect(new Set(state.todos.map((t) => t.id)).size).toBe(3)
      // The planted row keeps its identity: an exact edit still hits it alone.
      const next = applyMutation(state, { action: "update", id: `${now36}3`, status: "completed" }).state
      expect(next.todos.filter((t) => t.status === "completed").map((t) => t.content)).toEqual(["planted"])
    } finally {
      Date.now = realNow
    }
  })

  test("scan continues past an empty page when next is present", async () => {
    const pages = [
      { entries: [], next: "k2" },
      { entries: [{ key: "todos/session/s1", value: { version: 1, todos: [] } }] },
    ]
    let calls = 0
    const storage = { scan: async () => pages[Math.min(calls++, pages.length - 1)] }
    const rows = await scanSessionRows(storage as any)
    expect(calls).toBe(2)
    expect(rows.map((row) => row.key)).toEqual(["todos/session/s1"])
  })

  test("scan still ends when next repeats", async () => {
    let calls = 0
    const storage = {
      scan: async ({ after }: { after?: string }) => {
        calls++
        return { entries: [], next: after ?? "k" }
      },
    }
    const rows = await scanSessionRows(storage as any)
    expect(rows).toEqual([])
    expect(calls).toBe(2)
  })
})

// v0.5.0: the detail-inspector panel. The layout, the selection math, and the
// wrapping are pure; the JSX is a thin shell, so everything asserted here is a
// string/size, never a screenshot.
describe("inspector panel (v0.5.0)", () => {
  const fixture = [
    { id: "1", content: "write docs", status: "pending", priority: "high" },
    { id: "2", content: "review pr", status: "in_progress", priority: "medium" },
    { id: "3", content: "ship it", status: "completed", priority: "low" },
    { id: "4", content: "scrap it", status: "cancelled", priority: "low" },
  ]

  describe("selection math", () => {
    test("clampIndex keeps an index in range and is 0 for an empty list", () => {
      expect(clampIndex(0, 4)).toBe(0)
      expect(clampIndex(3, 4)).toBe(3)
      expect(clampIndex(9, 4)).toBe(3)
      expect(clampIndex(-4, 4)).toBe(0)
      expect(clampIndex(1.9, 4)).toBe(1)
      expect(clampIndex(Number.NaN, 4)).toBe(0)
      expect(clampIndex(Number.POSITIVE_INFINITY, 4)).toBe(0)
      expect(clampIndex(2, 0)).toBe(0)
      expect(clampIndex(-1, 0)).toBe(0)
    })

    test("moveSelection steps and clamps, never wraps", () => {
      expect(moveSelection(0, 1, 4)).toBe(1)
      expect(moveSelection(3, 1, 4)).toBe(3)
      expect(moveSelection(0, -1, 4)).toBe(0)
      expect(moveSelection(1, -1, 4)).toBe(0)
      expect(moveSelection(0, 1, 0)).toBe(0)
    })
  })

  describe("column budgets", () => {
    test("split the panel width with a floor for narrow terminals", () => {
      expect(listColumnWidth(80)).toBe(23)
      expect(detailColumnWidth(80)).toBe(53)
      expect(listColumnWidth(0)).toBe(8)
      expect(detailColumnWidth(0)).toBe(8)
      expect(listColumnWidth(20)).toBe(8)
    })

    test("the two columns plus their padding fit an ordinary panel width", () => {
      for (const width of [20, 40, 80, 200]) {
        expect(listColumnWidth(width) + detailColumnWidth(width)).toBeLessThanOrEqual(width)
      }
    })
  })

  describe("listRows", () => {
    test("marks the selected row and leaves a blank gutter on the rest", () => {
      const rows = listRows(fixture, { selected: 1, width: 40 })
      expect(rows.map((row) => row.text)).toEqual([
        " \u25CB write docs",
        `${SELECT_MARK}\u25D0 review pr`,
        " \u25CF ship it",
        " \u2297 scrap it",
      ])
      expect(rows.map((row) => row.selected)).toEqual([false, true, false, false])
    })

    test("marks closed rows muted only", () => {
      expect(listRows(fixture, { selected: 0, width: 40 }).map((row) => row.muted)).toEqual([
        false,
        false,
        true,
        true,
      ])
    })

    test("clamps an out-of-range selection to the last row", () => {
      const rows = listRows(fixture, { selected: 99, width: 40 })
      expect(rows[rows.length - 1].selected).toBe(true)
      expect(rows.filter((row) => row.selected)).toHaveLength(1)
    })

    test("is empty for an empty list", () => {
      expect(listRows([], { selected: 0, width: 40 })).toEqual([])
    })

    test("clips a long value to the column and never wraps or overruns", () => {
      const rows = listRows([{ id: "a", content: "x".repeat(100), status: "pending", priority: "low" }], {
        selected: 0,
        width: 20,
      })
      expect(rows[0].text.endsWith("\u2026")).toBe(true)
      for (const row of rows) {
        expect(Bun.stringWidth(row.text)).toBeLessThanOrEqual(20)
        expect(row.text).not.toContain("\n")
        for (const char of row.text) expect(Bun.stringWidth(char)).toBe(1)
      }
    })

    test("carries the sidebar's notes suffix in the value", () => {
      const rows = listRows(
        [{ id: "a", content: "x", status: "pending", priority: "low", notes: ["n1", "n2"] }],
        { selected: 0, width: 40 },
      )
      expect(rows[0].text).toBe("\u25B8\u25CB x (2 notes)")
    })

    test("the selection mark is a single narrow cell", () => {
      expect(Bun.stringWidth(SELECT_MARK)).toBe(1)
      expect(/\p{Extended_Pictographic}/u.test(SELECT_MARK)).toBe(false)
    })
  })

  describe("metadataLines", () => {
    const meta = (label: string, value: string) => `${label.padEnd(8)} ${value}`
    const todo = {
      id: "abc",
      content: "c",
      status: "pending",
      priority: "high",
      notes: ["one", "two"],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_005_000,
    }

    test("renders a fixed label column with one row per field", () => {
      expect(metadataLines(todo, { width: 60 })).toEqual([
        meta("id", "abc"),
        meta("status", "pending"),
        meta("priority", "high"),
        meta("created", "2023-11-14 22:13:20Z"),
        meta("updated", "2023-11-14 22:13:25Z"),
        meta("notes", "2 notes"),
      ])
    })

    test("every value starts one column past the label column", () => {
      for (const line of metadataLines(todo, { width: 60 })) {
        expect(line[8]).toBe(" ")
        expect(line[9]).not.toBe(" ")
      }
    })

    test("counts notes, or says none", () => {
      const bare = { ...todo, notes: undefined }
      expect(metadataLines(bare, { width: 60 })[5]).toBe(meta("notes", "none"))
      expect(metadataLines({ ...todo, notes: ["x"] }, { width: 60 })[5]).toBe(meta("notes", "1 note"))
    })

    test("an absent or non-finite timestamp reads unknown", () => {
      expect(metadataLines({ ...todo, createdAt: 0, updatedAt: Number.NaN }, { width: 60 })[3]).toBe(
        meta("created", "unknown"),
      )
      expect(metadataLines({ ...todo, updatedAt: Number.NaN }, { width: 60 })[4]).toBe(meta("updated", "unknown"))
    })

    test("an empty selection has no rows", () => {
      expect(metadataLines(undefined, { width: 60 })).toEqual([])
    })

    test("clips a value to the column and stays single-cell", () => {
      const lines = metadataLines({ ...todo, id: "z".repeat(100) }, { width: 20 })
      expect(lines[0].endsWith("\u2026")).toBe(true)
      for (const line of lines) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20)
        for (const char of line) expect(Bun.stringWidth(char)).toBe(1)
      }
    })
  })

  describe("wrapText", () => {
    test("wraps on word boundaries within the column", () => {
      expect(wrapText("a b c d e f", 3)).toEqual(["a b", "c d", "e f"])
    })

    test("preserves explicit line breaks and blank lines", () => {
      expect(wrapText("one\n\ntwo", 20)).toEqual(["one", "", "two"])
    })

    test("hard-breaks a word wider than the column, cell-aware", () => {
      const wide = String.fromCharCode(0x4e2d).repeat(3)
      const lines = wrapText(wide, 2)
      expect(lines).toEqual([String.fromCharCode(0x4e2d), String.fromCharCode(0x4e2d), String.fromCharCode(0x4e2d)])
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(2)
    })

    test("never splits a surrogate pair", () => {
      const lines = wrapText(`ab\u{1f600}cd`, 3)
      for (const line of lines) {
        expect(line).not.toContain("\ufffd")
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(3)
      }
    })

    test("an empty string is one empty line", () => {
      expect(wrapText("", 10)).toEqual([""])
    })
  })

  describe("proseLines", () => {
    const todo = { id: "a", content: "do the thing", status: "pending", priority: "low" }

    test("renders the full content, wrapped", () => {
      expect(proseLines(todo, { width: 6 })).toEqual(["do the", "thing"])
    })

    test("appends notes under a blank line, one bullet each", () => {
      expect(proseLines({ ...todo, notes: ["first", "second"] }, { width: 40 })).toEqual([
        "do the thing",
        "",
        "- first",
        "- second",
      ])
    })

    test("wraps a note that runs past the column", () => {
      expect(proseLines({ ...todo, content: "x", notes: ["a b c"] }, { width: 5 })).toEqual(["x", "", "- a b", "c"])
    })

    test("an empty selection has no rows", () => {
      expect(proseLines(undefined, { width: 20 })).toEqual([])
    })

    test("every rendered line fits the column and is single-cell", () => {
      const lines = proseLines(
        { ...todo, content: "the quick brown fox".repeat(4), notes: ["tail note"] },
        { width: 12 },
      )
      for (const line of lines) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(12)
        for (const char of line) expect(Bun.stringWidth(char)).toBe(1)
      }
    })
  })

  describe("formatStamp", () => {
    test("renders an absolute UTC stamp", () => {
      expect(formatStamp(1_700_000_000_000)).toBe("2023-11-14 22:13:20Z")
    })

    test("a missing or non-finite stamp reads unknown", () => {
      for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(formatStamp(value)).toBe("unknown")
      }
    })
  })

  describe("resolveSelection (the command argument)", () => {
    const todos = [
      { id: "a1", content: "a", status: "pending", priority: "low" },
      { id: "a2", content: "b", status: "pending", priority: "low" },
      { id: "z", content: "c", status: "pending", priority: "low" },
    ]

    test("empty or unresolved selects the first row", () => {
      expect(resolveSelection(todos, undefined)).toBe(0)
      expect(resolveSelection(todos, "  ")).toBe(0)
      expect(resolveSelection(todos, "nope")).toBe(0)
      expect(resolveSelection(todos, "a")).toBe(0) // ambiguous prefix
      expect(resolveSelection([], "1")).toBe(0)
    })

    test("a decimal argument is a 1-based index", () => {
      expect(resolveSelection(todos, "2")).toBe(1)
      expect(resolveSelection(todos, "0")).toBe(0)
      expect(resolveSelection(todos, "99")).toBe(2)
    })

    test("otherwise an exact id, then a unique prefix", () => {
      expect(resolveSelection(todos, "z")).toBe(2)
      expect(resolveSelection(todos, "a2")).toBe(1)
    })
  })

  describe("inspectorFooter", () => {
    test("names the empty session plainly", () => {
      expect(inspectorFooter(0, 0)).toBe("no todos in this session")
    })

    test("shows the position, the keys and the mouse when focused", () => {
      expect(inspectorFooter(3, 1, true)).toBe("2/3 \u00B7 up/down select \u00B7 click a row \u00B7 esc close")
      for (const char of inspectorFooter(3, 2, true)) expect(Bun.stringWidth(char)).toBe(1)
    })

    test("tells an unfocused panel to click first, since its keys are dead until then", () => {
      expect(inspectorFooter(3, 1, false)).toBe("2/3 \u00B7 click to focus first \u00B7 esc close")
      for (const char of inspectorFooter(3, 2, false)) expect(Bun.stringWidth(char)).toBe(1)
    })
  })
})
