# Host tools

A tool is native only when this file lists it: installed, named, and reachable by the agent that needs it. Installing a tool without adding it here is incomplete work.

## Registered

| Tool | Purpose | Who uses it |
|---|---|---|
| `git` | version control, diffs, history | any shell-bearing seat |
| `node` | run JavaScript, parse JSON, drive npm tooling | `code-agent`, `host-agent`, `verify-agent` |
| `python` | scripts the owner requests, one-off data work | `code-agent`, `host-agent` |
| `rg` | recursive regex search when the `grep` tool is too coarse | `code-agent`, `host-agent`, `verify-agent` |
| `jq` | exact JSON querying: config, payloads, manifests | any shell-bearing seat |
| `ast-grep` | structural search and rewrite across code | `code-agent`, `verify-agent` |
| `difft` | structural diff for reviewing a large change: `--display inline --exit-code` | `verify-agent` |
| `lychee` | verify that documentation URLs still resolve: `--no-progress --cache` | `code-agent` |
| `PSScriptAnalyzer` | lint a PowerShell script written as an owner deliverable | `code-agent` |
| `Pester` | test that script: `Invoke-Pester -CI` | `code-agent` |
| `opencode api` | request the local server directly, using stored discovery and auth: `GET /api/session/active` lists live lanes; `POST /api/session/<id>/interrupt?resume=false` stops one; `POST /api/session/<id>/prompt` steers or queues. Body flag is `--data`, never `--body` | `host-agent` |
| `opencode service status` | prints the running server address | `host-agent` |

- The default session has no shell: it routes `opencode api` work through `host-agent`.

## Installing

- Installation is `host-agent` work and the brief names the package. Installing is ingress; the outward gate is unchanged.
- Add the row here in the same brief that installs it. A tool that is installed but unlisted is not native — a cold session will never reach for it.
- Remove a row when its tool is uninstalled; a stale row is a dangling reference.
- A tool earns its row by serving a named need. A tool with no named need is not installed, however good it is.
- This pack ships no server and no extension: a bare install has only OpenCode's built-in tools, and every row above is something the user adds deliberately.

## Considered and rejected

- `markdown-link-check` — redundant with `lychee`, which caches and runs offline.
- LLM-driven deny hooks — read for reference only; a nondeterministic decision proves the hook exists without being a guard to rely on.
- A second page-driving tool — rejected where it duplicates the repo's own browser gate.
