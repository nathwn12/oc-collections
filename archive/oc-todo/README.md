<p align="center">
  <img src="assets/icon.svg" width="120" height="120" alt="oc-todo icon" />
</p>
<h1 align="center">oc-todo</h1>
<p align="center"><strong>Track your session's next steps without losing them between turns.</strong></p>

## End of life

**End of life 2026-10-21 — see [EOL.md](EOL.md).** OpenCode 2.1.0 restored the built-in `todowrite` tool behind `{ "experimental": { "todo": true } }`; use it instead of this plugin. Migrate in two steps: remove the `oc-todo` entry from `plugins` in `opencode.jsonc`, then add the `experimental` block and restart. This repository is archived and receives no further updates.

## Install

No install route is supported. `oc-todo` is end-of-life; see [EOL.md](EOL.md) for the migration to the built-in `todowrite`.

## Use it (historical)

Track a multi-step task:

> Use the todo tool to track these steps: write the failing case, fix it, rerun the check.

You get back the stored list with one line per item, plus a counts line such as `2 open · 0 in progress · 0 done`.

Check status mid-task:

> What is left on the todo list?

You get back the same stored list; pending items show `[ ]` and completed items show `[x]`.

Open the visual inspector with `/show-todos`, move with `up`/`down` or `k`/`j`, and close with `escape` or `q`.

## What you get

- Keep your plan across turns: each session stores its own list and it survives restarts.
- Drive the list through one tool: your agent lists, adds, updates, completes, moves, and clears with `todo`.
- See progress beside your session: the sidebar checklist refreshes on every stored write.
- Read full detail on demand: `/show-todos` shows content, notes, and timestamps for the selected item.
- Reuse your V1 habit: `write` replaces the whole list like `todowrite`.

## Requirements

- OpenCode V2.
- Node 22 or newer, or Bun 1.4 or newer.
- To uninstall, remove the entry from `plugins` and restart OpenCode.

## Links

- Repository: https://github.com/nathwn12/oc-todo
- Package: https://www.npmjs.com/package/oc-todo
- Issues: https://github.com/nathwn12/oc-todo/issues
- Releases: https://github.com/nathwn12/oc-todo/releases
- License: [LICENSE](LICENSE)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
