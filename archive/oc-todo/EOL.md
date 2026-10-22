# End of life — oc-todo

`oc-todo` is retired: the built-in task list is back, so this workaround is no longer needed.

This is the good outcome. `oc-todo` existed to fill the gap left when OpenCode removed the built-in `todowrite` tool. OpenCode 2.1.0 restored `todowrite` behind `{ "experimental": { "todo": true } }`, so the gap no longer exists. A workaround retiring when the platform catches up is the success case, not a failure.

## Migrate

1. Remove the `oc-todo` entry from `plugins` in `opencode.jsonc`.
2. Add `"experimental": { "todo": true }` to `opencode.jsonc`, then restart OpenCode.

```jsonc
{
  "experimental": { "todo": true }
}
```

The session output and sidebar now render the built-in task list.

## Final state

- npm: `oc-todo@0.5.1` stays installable and is deprecated, never unpublished.
- GitHub: repository archived read-only, releases removed, tags retained.
- No further fixes, features, issues, or releases.

## Thanks

Thank you to the users, issue reporters, and contributors who shaped `oc-todo` — including `knightb8` for the `/show-todos` inspector (PR #2).

Retired 2026-10-21.
