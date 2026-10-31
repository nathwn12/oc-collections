# rea-shim

A one-line MCP launcher that serves upstream `rea` reverse-engineering tools over stdio, and can install the exact JDK and Ghidra that upstream release requires.

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

## What you get

| Capability | What it does for you |
| --- | --- |
| One-line launcher | Resolves your Ghidra and a matching JDK, then serves upstream `rea` over stdio as its child. |
| `--doctor` | Prints node, the Ghidra dir, the declared Java requirement, the JDK home and major, the upstream version, and the exact child command — read-only, exit `0` or `2`. |
| `--print-config` | Prints the `opencode.jsonc` block for this machine, byte for byte what your client reads. |
| `--bootstrap` | Installs the exact upstream release, the Ghidra line it declares, and the JDK that Ghidra needs. The only mutating command. |
| Follows upstream | Takes the Ghidra line from the exact installed upstream release's own policy and the JDK floor from the installed Ghidra, with no shim version table. |
| Verified artifacts | Checks every archive against the SHA-256 published in official release data before extracting it. |
| Safe extraction | Refuses an archive without one top-level directory, and refuses links, junctions and reparse points before and after extraction. |
| Never overwrites | A foreign install, a pre-existing download destination or a mismatched cache entry is reported and preserved. |
| Ships no upstream code | Resolves the upstream agents at run time; nothing of theirs is vendored here. |

## Requirements

Windows x64, with Node matching the current upstream `rea-agents` release, plus a Ghidra install and a full JDK satisfying that Ghidra's declared bounds — or run `--bootstrap`.

## Going deeper

The manual at <https://github.com/nathwn12/oc-collections/blob/main/packages/rea-shim/docs/GUIDE.md> covers every command and exit code, the four environment variables, what `--bootstrap` installs and verifies, the discovery order, and what the package deliberately does not ship.

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
