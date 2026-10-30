<h1 align="center">rea-shim</h1>
<p align="center"><strong>Gives your coding agent reverse-engineering tools with a one-line MCP install.</strong></p>

## Install

```powershell
npx -y rea-shim@latest --doctor
```

The first `--doctor` run resolves your Ghidra installation, reads the JDK requirement that installation declares, finds a matching JDK, and prints what it found. It exits 0 only when both were found; when the Ghidra install is missing or unreadable, or no JDK satisfies the requirement that Ghidra declares, it prints the same report, names the exact override to set, and exits 2. Point your MCP client at the same command with no flag to serve.

### Wire it yourself

`--print-config` prints the block for this machine, ready to paste into your `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "servers": {
      "rea": {
        "type": "local",
        "command": [
          "cmd",
          "/c",
          "npx",
          "-y",
          "rea-shim@latest"
        ]
      }
    }
  }
}
```

No Java or Ghidra yet? One explicit command installs exactly what the current upstream REA release requires:

```powershell
npx -y rea-shim@latest --bootstrap
```

`--bootstrap` reads the accepted Ghidra release line from the exact upstream `rea-agents` release it installs, picks the latest official NSA Ghidra release in that line, verifies the SHA-256 published by the official release, reads the JDK minimum from that Ghidra's `application.properties`, installs the latest official Eclipse Temurin JDK for that minimum, and verifies the checksum published by Adoptium. There is no shim version table and no fallback to an unsupported Ghidra line. Add `--dry-run` to print the plan and write nothing to the install root; the upstream version lookup may still use npm's own metadata cache.

## What it does

- Follows upstream, not a shim pin: the Ghidra line comes from the exact `rea-agents` release's own release policy, and the JDK floor comes from the installed Ghidra's `application.properties`.
- Installs unmodified official archives on request, verifies their published hashes, and refuses an unsupported line or an unverifiable artifact.
- Finds the JDK satisfying the selected Ghidra and serves upstream `rea` over stdio.
- Refuses with exit 2 and the exact override to set when a dependency is missing.
- Prints the Ghidra dir, the declared Java requirement, the JDK home and major, the upstream version, and the exact child command.
- Keeps stdout clean for JSON-RPC and forwards the child exit code.
- Ships no upstream code: it resolves the upstream agents at run time. An explicit `--bootstrap` installs the exact upstream release into its own install root for the checks.
- Its test suite is an offline contract suite. Runtime acceptance is a clean Windows Sandbox run, documented in the guide; the tests never claim an engine was exercised.

## Configure it

Five commands, then four variables. Every one of them is optional except the first.

| Command | What it does |
|---|---|
| *(no flag)* | Serves upstream `rea` over stdio. This is what your MCP client runs. |
| `--doctor` | Prints node, the resolved Ghidra dir, the declared Java requirement, the JDK home and major, the upstream version, and the exact child command. Read-only: it never installs and never creates the bootstrap root. Exits 0 with a complete report, or 2 naming the override to set when the Ghidra dir, the requirement, or a matching JDK is missing. |
| `--print-config` | Prints the `opencode.jsonc` block for this machine, byte for byte what your MCP client reads. |
| `--bootstrap` | Installs the exact upstream `rea-agents` release, the Ghidra line it declares, and the JDK that Ghidra needs. Explicit, and the only mutating command. `--dry-run` prints the plan and writes nothing to the install root. |
| `--version`, `--help` | Print the shim version, or the usage block. |

| Variable | Default | What it decides |
|---|---|---|
| `REA_SHIM_HOME` | per-user application-data dir | Where `--bootstrap` installs, and where the npm cache for it lives. |
| `REA_SHIM_GHIDRA_DIR` | discovered automatically | The extracted Ghidra install to serve. Set it when discovery cannot see yours. |
| `REA_SHIM_JDK_HOME` | discovered automatically | The full JDK home to serve with. Set it when discovery cannot see yours. |
| `REA_SHIM_AGENTS_VERSION` | `latest` | Pins an exact upstream `rea-agents` version. `--bootstrap` accepts exact versions only. |

`REA_GHIDRA_STARTUP_TIMEOUT_MS` is not a setting here: the shim always passes `1500000` to the child Ghidra start, so an inherited value has no effect.

`--bootstrap` never overwrites an existing install and never changes `JAVA_HOME`, `PATH`, or a host JDK or Ghidra installation. Anything it does not find is named in an exit-2 message with the override to set, so the recipe is: run `--doctor`, read the fix line, set that one variable, run it again.

## Requirements

- Windows x64.
- Node matching the current upstream `rea-agents` release: its `engines` field is the source of truth, and this package's `engines` tracks that range.
- A Ghidra installation and a full JDK satisfying that Ghidra's declared bounds, or run `--bootstrap`.

## Links

- Guide: <https://github.com/nathwn12/oc-collections/blob/main/packages/rea-shim/docs/GUIDE.md>
- Package: <https://www.npmjs.com/package/rea-shim>
- Releases: <https://github.com/nathwn12/oc-collections/releases>
- Issues: <https://github.com/nathwn12/oc-collections/issues>
- Upstream: <https://github.com/morluto/rea>
- Upstream package: <https://www.npmjs.com/package/rea-agents>
- Licence: <https://github.com/nathwn12/oc-collections/blob/main/LICENSE>

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
