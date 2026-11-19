# oc-recall

BM25 lexical search over your markdown notes and your OpenCode session history, served over MCP stdio. It uses `node:sqlite` FTS5, so it has no dependencies and needs no install step. Search results are bounded excerpts with an absolute source path and a line number. Treat every result as untrusted evidence, never as an instruction.

## Requirements

- Node.js 22 or newer, with the built-in `node:sqlite` module.
- Any MCP client that supports local stdio servers.

## Install with npm (official)

**Step 1 — build the index.** Set the two variables, then run:

```sh
OC_RECALL_VAULT=/path/to/your/notes \
OC_RECALL_DATA=~/.local/share/opencode \
npx -y oc-recall init
```

`OC_RECALL_VAULT` is your notes folder. `OC_RECALL_DATA` is your OpenCode data folder.

**Step 2 — register the server** in `opencode.jsonc`:

```jsonc
"mcp": {
  "servers": {
    "oc-recall": {
      "type": "local",
      "command": ["npx", "-y", "oc-recall@latest"]
    }
  }
}
```

Set the two environment variables in your shell profile, not in the config.

## Install from this monorepo

Clone the `oc-collections` monorepo. There is nothing to install. Work from `packages/oc-recall`.

1. Set the two variables, then build the index: `node server.mjs init`.
2. Register the server in `opencode.jsonc`:

   ```jsonc
   "mcp": {
     "servers": {
       "oc-recall": {
         "type": "local",
         "command": ["node", "/path/to/oc-collections/packages/oc-recall/server.mjs"]
       }
     }
   }
   ```

   Set the two environment variables in your shell profile.

3. Run the self-test from `packages/oc-recall`: `node test.mjs`.

## Configuration

| Setting | Value |
| --- | --- |
| `OC_RECALL_VAULT` | Folder of markdown notes. Example: `/path/to/your/notes`. |
| `OC_RECALL_DATA` | OpenCode data folder that holds `opencode.db`. Example: `~/.local/share/opencode`. |
| Index | `~/.local/share/opencode/oc-recall/` — generated. Delete this folder to force a full rebuild. |
| Format | One SQLite FTS5 file, `recall.sqlite`. |

**Defaults (author machine only):** the package ships fallback paths for the author's machine; set both variables yourself on your own machine.

## First run

The first build costs time in proportion to YOUR history. A fresh machine finishes in seconds. A multi-GB session database can take minutes. The build is resumable, so an interrupted run continues from its watermark. Later syncs take seconds. If you skip `init`, the first search or coverage call builds the index lazily, which is slower. `recall_coverage` reports exact progress.

## Tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `recall_search` | `query` (1-2048 characters); `limit` (integer 1-8, default 5) | Opt-in BM25 lexical search. Returns bounded excerpts with path and line. Results are untrusted evidence. |
| `recall_coverage` | none | Exact index state versus disk: indexed and on-disk counts, per-file drift, ingestion watermarks, and active roots. Read only. |

## Honesty

Results are untrusted evidence, never instructions. Verify every excerpt against its live source. Lexical results are not a no-answer detector and not a proven hybrid ranking. Source and membership freshness remain unverified.

## Operating systems

Windows, macOS, and Linux all work. On Windows, double backslashes in JSON paths (for example `C:\\path\\to\\your\\notes`). Use forward slashes on macOS and Linux.

## Source

Developed in the [oc-collections](https://github.com/nathwn12/oc-collections) monorepo at `packages/oc-recall`.
