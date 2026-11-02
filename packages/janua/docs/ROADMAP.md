# janua roadmap

Locked scope for 0.5. Nothing here is started: 0.5 is a plan, not a work log.

## 0.5 — self-upgrade and lockout prevention

- A global `janua` install is never uninstalled before its replacement is installed and proven. `janua upgrade` stages the new version in a versioned directory, verifies `janua --version` and one real `janua run` from the staged binary, then switches the command shim atomically; the old version stays until the new one answers, and a failed switch rolls back.
- Windows can hold a live package open through a running MCP server or daemon. The upgrade must not overwrite a live package in place: stop only the old adapter or defer the shim switch, never the MCP client/service process, and handle EBUSY/EPERM as a typed refusal with the recovery step.
- Once the daemon owns sessions, upgrading the daemon does not kill them; clients reconnect after the shim switch.
- Install rule: the command layer is never uninstalled; shell remains the fallback until the new binary answers. A self-lockout is an install defect, not a janua outage.

## 0.5 — daemon + reattach

A long-lived `janua serve` owns the PTYs and listens on a local socket: a Windows named pipe,
a Unix domain socket elsewhere. The MCP server and the CLI become clients of that daemon instead of
owning sessions themselves, so a session survives a restart of the agent, the model, or the harness.

- `janua list` prints the live sessions; `janua attach <name>` attaches to one.
- Several clients (agents, terminals, other harnesses) can share one session.
- Crash recovery: a client reconnects and finds its sessions still there.

Costs and risks: daemon lifecycle (start, stop, upgrade, orphan), stale socket files, socket
permissions, write arbitration when several clients type into one PTY, and version skew between a
client and an older or newer daemon.

## 0.5 — MCP gateway

`mcp_start` / `mcp_list` / `mcp_call` / `mcp_stop` launch any stdio MCP server, list its tools,
forward calls to them, and namespace them by server. One janua mount then gives a barebones harness
every MCP it needs, and servers are added or removed at runtime without editing client config.

Any stdio MCP server works; no specific session model is required.

Costs and risks: faithful schema and result passthrough, tool-name collisions across servers,
auth and environment for child servers, child lifecycle and cleanup, error mapping back to the
caller, and janua becoming a trusted gateway for everything behind it.

## Order

Self-upgrade first, then daemon, then gateway: self-upgrade protects the command layer before
anything else changes it, and the gateway's session-like children want the daemon to own them.
0.4 (`run`, names, CLI) is the prerequisite for all three. None is started.
