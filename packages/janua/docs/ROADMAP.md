# janua roadmap

Locked scope for the next two releases. Nothing here is started: 0.5 is a plan, not a work log.

## 0.5 — daemon + reattach

A long-lived `janua serve` owns the PTYs and listens on a local socket: a Windows named pipe,
a Unix domain socket elsewhere. The MCP server and the CLI become clients of that daemon instead of
owning sessions themselves, so a session survives a restart of the agent, the model, or the harness.

- `janua list` prints the live sessions; `janua attach <name>` attaches to one.
- Several seats (agents, terminals, harnesses) can share one session.
- Crash recovery: a client reconnects and finds its sessions still there.

Costs and risks: daemon lifecycle (start, stop, upgrade, orphan), stale socket files, socket
permissions, write arbitration when several clients type into one PTY, and version skew between a
client and an older or newer daemon.

## 0.5 — MCP gateway

`mcp_start` / `mcp_list` / `mcp_call` / `mcp_stop` launch any stdio MCP server, list its tools,
forward calls to them, and namespace them by server. One janua mount then gives a barebones harness
every MCP it needs, and servers are added or removed at runtime without editing harness config.

Costs and risks: faithful schema and result passthrough, tool-name collisions across servers,
auth and environment for child servers, child lifecycle and cleanup, error mapping back to the
caller, and janua becoming a trusted gateway for everything behind it.

## Order

Daemon first, then gateway: the gateway's session-like children want the daemon to own them.
0.4 (`run`, names, CLI) is the prerequisite for both. Neither is started.
