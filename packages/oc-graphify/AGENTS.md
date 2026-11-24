# oc-graphify - package guardrails

Read the repo root [AGENTS.md](../../AGENTS.md) first; it binds this package too.

## What this package is

A plugin that injects one block of Atlas orientation into an OpenCode request.
It reads graph bytes and never writes them. When freshness is stale it starts
the vault's own incremental sync once, detached, off the critical path; the CLI
stays the only writer of `graph.json` and the seed. `README.md` carries the
block as the owner sees it; if the rendered text changes, that sample and the
byte budget line change here.

## Rules the check enforces

- **No command rewriting.** The plugin registers only `session.hook`. A
  `tool.execute.before` that mutates `input.command` is the vendor behaviour this
  package exists to replace. Do not reintroduce it.
- **No graph write, one rebuild trigger.** The CLI owns every graph byte; three
  reads answer from `graph.json`: `graph_node` finds one node, `graph_neighbors`
  walks one to three hops with the relation, `graph_path` gives the shortest
  chain. Word search is the CLI's `graphify query`; the hub list is
  `GRAPH_REPORT.md`. The only write-adjacent act allowed is the detached,
  once-per-host start of `atlas.mjs sync --if-stale --quiet` on a stale verdict.
  Do not add a write verb, a second freshness notion, a second search, a second
  ranking, a timer or a daemon.
- **`node:` imports only.** Zero dependencies, zero build step. The plugin is
  loaded by the host exactly as committed.
- **One record of the atlas path.** `graphify.json` in the host config directory
  (overridable with `OC_GRAPHIFY_CONFIG`); no path literal in source.
- **Private exactly while unlisted.** `private: true` and absence from
  `scripts/release-target.mjs`'s `ALLOWED` are the same decision and the check
  fails when they disagree. Admitting the package to the release lane is that
  one line plus the dispatch choice list in `.github/workflows/release.yml` - an
  owner call, not a cleanup.

## Commands

```sh
npm run check -w packages/oc-graphify   # node --test test/
```

A stale graph is not a failure: the block reports `STALE` with both commits and
the rebuild command, and the check prints the same note rather than going red.
