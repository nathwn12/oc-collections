<h1 align="center">rea-shim</h1>

<p align="center"><strong>A one-line MCP launcher for upstream rea, with an optional bootstrap for its exact JDK and Ghidra.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/rea-shim"><img src="https://img.shields.io/npm/v/rea-shim" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-windows--64bit-2b3137?logo=windows&amp;logoColor=white" alt="platform">
  <a href="https://github.com/nathwn12/oc-collections/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

## Why

Upstream `rea` needs a matching Ghidra and JDK, and a wrong pair wastes an afternoon. `rea-shim` resolves them from the installed upstream release's own policy — there is no shim version table to go stale. It serves the upstream agents over stdio without vendoring their code, and verifies every archive against the SHA-256 in official release data before extracting it.

Extraction refuses an archive without one top-level directory and rejects links, junctions and reparse points before and after the fact. A foreign install or a mismatched cache entry is reported and preserved, never overwritten.

## Install

```powershell
npx -y rea-shim@latest --doctor
```

Point your MCP client at the same command with no flag to serve. `--print-config` prints the finished block for this machine:

```jsonc
{
  "mcp": {
    "servers": {
      "rea": {
        "type": "local",
        "command": ["cmd", "/c", "npx", "-y", "rea-shim@latest"]
      }
    }
  }
}
```

## Use

- `--doctor` prints node, the Ghidra dir, the declared Java requirement, the JDK home and major, the upstream version, and the exact child command. It is read-only and exits `0` or `2`.
- `--print-config` prints the `opencode.jsonc` block for this machine, byte for byte what your client reads.
- `--bootstrap` installs the exact upstream release, the Ghidra line it declares, and the JDK Ghidra needs. This is the only mutating command.

With no flag, the shim serves upstream `rea` over stdio as its child.

## Configure

No config file. The command line is the surface. `--bootstrap` derives the Ghidra line and the JDK floor from the installed upstream release, so there is nothing to pin by hand. The environment variables are listed in the guide.

## Requirements

- Windows x64.
- Node matching the current upstream `rea-agents` release.
- A Ghidra install and a full JDK satisfying that Ghidra's declared bounds, or run `--bootstrap` to install both.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Guide](https://github.com/nathwn12/oc-collections/blob/main/packages/rea-shim/docs/GUIDE.md)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)

<p align="center"><sub>Built by nathwn12</sub></p>
