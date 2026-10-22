# rea-shim

Gives your coding agent reverse-engineering tools with a one-line MCP install.

## Install

```powershell
npx -y rea-shim@latest --doctor
```

The first run resolves your JDK and Ghidra, prints what it found, and exits 0. Point your MCP client at the same command with no flag to serve, or run `--print-config` for the block written out for this machine.

## What it does

- Finds a JDK 21 or newer and your Ghidra install, then serves upstream `rea` over stdio.
- Refuses with exit 2 and the exact override to set when a dependency is missing.
- Prints the JDK home and major, the Ghidra dir, the upstream version, and the exact child command.
- Keeps stdout clean for JSON-RPC, and forwards the child exit code.
- Ships no upstream code: it resolves the upstream agents at run time.

## Requirements

Windows x64, with Node 22.14 or newer, plus a JDK 21 or newer and Ghidra.

## Full documentation

- Guide: <https://github.com/nathwn12/oc-collections/blob/main/packages/rea-shim/docs/GUIDE.md>
- Package: <https://www.npmjs.com/package/rea-shim>

The guide covers the MCP config block to paste, the three discovery overrides, and what `--doctor` verifies. It also links the upstream project, the upstream package, and the licence.
