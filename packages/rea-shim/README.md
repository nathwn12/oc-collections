# rea-shim

Gives your coding agent reverse-engineering tools with a one-line MCP install.

## Install

```powershell
npx -y rea-shim@latest --doctor
```

The first `--doctor` run resolves your Ghidra installation, reads the JDK requirement that installation declares, finds a matching JDK, prints what it found, and exits 0. Point your MCP client at the same command with no flag to serve, or run `--print-config` for the block written out for this machine.

No Java or Ghidra yet? One explicit command installs exactly what the current upstream REA release requires:

```powershell
npx -y rea-shim@latest --bootstrap
```

It reads the accepted Ghidra release line from the exact upstream `rea-agents` release it installs, picks the latest official NSA Ghidra release in that line, verifies the SHA-256 published by the official release, reads the JDK minimum from that Ghidra's `application.properties`, installs the latest official Eclipse Temurin JDK for that minimum, and verifies the checksum published by Adoptium. There is no shim version table and no fallback to an unsupported Ghidra line.

It writes its install and npm cache under `%LOCALAPPDATA%\rea-shim` by default (or `REA_SHIM_HOME`); the upstream checks may use their own temporary files. It never overwrites an existing install, and never changes `JAVA_HOME`, `PATH`, or a host JDK or Ghidra installation. `--doctor` stays read-only.

## What it does

- Follows upstream, not a shim pin: the Ghidra line comes from the exact `rea-agents` release's own release policy, and the JDK floor comes from the installed Ghidra's `application.properties`.
- Installs unmodified official archives on request, verifies their published hashes, and refuses an unsupported line or an unverifiable artifact.
- Finds the JDK satisfying the selected Ghidra and serves upstream `rea` over stdio.
- Refuses with exit 2 and the exact override to set when a dependency is missing.
- Prints the Ghidra dir, the declared Java requirement, the JDK home and major, the upstream version, and the exact child command.
- Keeps stdout clean for JSON-RPC and forwards the child exit code.
- Ships no upstream code: it resolves the upstream agents at run time. An explicit `--bootstrap` installs the exact upstream release into its own install root for the checks.
- Its test suite is an offline contract suite. Runtime acceptance is a clean Windows Sandbox run, documented in the guide; the tests never claim an engine was exercised.

## Requirements

- Windows x64.
- Node matching the current upstream `rea-agents` release: check its `engines` field when it changes (6.8.0 declares 22.23.4+, 24.22.1+, or 26.12.1+; this package's `engines` matches that range).
- A Ghidra installation and a full JDK satisfying that Ghidra's declared bounds, or run `--bootstrap`.

## Full documentation

- Guide: <https://github.com/nathwn12/oc-collections/blob/main/packages/rea-shim/docs/GUIDE.md>
- Package: <https://www.npmjs.com/package/rea-shim>

The guide covers the MCP config block to paste, the discovery overrides, how the bootstrap follows upstream release data, and the clean-Sandbox acceptance procedure. It also links the upstream project, the upstream package, and the licence.
