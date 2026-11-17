<h1 align="center">oc-recall</h1>
<p align="center"><strong>Read an Atlas graph and search curated source files for OpenCode users.</strong></p>

## Install

This is a GitHub-only preview. It is not published to npm and is not an OpenCode release. Clone this repository, then add the package directory as a local plugin in your OpenCode config:

```json
{
  "plugins": ["./path/to/oc-collections/packages/oc-recall"]
}
```

OpenCode resolves relative plugin paths from the config file containing the entry. The plugin package requires Node.js 22 or newer. OpenCode V2's documented plugin context provides tool transforms and session hooks; compatibility with other OpenCode versions is unverified.

## Configure it

Set the Atlas directory with plugin options:

```json
{
  "plugins": [
    {
      "package": "./path/to/oc-collections/packages/oc-recall",
      "options": {
        "atlas": "/path/to/your/atlas"
      }
    }
  ]
}
```

You can also set `OC_GRAPHIFY_ATLAS` in the plugin host environment. For compatibility, the plugin reads the `atlas` field from `graphify.json` at `~/.config/opencode/graphify.json`; `OC_GRAPHIFY_CONFIG` selects a different config file. Precedence is plugin option, `OC_GRAPHIFY_ATLAS`, then the config file. Configure one Atlas directory containing `graphify-out/graph.json`.

If no Atlas is configured, the plugin still loads and registers its tools; graph and lexical tools return explicit errors, and orientation says the Atlas is not configured. Missing graph data does not get treated as an empty or fresh graph.

## Use it

The six graph tools are `graph_stats`, `graph_node`, `graph_neighbors`, `graph_path`, `graph_god_nodes`, and `graph_query`. They read graph structure only. `graph_query` uses this plugin's label-token matching, not Graphify CLI search semantics.

`recall_search` is a separate, opt-in lexical search. It uses membership from `.graphify/corpus/` and retrieves text from the corresponding Atlas source files; it does not search arbitrary files or mirror contents. A missing membership mirror or incomplete source set is an error, not permission to broaden the search. Results are bounded, marked untrusted, and report membership freshness as unverified. The plugin does not establish that the mirror or freshness probe exists on every Graphify installation.

Keep the Atlas and corpus owner-controlled. Path checks reduce accidental scope escapes, but the file reads are not hardened against concurrent malicious filesystem changes, including symlink swaps; do not treat them as an isolation or security boundary. Cross-platform behavior is unverified.

## Check it

Run the tests from this package directory:

```sh
node --test
```

Tests use temporary synthetic graphs and corpora. They do not require an Atlas or write to one.

## Status

Experimental and still moving. It works today, but it is not a finished
product: interfaces may change, features may be improved or removed, and a
release can break the one before it. This is maintained by one person, not a
team. If it breaks, open an issue with the command you ran and what you saw.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [MIT License](LICENSE)
