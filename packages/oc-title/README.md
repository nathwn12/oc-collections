# oc-title

Sets an OpenCode session title from the session's lifecycle, so the list reads as a board.

- Parent sessions read `active: text`, `parked: text` or `closed: text`.
- Child sessions read the lowercased text alone, with no state prefix.
- The state is also written to session metadata as `oc-title: { state, at }`, so the title is never the only copy.
- Closed is final: an archived session is never reopened by a late idle.
- A tool call is never invented: a record without a string title is left alone.

## Events

Any other session.* event is a catch-up: it stamps only a session that has no `oc-title` metadata yet, and it never reopens a title that already reads closed.
A created event that beats its own record is retried for about a second instead of dropping the write. Busyness is read from the busy and idle timestamps: an older busy stamp is idle, and the last run's outcome never means closed. Body caps count code points so an emoji is never split into a lone surrogate.

## Shape

`index.js` is wiring. `state.js` holds the event map. `title.js` holds the pure title rules. `write.js` is the only module that touches the context, and it owns per-session ordering. Tests sit in `test/`.

## Run

```sh
bun test .
```
