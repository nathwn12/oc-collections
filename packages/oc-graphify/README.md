# oc-graphify

An OpenCode plugin that puts the Graphify Atlas in front of every request, so
orientation is automatic: how big the graph is, where its JSON lives, which verb
answers a question, and whether it still matches `HEAD`.

```
<!-- oc-graphify -->
Graphify Atlas (durable memory): 922 nodes, 1537 edges, 86 communities, graphify 0.9.105.
Graph: Q:\PROJECTS\PERSONAL\my-harness-vault\vault\graphify-out\graph.json - the same graph Obsidian shows as the harness-wiki vault (graph-room).
Ask it before grepping: `graph_stats`, `graph_node`, `graph_neighbors`, `graph_path`, `graph_god_nodes`, `graph_query` - this plugin's own reads over the same file. `graphify query "<question>"` with cwd = the atlas is the CLI, for when an exact answer matters.
Rebuild with `node .graphify/tools/sync-corpus.mjs` from the atlas; never from the vault root, never a bare `graphify update`.
Graph state: fresh - built from 6517ef3; no corpus input changed through HEAD.
```

Under the 1200-byte budget the check pins, injected once per request through
the `context`, `compaction` and `generate` session hooks. Everything above the
last line is stable for the life of a build, so the prefix caches; only the
state line moves, and only when the graph is rebuilt.

## What it replaces

`graphify install --platform opencode` writes `plugins/graphify.js` into the host
config: a `tool.execute.before` hook that rewrites the first shell command of a
session into `echo "<hint>" ; <cmd>`. That mutates the exact string a permission
wrapper matches on, to deliver a hint the `/graphify` skill already carries.
This plugin carries the same orientation as context, with the real numbers and
the freshness verdict, and never touches a command. Installing the vendor plugin
again re-adds the file; the check below fails by name when that happens.

## What it deliberately does not do

- **No write verbs.** The six reads answer from `graph.json`; the CLI owns the
  writes (`update`, `cluster-only`, `label`, `export`). A second write surface
  would drift from the CLI.
- **No rebuild.** Rebuilding costs an extraction pass; the block names the
  sanctioned command instead of running it.
- **No third-party module.** It imports only `node:` built-ins and its own
  sibling files.

## Install

1. Record the atlas path once, in the host config directory. The package reads
   this file wherever it is installed from, so a copy and a junction agree:

   ```json
   // ~/.config/opencode/graphify.json
   { "atlas": "Q:\\PROJECTS\\PERSONAL\\my-harness-vault\\vault" }
   ```

2. Put the package where OpenCode discovers plugins, as a junction so this
   repository stays the only writer:

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.config\opencode\plugins\oc-graphify" `
     -Target "Q:\PROJECTS\PERSONAL\oc-collections\packages\oc-graphify"
   ```

3. Restart the host. Plugins load at start; the block appears from the next
   request and `graph_state` is re-read every 60 s.

`OC_GRAPHIFY_CONFIG` overrides the record path for a second host or a test.

## Check

```sh
npm run check -w packages/oc-graphify
```

The check is `node --test test/`. It pins: the four verdict states, the block's
byte-stable prefix, the 1200-byte budget, the marker appearing once, the
`node:`-only imports, the release-lane coherence (`private` exactly when the
package is absent from `scripts/release-target.mjs`'s allowlist), and - when a
host is installed on this machine - that the junction resolves back to this
package and that `AGENTS.md` and `graphify.json` name the same atlas.

## Source-only

The manifest is `private: true` and the package is **not** in
`scripts/release-target.mjs`'s `ALLOWED` list, so no tag or dispatch can publish
it. Admitting it is a one-line change there plus the dispatch choice list in
`.github/workflows/release.yml`; the check enforces that the two decisions stay
in step.

## Tools

Six reads over the same graph.json, so the injected block names something that
answers without a graphify MCP configured:

| Tool | Answers |
|---|---|
| graph_stats | nodes, edges, communities, graphify version, file |
| graph_node | one node by id, exact label, or fragment; candidates when ambiguous |
| graph_neighbors | adjacency, one to three hops, with the relation |
| graph_path | shortest chain between two nodes |
| graph_god_nodes | most connected real entities, file/concept nodes excluded |
| graph_query | label-token search plus one hop; **not** the CLI heuristic |

graph_query says in its own reply that it is label-token search, because
graphify's \query\ resolves seeds with heuristics of its own and answering
differently while pretending parity would be worse than answering plainly.
