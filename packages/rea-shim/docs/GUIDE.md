<h1 align="center">rea-shim</h1>
<p align="center"><strong>Give your coding agent reverse-engineering tools with a one-line install.</strong></p>

Unofficial, personal-use wrapper around [rea](https://github.com/morluto/rea) by its original authors. It ships no upstream code: it resolves your JDK and Ghidra installs, then serves upstream `rea-agents` over stdio at run time.

## Install

```powershell
npx -y rea-shim@latest --doctor
```

You need Node 22.14 or newer on Windows x64, plus a JDK 21+ and Ghidra, first. The first run resolves both, then `--doctor` prints the JDK home and java major, the Ghidra dir, the upstream version, and the exact child command, and exits 0.

### Or let your AI install it

```text
Install rea-shim with npx -y rea-shim@latest --doctor into my MCP client config, served with npx rea-shim@latest over stdio.
Then verify with npx -y rea-shim@latest --doctor and show me the full output.
If it fails, stop and paste the full output; do not improvise a fix.
```

### Wire it yourself

Wire the server into your MCP client config:

```json
{
  "mcpServers": {
    "rea": { "type": "local", "timeout": { "startup": 45000 }, "command": ["cmd","/c","npx","-y","rea-shim@latest"] }
  }
}
```

### Offline or pinned

`@latest` tracks the newest release. To pin a specific published shim version, add it after `@` (`rea-shim@<version>`) — an exact pin works only while that version exists on the registry.

Pin upstream instead of its latest with `REA_SHIM_AGENTS_VERSION` (use a published `rea-agents` version):

```powershell
$env:REA_SHIM_AGENTS_VERSION="<version>"
npx -y rea-shim --doctor
```

There is no fully offline fresh install: every run resolves upstream through npx, so treat these as pins, not as a no-network setup.

## Use it

Run with no arguments and the shim resolves your JDK and Ghidra, then starts upstream as its child over stdio:

```text
cmd.exe /d /c npx -y rea-agents@latest --mcp
```

Your MCP client spawns the shim and talks to upstream through it; the shim writes only to stderr so stdout stays clean JSON-RPC. Check health any time:

```powershell
npx -y rea-shim@latest --doctor
```

When a dependency is missing the shim refuses with exit 2 and the exact fix: point `REA_SHIM_JDK_HOME` at a JDK 21+ home, or set `REA_SHIM_GHIDRA_DIR` to the Ghidra install dir. A `JAVA_HOME` below 21 is ignored on purpose.

## What you get

- A tiny launcher with no dependencies: builtins only, and the package holds the launcher plus docs (`bin/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `docs/`, `assets/` per `package.json` files).
- JDK discovery you can trust: the override first, then installed JDKs, highest java major 21 or newer wins; `--doctor` prints the home, the major, and the source.
- Ghidra discovery with the same shape: the override first, then existing installs; `--doctor` prints the dir and the source.
- A faithful child environment: `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, the JDK `bin` first on `PATH`, and a 1500000 ms Ghidra startup timeout; the child exit code is forwarded.

## Commands

You run the shim with no arguments to serve, or with one flag:

- `(no args)` — resolve your JDK and Ghidra, then serve upstream over stdio. This is the default run path.
- `--doctor` — print the JDK home and java major, the Ghidra dir, the upstream version, and the exact child command, then exit 0. Default: off, you pass it per run.
- `--version` — print the shim version, then exit 0. Default: off, you pass it per run.
- `--print-config` — print the opencode.jsonc block for this machine, then exit 0. Default: off, you pass it per run.
- `--help, -h` — print usage, then exit 0. Default: off, you pass it per run.

You override discovery with three optional env vars, all unset by default:

- `REA_SHIM_JDK_HOME` — pin the JDK home, must be java 21 or newer. Default: unset, the highest discovered JDK 21 or newer wins.
- `REA_SHIM_GHIDRA_DIR` — pin the Ghidra install dir. Default: unset, the discovered install wins.
- `REA_SHIM_AGENTS_VERSION` — pin `rea-agents@<v>` instead of `@latest`. Default: unset, `latest` wins.

## Requirements

- Node 22.14 or newer (`engines` in `package.json`; `--doctor` ran on v24.22.0).
- Windows x64.
- JDK 21 or newer (`--doctor` resolved java major 21; anything below 21 is refused).
- Ghidra (`--doctor` resolved the install dir).
- Three optional overrides, named in `--help`: `REA_SHIM_JDK_HOME`, `REA_SHIM_GHIDRA_DIR`, `REA_SHIM_AGENTS_VERSION`.

## Links

- Source: [nathwn12/oc-collections](https://github.com/nathwn12/oc-collections/tree/main/packages/rea-shim) — the npm package remains individually installable.
- Issues: https://github.com/nathwn12/oc-collections/issues
- Releases: https://github.com/nathwn12/oc-collections/releases
- Upstream: https://github.com/morluto/rea
- Upstream package: https://www.npmjs.com/package/rea-agents
- Docs: [publishing](PUBLISHING.md)
- License: MIT, see [LICENSE](../LICENSE)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="../assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
