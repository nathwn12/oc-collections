// oc-todo CLI plugin - a read-only checklist over the stored session todo list.
//
// It owns no state. It calls the server plugin's `todo.list` RPC (the same real
// store the `todo` tool writes) and renders it in two places:
//   - the sidebar: a clipped one-line-per-item checklist (`sidebarLines`)
//   - the inspector panel: a keyboard-driven detail view opened with `/todo`
//     (`listRows` / `metadataLines` / `proseLines`)
// When the server emits `rpc.todo.changed`, both refresh; a light poll covers a
// remote server whose events this TUI is not subscribed to.
//
// Every line of text is built by a pure renderer kept out of the JSX so it is
// trivial to test: rows are a fixed label column, a guaranteed separator, then a
// clipped value, and every glyph the renderers emit is exactly one cell wide.

/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createSignal, For, Show } from "solid-js"
import { Todo } from "./contract.js"

interface TodoItem {
  id: string
  content: string
  status: string
  priority: string
  notes?: string[]
  createdAt?: number
  updatedAt?: number
}

/** One already-clipped sidebar line, before it is themed. */
export interface SidebarLine {
  /** The final line text; the renderer truncates nothing further. */
  text: string
  /** True for a closed (completed/cancelled) item row. */
  muted: boolean
}

/**
 * The four status marks: pending `\u25CB` (U+25CB), in_progress `\u25D0` (U+25D0),
 * completed `\u25CF` (U+25CF), cancelled `\u2297` (U+2297). Exactly one cell each
 * and all four distinct - the old `[x]` three-cell tokens and the shared
 * `-` for pending/cancelled are both gone.
 */
const STATUS_MARK: Record<string, string> = {
  pending: "\u25CB",
  in_progress: "\u25D0",
  completed: "\u25CF",
  cancelled: "\u2297",
}

/** The mark for an unknown stored status: read it as still pending. */
const UNKNOWN_MARK = "\u25CB"

/** Toggle marks: `\u25BC` (U+25BC) expanded, `\u25B6` (U+25B6) collapsed - the V1 sidebar set. */
const TOGGLE_EXPANDED = "\u25BC"
const TOGGLE_COLLAPSED = "\u25B6"

/**
 * Value-column budget for an item, in cells.
 *
 * The sidebar is roughly thirty-odd columns wide, so the mark's one-cell label
 * column plus its separator plus this budget stays inside the panel. Without it
 * a long todo wraps the sidebar, which costs the reader more than a shortened
 * line.
 */
export const CONTENT_WIDTH = 28

/** The label column every row uses: one cell, the mark or the toggle. */
const LABEL_WIDTH = 1

/**
 * Flatten control characters in anything about to be drawn.
 *
 * A row is one line, so a newline or an escape sequence in a host-supplied
 * string does not get seen - it moves the cursor. The same rule the Flight Deck
 * rail applies to every value it draws.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g
function plain(value: string): string {
  return value.replace(CONTROL_CHARS, " ")
}

/**
 * The label column plus its guaranteed separator, before a row's value.
 *
 * A label wider than its column still gets a separator, so a value can never
 * begin inside the label column.
 */
function labelPrefix(label: string, labelWidth: number): string {
  return `${label.padEnd(labelWidth)}${label.length >= labelWidth ? " " : ""}`
}

/** One padded row: the label in its column, its separator, then the flattened value. */
function formatRow(label: string, value: string, labelWidth: number): string {
  return `${labelPrefix(label, labelWidth)}${plain(value)}`
}

/**
 * The cell width of one code point: wide/CJK and pictographic ranges take two
 * cells, everything else one. Conservative on purpose - an unknown wide glyph
 * may clip a cell early, but a row can never overrun the sidebar.
 */
function cellWidth(code: number): number {
  if (code < 0x1100) return 1
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2
  return 1
}

/** Cell width of a whole value: the sum of its code points' cells. */
function cellCount(text: string): number {
  let width = 0
  for (const char of text) width += cellWidth(char.codePointAt(0) ?? 0)
  return width
}

/**
 * Shorten a value for the narrow sidebar.
 *
 * Width-aware and code-point-safe: the ellipsis tells the reader the value was
 * cut rather than being the value, iterating code points (never `slice`) means
 * a surrogate pair is never split, and the result is at most `max` cells wide
 * even when wide characters count double.
 */
function clip(text: string, max: number): string {
  if (cellCount(text) <= max) return text
  const budget = Math.max(1, max - 1)
  let width = 0
  let cut = ""
  for (const char of text) {
    const next = width + cellWidth(char.codePointAt(0) ?? 0)
    if (next > budget) break
    cut += char
    width = next
  }
  if (cut.length === 0) return String.fromCharCode(0x2026)
  return `${cut}${String.fromCharCode(0x2026)}`
}

/** The rows a refresh settles on: fresh rows on success, the last good rows on error. */
export function refreshedRows(
  previous: TodoItem[],
  outcome: { ok: true; todos?: TodoItem[] } | { ok: false },
): TodoItem[] {
  if (!outcome.ok) return previous
  return outcome.todos ?? []
}

/** The compact note count suffix, or the empty string when the item has none. */
function notesSuffix(notes: readonly string[] | undefined): string {
  const count = notes?.length ?? 0
  if (count === 0) return ""
  return ` (${count} note${count > 1 ? "s" : ""})`
}

/**
 * The sidebar's lines for a stored list: the header first, then the item rows
 * when expanded. Pure, so the rendering is asserted directly rather than
 * through the JSX.
 *
 * The header is always the first line when the list is non-empty, so the
 * collapsed and expanded headers never differ in column offset. A closed
 * (completed or cancelled) item row is `muted`; every row is exactly one label
 * cell, its separator, then the clipped value.
 */
export function sidebarLines(
  todos: readonly TodoItem[],
  opts?: { expanded?: boolean; labelWidth?: number; contentWidth?: number },
): SidebarLine[] {
  if (todos.length === 0) {
    const labelWidth = opts?.labelWidth ?? LABEL_WIDTH
    const contentWidth = opts?.contentWidth ?? CONTENT_WIDTH
    const hint = clip("todo - use the todo tool for multi-step work", contentWidth)
    // The hint wears the pending mark (U+25CB), consistent with the status marks.
    return [{ text: formatRow(String.fromCharCode(0x25CB), hint, labelWidth), muted: true }]
  }
  const labelWidth = opts?.labelWidth ?? LABEL_WIDTH
  const contentWidth = opts?.contentWidth ?? CONTENT_WIDTH
  const total = todos.length
  const closed = todos.filter((todo) => todo.status === "completed" || todo.status === "cancelled").length
  const expanded = opts?.expanded ?? total - closed > 0

  const lines: SidebarLine[] = [
    {
      text: formatRow(expanded ? TOGGLE_EXPANDED : TOGGLE_COLLAPSED, `todos ${closed}/${total}`, labelWidth),
      muted: false,
    },
  ]
  if (!expanded) return lines

  for (const todo of todos) {
    const closedRow = todo.status === "completed" || todo.status === "cancelled"
    const mark = STATUS_MARK[todo.status] ?? UNKNOWN_MARK
    const value = clip(`${todo.content}${notesSuffix(todo.notes)}`, contentWidth)
    lines.push({ text: formatRow(mark, value, labelWidth), muted: closedRow })
  }
  return lines
}

// ---------------------------------------------------------------------------
// Inspector panel: the keyboard-driven detail view opened with `/todo`.
//
// Like the sidebar, everything it draws goes through a pure renderer so the
// layout, the selection math, and the wrapping are asserted directly. The JSX
// below is a thin shell: it computes the column budgets from the panel width,
// calls these functions, and paints the resulting lines.
// ---------------------------------------------------------------------------

/** The panel slot name. Plugin-prefixed so it cannot collide with another plugin's panel. */
const INSPECTOR_NAME = "oc-todo.inspect"

/** Selection gutter for the selected row: `\u25B8` (U+25B8), one cell. */
export const SELECT_MARK = "\u25B8"

/** Selection gutter for every other row: a single space, so columns never shift. */
const SELECT_BLANK = " "

/** The left list takes this fraction of the panel width; the detail column takes the rest. */
const LIST_RATIO = 0.3

/** The minimum usable column, in cells, so a very narrow panel never renders nothing. */
const MIN_COLUMN = 8

/** The metadata label column: wide enough for `priority`, the longest field name. */
const META_LABEL_WIDTH = 8

/**
 * Clamp a selection index into `[0, length - 1]`; always 0 for an empty list.
 * `Math.trunc` first, so a fractional index cannot land between rows, and a
 * non-finite index (a malformed store is not the only source) reads as 0 rather
 * than `NaN`.
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.max(0, Math.min(Math.trunc(index), length - 1))
}

/** Move a selection by `delta` and clamp into range. */
export function moveSelection(index: number, delta: number, length: number): number {
  return clampIndex(index + delta, length)
}

/** The left column budget for a panel `panelWidth` cells wide (padding accounted). */
export function listColumnWidth(panelWidth: number): number {
  return Math.max(MIN_COLUMN, Math.floor(Math.max(0, panelWidth) * LIST_RATIO) - 1)
}

/** The detail column budget: what remains of the panel after the list column. */
export function detailColumnWidth(panelWidth: number): number {
  return Math.max(MIN_COLUMN, Math.max(0, panelWidth) - Math.floor(Math.max(0, panelWidth) * LIST_RATIO) - 3)
}

/**
 * A stored millisecond timestamp as absolute UTC text, or `unknown` when it is
 * not a finite positive number. Absolute by design in v1 (ROADMAP #12 covers
 * relative stamps); the fixed shape keeps the pure renderer deterministic.
 */
export function formatStamp(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "unknown"
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)}Z`
}

/** One left-list row: the painted text, whether it is closed, and whether it is selected. */
export interface ListRow {
  text: string
  muted: boolean
  selected: boolean
}

/**
 * The inspector's left list: one row per todo, in stored order.
 *
 * The row is `<gutter><mark> <value>` where the gutter is a one-cell selection
 * mark, the status mark is the sidebar's, and the value is the content plus the
 * sidebar's notes suffix, clipped to the column. The gutter is a space on every
 * unselected row, so the status marks stay in one column.
 */
export function listRows(
  todos: readonly TodoItem[],
  opts: { selected: number; width: number },
): ListRow[] {
  const width = Math.max(1, opts.width)
  // A row is gutter (1) + mark (1) + separator (1); the value gets the rest.
  const valueWidth = Math.max(1, width - 3)
  const selected = clampIndex(opts.selected, todos.length)
  return todos.map((todo, index) => {
    const isSelected = index === selected
    const mark = STATUS_MARK[todo.status] ?? UNKNOWN_MARK
    const gutter = isSelected ? SELECT_MARK : SELECT_BLANK
    const value = clip(`${todo.content}${notesSuffix(todo.notes)}`, valueWidth)
    return {
      text: formatRow(`${gutter}${mark}`, value, 2),
      muted: todo.status === "completed" || todo.status === "cancelled",
      selected: isSelected,
    }
  })
}

/** The compact notes summary for the metadata pane: `none`, `1 note`, `2 notes`. */
function noteCountLabel(notes: readonly string[] | undefined): string {
  const count = notes?.length ?? 0
  if (count === 0) return "none"
  return `${count} note${count > 1 ? "s" : ""}`
}

/**
 * The inspector's metadata rows for the selected todo: fixed label column, one
 * row per field, each clipped to the column. `undefined` (an empty list) has no
 * rows.
 */
export function metadataLines(todo: TodoItem | undefined, opts: { width: number }): string[] {
  if (!todo) return []
  const width = Math.max(1, opts.width)
  const valueWidth = Math.max(1, width - META_LABEL_WIDTH - 1)
  const fields: Array<[string, string]> = [
    ["id", todo.id],
    ["status", todo.status],
    ["priority", todo.priority],
    ["created", formatStamp(todo.createdAt ?? 0)],
    ["updated", formatStamp(todo.updatedAt ?? 0)],
    ["notes", noteCountLabel(todo.notes)],
  ]
  // A fixed label column plus one separator, so every value starts at the same
  // column regardless of how short the label is.
  return fields.map(
    ([label, value]) => `${label.padEnd(META_LABEL_WIDTH)} ${clip(plain(value), valueWidth)}`,
  )
}

/**
 * The inspector's prose rows: the full content, then a blank line and each note
 * prefixed `- `. Everything is wrapped to the column, so a long line can never
 * overflow the pane. An `undefined` todo (an empty list) has no rows.
 */
export function proseLines(todo: TodoItem | undefined, opts: { width: number }): string[] {
  if (!todo) return []
  const width = Math.max(1, opts.width)
  const lines = wrapText(todo.content, width)
  const notes = todo.notes ?? []
  if (notes.length > 0) {
    if (lines.length > 0) lines.push("")
    for (const note of notes) lines.push(...wrapText(`- ${note}`, width))
  }
  return lines
}

/**
 * Cell-width-aware word wrap. Explicit newlines are preserved as paragraph
 * breaks; a word wider than the column is hard-broken by cells (never `slice`,
 * so a surrogate pair is not split). The result lines are each at most `width`
 * cells.
 */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width)
  const out: string[] = []

  // Hard-break a single over-long word into `limit`-cell chunks.
  const hardBreak = (word: string): string[] => {
    const chunks: string[] = []
    let rest = word
    while (cellCount(rest) > limit) {
      let chunk = ""
      let chunkWidth = 0
      for (const char of rest) {
        const next = chunkWidth + cellWidth(char.codePointAt(0) ?? 0)
        if (next > limit) break
        chunk += char
        chunkWidth = next
      }
      if (chunk.length === 0) break
      chunks.push(chunk)
      rest = rest.slice(chunk.length)
    }
    chunks.push(rest)
    return chunks
  }

  for (const raw of text.split("\n")) {
    // Flatten any remaining control characters per line; the newline was already
    // used as the paragraph break, and `plain` would otherwise erase it.
    const paragraph = plain(raw)
    if (paragraph.trim().length === 0) {
      out.push("")
      continue
    }
    let line = ""
    let lineWidth = 0
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (cellCount(word) > limit) {
        if (line.length > 0) {
          out.push(line)
          line = ""
          lineWidth = 0
        }
        const chunks = hardBreak(word)
        for (let i = 0; i < chunks.length - 1; i++) out.push(chunks[i])
        line = chunks[chunks.length - 1]
        lineWidth = cellCount(line)
        continue
      }
      const wordWidth = cellCount(word)
      if (lineWidth === 0) {
        line = word
        lineWidth = wordWidth
      } else if (lineWidth + 1 + wordWidth <= limit) {
        line = `${line} ${word}`
        lineWidth += 1 + wordWidth
      } else {
        out.push(line)
        line = word
        lineWidth = wordWidth
      }
    }
    out.push(line)
  }
  return out
}

/**
 * Resolve the command argument to a selection index for `todos`. A decimal
 * argument is a 1-based index; otherwise it is an exact id, then a unique id
 * prefix. Anything unresolved selects the first row.
 */
export function resolveSelection(todos: readonly TodoItem[], selector: string | undefined): number {
  const query = (selector ?? "").trim()
  if (query.length === 0 || todos.length === 0) return 0
  if (/^\d+$/.test(query)) return clampIndex(Number.parseInt(query, 10) - 1, todos.length)
  const exact = todos.findIndex((todo) => todo.id === query)
  if (exact >= 0) return exact
  const matches = todos.flatMap((todo, index) => (todo.id.startsWith(query) ? [index] : []))
  return matches.length === 1 ? matches[0] : 0
}

/**
 * The inspector's one-line footer: position, then the key hints.
 *
 * The hints are focus-aware on purpose. The panel's keys are live only while it
 * owns input, so an unfocused panel must say "click to focus first" - otherwise
 * `esc` silently does nothing and the reader concludes the panel is stuck. The
 * focused line names the mouse too, since clicking a row selects it.
 */
export function inspectorFooter(total: number, selected: number, focused = true): string {
  if (total === 0) return "no todos in this session"
  const position = `${clampIndex(selected, total) + 1}/${total}`
  return focused
    ? `${position} \u00B7 up/down select \u00B7 click a row \u00B7 esc close`
    : `${position} \u00B7 click to focus first \u00B7 esc close`
}

export default Plugin.define({
  id: "oc-todo",
  setup(context) {
    const client = context.client
    const [todos, setTodos] = createSignal<TodoItem[]>([])
    // undefined = auto (expand while work remains, collapse when all closed);
    // a click sets true/false and that preference wins for this session.
    const [manual, setManual] = createSignal<boolean | undefined>(undefined)
    let sessionID: string | undefined

    // Monotonic request id: only the newest refresh may write the signal, so a
    // slow response for an older session (or an older tick) can never win.
    let requestSeq = 0
    const refresh = async (id: string) => {
      const seq = ++requestSeq
      try {
        // `client.rpc` builds a typed subclient from the shared contract.
        const remote = client.rpc(Todo)
        const result = (await remote.list({ sessionID: id })) as { todos?: TodoItem[] }
        if (seq === requestSeq && sessionID === id) setTodos(refreshedRows(todos(), { ok: true, todos: result.todos }))
      } catch {
        // A failed refresh holds the last good rows; only a session switch resets.
        if (seq === requestSeq && sessionID === id) setTodos(refreshedRows(todos(), { ok: false }))
      }
    }

    // Both surfaces share one feed: switching to a new session resets the rows
    // and kicks one refresh; the sidebar and the inspector panel both call this,
    // but only the first call for a given session does any work.
    const track = (id: string) => {
      if (id === sessionID) return
      sessionID = id
      setTodos([])
      void refresh(id)
    }

    // The command argument for the next panel open, consumed once the panel
    // mounts (the panel owns the selection, so it applies this itself).
    const [preselect, setPreselect] = createSignal<string | undefined>(undefined)

    const unsub = context.data.on("rpc.todo.changed", (event: any) => {
      if (sessionID && event?.data?.sessionID === sessionID) void refresh(sessionID)
    })
    // Fallback: refresh on a slow tick so a missed/filtered event cannot leave
    // the checklist stale. Cheap: one read per 3s for the visible session only.
    const timer = setInterval(() => {
      if (sessionID) void refresh(sessionID)
    }, 3_000)

    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID: id }) => {
        if (id !== sessionID) setManual(undefined)
        track(id)
        // "Active" means work still to do. Cancelled is a terminal state, like completed.
        const active = () => todos().filter((t) => t.status !== "completed" && t.status !== "cancelled")
        const expanded = () => manual() ?? active().length > 0
        const lines = () => sidebarLines(todos(), { expanded: expanded() })
        return (
          <Show when={lines().length > 0}>
            <box flexDirection="column">
              {/* The header is the click target; it stays visible in both states. */}
              <box flexDirection="row" onMouseUp={() => setManual(!expanded())}>
                <text fg={context.theme.text.base} wrapMode="none" truncate>
                  {lines()[0]?.text ?? ""}
                </text>
              </box>
              <Show when={expanded()}>
                <For each={lines().slice(1)}>
                  {(line) => (
                    <text fg={line.muted ? context.theme.text.muted : context.theme.text.base} wrapMode="none" truncate>
                      {line.text}
                    </text>
                  )}
                </For>
              </Show>
            </box>
          </Show>
        )
      },
    })

    // The inspector command. Registered for the plugin's lifetime (setup is the
    // documented place to create a layer) and gated on the current route so it
    // never opens a panel with no session behind it.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "oc-todo.inspect",
          title: "Show todos",
          group: "Session",
          palette: true,
          slash: { name: "show-todos", arguments: true },
          run: (input?: string) => {
            if (context.ui.router.current().type !== "session") {
              context.ui.toast.show({ message: "Open a session first", variant: "warning" })
              return
            }
            setPreselect(input)
            context.ui.panel.open(INSPECTOR_NAME)
          },
        },
      ],
    }))

    // The inspector panel itself. It renders only when its name is the selected
    // panel, so several plugins' panels can coexist in the slot. It owns just a
    // selection index; the rows come from the shared feed above.
    const Inspector = (props: { panel: PanelInput }) => {
      const [selected, setSelected] = createSignal(0)
      const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()

      // Follow the panel's session through the shared feed.
      createEffect(() => track(props.panel.sessionID))

      // Apply (and consume) a command argument once the panel is up and its rows
      // have loaded. The panel owns the selection, so the command only leaves a
      // request behind; consuming it against an empty list would drop it.
      createEffect(() => {
        const selector = preselect()
        if (selector === undefined) return
        if (todos().length === 0) return
        setSelected(resolveSelection(todos(), selector))
        setPreselect(undefined)
      })

      const current = () => {
        const items = todos()
        return items[clampIndex(selected(), items.length)]
      }
      const step = (delta: number) => setSelected((index) => moveSelection(index, delta, todos().length))

      // Panel-local layer: active only while this panel owns input (it is owned
      // by the component and disposed with it). Clamped, never wrapped.
      context.keymap.layer(() => ({
        commands: [
          { id: "oc-todo.inspect.up", bind: "up,k", run: () => step(-1) },
          { id: "oc-todo.inspect.down", bind: "down,j", run: () => step(1) },
          { id: "oc-todo.inspect.close", bind: "escape,q", run: () => props.panel.close() },
        ],
      }))

      // Keep the selected row inside the viewport. The host owns the panel's
      // height, so this reads the live scroll box rather than guessing one.
      createEffect(() => {
        const box = scroll()
        if (!box) return
        const viewport = box.viewport.height
        if (!(viewport > 0)) return
        const max = Math.max(0, box.scrollHeight - viewport)
        box.scrollTop = Math.max(0, Math.min(selected() - Math.floor(viewport / 2), max))
      })

      const listWidth = () => listColumnWidth(props.panel.width)
      const detailWidth = () => detailColumnWidth(props.panel.width)

      return (
        <box flexDirection="column" width="100%" height="100%" onMouseUp={() => props.panel.focus()}>
          <box flexDirection="row" flexGrow={1} minHeight={0}>
            <box flexDirection="column" width="30%" flexShrink={0} paddingRight={1}>
              <scrollbox
                ref={(element) => setScroll(element)}
                flexGrow={1}
                minHeight={0}
              >
                <For each={listRows(todos(), { selected: selected(), width: listWidth() })}>
                  {(row, index) => (
                    <text
                      fg={row.muted ? context.theme.text.muted : context.theme.text.base}
                      bg={row.selected ? context.theme.background.raised.high : undefined}
                      wrapMode="none"
                      truncate
                      onMouseUp={() => {
                        setSelected(index())
                        props.panel.focus()
                      }}
                    >
                      {row.text}
                    </text>
                  )}
                </For>
              </scrollbox>
            </box>
            <box flexDirection="column" flexGrow={1} minWidth={0}>
              <box flexDirection="column" maxHeight="25%" flexShrink={0} paddingBottom={1}>
                <For each={metadataLines(current(), { width: detailWidth() })}>
                  {(line) => (
                    <text fg={context.theme.text.muted} wrapMode="none" truncate>
                      {line}
                    </text>
                  )}
                </For>
              </box>
              <box flexDirection="column" flexGrow={1} minHeight={0}>
                <For each={proseLines(current(), { width: detailWidth() })}>
                  {(line) => (
                    <text fg={context.theme.text.base} wrapMode="none" truncate>
                      {line}
                    </text>
                  )}
                </For>
              </box>
            </box>
          </box>
          <box flexDirection="row" flexShrink={0} height={1}>
            <text fg={context.theme.text.muted} wrapMode="none" truncate>
              {inspectorFooter(todos().length, selected(), props.panel.focused)}
            </text>
          </box>
        </box>
      )
    }

    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === INSPECTOR_NAME}>
          <Inspector panel={panel} />
        </Show>
      ),
    })

    return () => {
      unsub()
      clearInterval(timer)
    }
  },
})
