# oc-todo — roadmap

Owner-approved improvement inventory. Source: IDEA/THINKER pass 2026-10-05.
Repo: `oc-todo` (github.com/nathwn12/oc-todo). Golden baseline: v0.1.2.

## Tier 1 — DONE (v0.2.0 → v0.2.3, released + CERTIFIED GOLDEN 2026-10-05)

Shipped: #1 cross-session open, #2 move/reorder, #3 notes, #4 counts summary.
Review/fix history: v0.2.0 blocked (H1 move single-selector) -> v0.2.1; Low polish -> v0.2.2;
certification found non-finite-timestamp `coerce` gap -> v0.2.3.
Certification (isolated, adversarial, cleaned up): 120/120 pass (70 unit + 50 edge/fuzz), 0 fail.
Live ERIS proof on v0.2.3: add+notes, move reorder, H1 refusal, no-op summary, cross-session
`open` across 5 sessions — all correct. `bun run check` = 70 tests + tsc clean.
npm 0.2.3; GitHub Release v0.2.3; local plugin 0.2.3.

## v0.3.0 — DONE (2026-10-06)

Three tool-contract tightenings plus the TUI-native sidebar rework. No new tool
surface, no RPC/contract change.

- **`write` requires `todos`** — a `write` with no `todos` is refused with
  `write requires todos` and changes nothing; it used to clear the list.
- **`update` refuses an unknown `status`/`priority`** — an out-of-vocabulary
  value is refused with the allowed set named and changes nothing, instead of
  silently defaulting (`add`/`write` still default to `pending`/`medium`).
- **`open` is deterministically ordered** — priority (`high` → `medium` → `low`)
  then `updatedAt` descending, so the order is deterministic for a given set of
  rows; exact (priority, `updatedAt`) ties keep their input order.
- **Sidebar rework** — single-cell marks (`-` pending, `~` in_progress, `x`
  completed, `/` cancelled), a one-cell label column plus guaranteed separator
  before a clipped (28-cell) value, and an ASCII `v`/`>` toggle. `✓` and the
  U+25BC/U+25B6 triangles are gone; the marks, the toggle, and the ellipsis are
  single-cell and narrow, and a wide-character content value is clipped at render
  time so the row cannot wrap.
- `bun run check` = 87 tests + tsc clean.

### Tier 2/3 items considered for v0.3.0 and rejected (stay saved, not closed)

- **#5 Bulk operations** — needs an ids-array argument and a `--dry-run`
  surface; a new contract, out of scope for a tightening-only slice.
- **#6 Status transitions with rules** — advisory transition logic edges toward
  deciding for the caller; oc-todo stores, never decides.
- **#7 Export/import** — a new serialization surface and file format; its own slice.
- **#8 TUI interactivity** — keyboard selection is a much larger TUI surface than
  the sidebar line rework and was not needed to fix the mark/column bugs.
- **#9 Storage hygiene** — a manual `prune` is destructive and needs its own
  design and authorization; never auto-prune.
- **#10 `list` filters** — an additive query surface not required by any bug here.
- **#11 RPC parity** — new RPC methods (`todo.counts`, `todo.export`); contract change.
- **#12 Relative timestamps** — display-only, but the sidebar/`format` slice was
  scoped to correctness, not new fields.

## v0.5.0 — DONE (2026-10-11)

The detail-inspector panel (CLI plugin only). No server/contract/storage change.

- **#8 TUI interactivity** (inspection scope, v1) — a read-only `session.panel`
  inspector opened with `/show-todos`: a selectable list (left, 30% width), the selected
  item's metadata (top-right, ≤25% height), and its full content + notes wrapped
  read-only (bottom-right). `up`/`down`/`k`/`j` select, `escape`/`q` close; the
  optional command argument preselects by 1-based index or id/unique-id-prefix.
  Current session only; in-place mutation and cross-session mode remain open.
- The sidebar and the inspector share one data feed (one signal, one
  `rpc.todo.changed` subscription, one 3s poll fallback).
- Pure renderers for the panel (`listRows`, `metadataLines`, `proseLines`,
  `wrapText`, `formatStamp`, `resolveSelection`, selection math, column budgets).
- `bun run check` = 132 tests + tsc clean.

## Tier 2 — saved, TBA

- **#5 Bulk operations** — ids-array (`"all"` / `["a","b"]`) for complete/update, plus `--dry-run`.
- **#6 Status transitions with rules** — explicit `reopen`; advisory warning when moving to
  `in_progress` while a predecessor is open. Never blocking.
- **#7 Export/import** — markdown checklist + JSON; makes the list portable and git-friendly.
- **#8 TUI interactivity** — the inspector panel shipped (v0.5.0); the
  toggle-complete-in-place and jump-to-item halves remain saved.

## Tier 3 — saved, later

- **#9 Storage hygiene** — manual `prune` for lists older than N days (never auto-prune).
- **#10 `list` filters** — status, priority, has-notes, assigned-agents.
- **#11 RPC parity** — `todo.counts`, `todo.export` on the RPC surface the TUI consumes.
- **#12 Relative timestamps** in `format` ("2h ago" for `updatedAt`).

## Explicitly NOT doing

- Auto-computed n / agent counts — oc-todo stores, never decides (owner rejected 2026-10-05).
- Notifications / runtime nudging — plugin-shaped; the `oc-scribe` plugin was parked for the
  same over-reach. Keep oc-todo storage + render.
- Time tracking / estimates; sync / cloud (host SQLite is the sync boundary).

## Recommended v0.2.0 slice

Tier 1 wholesale (#1 + #2 + #3 + #4) — the biggest usefulness jump per unit of risk.
