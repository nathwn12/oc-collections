# oc-graphify

An OpenCode plugin that puts the Graphify Atlas in front of every request, so
orientation is automatic: how big the graph is, where its JSON lives, which verb
answers a question, and whether it matches the corpus inputs the build recorded.

It is built for Obsidian + Graphify atlases and their four jobs — maintain,
query, update and observe — and is distributed only through the GitHub path,
never npm.

```
<!-- oc-graphify -->
Graphify Atlas (durable memory): 922 nodes, 1537 edges, 86 communities, graphify 0.9.105.
Graph: Q:\PROJECTS\PERSONAL\my-harness-vault\vault\graphify-out\graph.json - the same graph Obsidian shows as the harness-wiki vault (graph-room).
Ask it before grepping: `graph_node`, `graph_neighbors`, `graph_path` - this plugin's own reads over the same file. Search with `graphify query "<question>"` (cwd = the atlas) when an exact answer matters; the hub list is in `GRAPH_REPORT.md`.
Rebuild with `node .graphify/tools/sync-corpus.mjs` from the atlas; never from the vault root, never a bare `graphify update`.
Graph state: fresh - graph-freshness: extraction cache: 0 cached, 219 seed-covered, 0 unaccounted.
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

- **No write verbs.** The three reads answer from `graph.json`; the CLI owns the
  writes (`update`, `cluster-only`, `label`, `export`). A second write surface
  would drift from the CLI.
- **No search or hub list.** `graphify query "<question>"` (cwd = the atlas) is
  the one search route; `GRAPH_REPORT.md` is the one hub list. A second copy of
  either would drift from the CLI and the published report.
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

## Graph direction and freshness

Directed Atlas links are traversed from `source` to `target`; paths do not
reverse them. Neighbour results identify the stored link orientation. The most
connected entities are published in `GRAPH_REPORT.md`, ranked by total degree
(incoming plus outgoing) for directed graphs. Undirected graphs remain
traversable from either endpoint.

Freshness probes run asynchronously and coalesce while one refresh is in flight.
The first request, and any request while a refresh is pending, uses the cached
snapshot; until a verdict is available it says `unverified`. If `graph.json`
changes during a probe, the new counts are loaded but that probe's verdict is
discarded as `unknown` rather than being applied to different graph bytes.

The hidden child probe is the first source of truth; the build ledger is the
second. When the child fails or gives no verdict, the ledger's recorded corpus
inputs and graph digest decide, and the state line names that fallback. Only
when neither source answers does the block say `unverified` - a failed probe is
never implicitly `fresh`, but a valid ledger is a real verdict.

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
`.github/workflows/release.yml`; the check only pins the manifest's `private`
flag against that allowlist.

## Tools

Three reads over the same graph.json, so the injected block names something that
answers without a graphify MCP configured:

| Tool | Answers |
|---|---|
| graph_node | one node by id, exact label, or fragment; candidates when ambiguous |
| graph_neighbors | adjacency, one to three hops, with the relation |
| graph_path | shortest chain between two nodes |

The host owns locating and relating nodes only. Search is the CLI's job:
`graphify query "<question>"` with cwd = the atlas, which resolves seeds with
its own heuristics. The hub list is in `GRAPH_REPORT.md`; keeping it published
there avoids a second ranking that could drift from the atlas build.
