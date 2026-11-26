# oc-title

Sets an OpenCode session title from the session's lifecycle, so the list reads as a board.

- Parent sessions read `active: text`, `parked: text` or `closed: text`.
- Child sessions read the lowercased text alone, with no state prefix.
- The state is also written to session metadata as `oc-title: { state, at }`, so the title is never the only copy.
- Closed is final: an archived session is never reopened by a late idle.
- A tool call is never invented: a record without a string title is left alone.

## Scope refresh

In a long session the state stays right while the scope text goes stale. The
`oc_title_refresh` tool rewrites only that scope, from the session's latest user
request (or an explicit `scope` argument). It updates a title oc-title already
stamped, keeps the current state (parked stays parked), keeps a child's bare title,
keeps other metadata, applies the same cap, and never reopens a closed session.
An empty, tool-only or unstamped session produces no write. The refresh shares the
writer's per-session chain, so it cannot race a lifecycle event.

## Events

Any other session.* event is a catch-up: it stamps only a session that has no `oc-title` metadata yet, and it never reopens a title that already reads closed.
A created event that beats its own record is retried for about a second instead of dropping the write. Busyness is read from the busy and idle timestamps: an older busy stamp is idle, and the last run's outcome never means closed. Body caps count code points so an emoji is never split into a lone surrogate.

## Shape

`index.js` is wiring. `state.js` holds the event map. `refresh.js` reads a user-message scope. `title.js` holds the pure title rules. `write.js` is the only module that touches the context, and it owns per-session ordering. Tests sit in `test/`.

## Run

```sh
bun test .
```
