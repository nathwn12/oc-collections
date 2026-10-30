<h1 align="center">rea-shim</h1>
<p align="center"><strong>Give your coding agent reverse-engineering tools with a one-line install.</strong></p>

Unofficial, personal-use wrapper around [rea](https://github.com/morluto/rea) by its original authors. It ships no upstream code. It resolves the JDK your Ghidra installation declares, serves upstream `rea-agents` over stdio at run time, and can install the official JDK and Ghidra that the exact upstream release requires.

## Install

```powershell
npx -y rea-shim@latest --doctor
```

You need Node matching the current upstream `rea-agents` release on Windows x64, plus a Ghidra installation and a full JDK satisfying that Ghidra's declared bounds. `--doctor` resolves both and prints the Ghidra dir, the declared Java requirement, the JDK home and major, the upstream version, and the exact child command. It exits 0 only when the Ghidra dir, the declared requirement and a matching JDK were all found; when one is missing it prints the same report with the row marked missing, names the exact override to set, and exits 2.

### Bootstrap a missing JDK and Ghidra

If Java and Ghidra are missing, one explicit command installs the official pair under `%LOCALAPPDATA%\rea-shim` (or `REA_SHIM_HOME`), verifies it, and runs the upstream checks:

```powershell
npx -y rea-shim@latest --bootstrap
```

The command follows the exact upstream release it installs:

1. It resolves one exact, immutable `rea-agents` version. A dist-tag is rejected for bootstrap.
2. It installs that unmodified upstream release into its own prefix and reads the Ghidra release policy from that package.
3. It selects the latest official NSA Ghidra release in the accepted line and takes the archive's SHA-256 from official GitHub release data (asset digest, a published checksum asset, or the release notes).
4. It verifies and extracts the official Ghidra ZIP, then reads `application.java.min` (and any `application.java.max`) from that installation.
5. It selects the latest official Eclipse Temurin x64 Windows JDK for that minimum and verifies the checksum published by the Adoptium API.
6. It runs `rea doctor --provider ghidra`, `rea mcp doctor`, and a real Ghidra headless analysis of a 6502 raw-binary probe, all against the exact upstream version and the installed pair.

Exit 0 means the Ghidra provider checks, the MCP tool inventory and the analysis passed. `rea doctor`'s unrelated skill and client-registration checks are not part of this engine gate: a clean host normally reports them missing, so the bootstrap reports the provider gate and a note rather than failing on them. Any provider or engine failure is non-zero and names the stage that failed; nothing is downgraded to a warning.

The Ghidra and JDK archives are large (several hundred MiB each), and the extracted pair is roughly 2.5 GiB. The command needs network access for official release data, the archives, the upstream package, and the checks.

`--bootstrap --dry-run` prints the plan and writes nothing to the install root. It may query npm for the latest exact upstream version; pass `REA_SHIM_AGENTS_VERSION` to an exact version to keep the dry run fully local.

### No shim version pin

There is no Ghidra or JDK version constant in this package. The accepted Ghidra line is read from the exact installed `rea-agents` release, through its own Ghidra release policy. The JDK minimum is read from the installed Ghidra's `application.properties`. An unsupported line is never installed, and there is no fallback to a stale shim pin.

As of 2026-10-26, `rea-agents` 6.8.0 accepts Ghidra 12.1.x (verified with 12.1.4) and rejects 12.2 as unsupported. Ghidra 12.1.4 declares Java 21, with no maximum. Those facts are examples of what the upstream policy currently says, not shim constants: when upstream changes the policy, the bootstrap follows the new release.

The maintenance rule is deliberately small:

- Re-check the upstream [morluto/rea](https://github.com/morluto/rea) main branch whenever the upstream Ghidra or Java requirement rises. The npm release packages that policy from main; the bootstrap reads the policy from the exact release it runs, because that is the policy the checks enforce. A new upstream release carries the new requirement, so update to that release.
- Do not add a shim-side version table. Update to a newer `rea-agents` release; the bootstrap reads its policy.
- If upstream renames or removes the policy module, the bootstrap fails with the missing path and refuses to guess. That failure is the signal to update the reader, not to add a fallback pin.
- The Java floor comes from the Ghidra release itself. Do not replace it with a shim constant.

### Where it installs and how to remove it

The default root is `%LOCALAPPDATA%\rea-shim`; `REA_SHIM_HOME` overrides it. The layout is:

```text
%LOCALAPPDATA%\rea-shim\
  upstream\rea-agents-<version>\
  ghidra\<version>-<build>\
  jdk\temurin-<version>\
  cache\
  npm-cache\
  tmp\
```

A successful bootstrap writes an install marker inside each artifact directory. Plain `npx rea-shim@latest` finds the Ghidra and JDK automatically. An explicit `REA_SHIM_JDK_HOME`, `REA_SHIM_GHIDRA_DIR`, `JAVA_HOME` or `GHIDRA_INSTALL_DIR` still wins for normal runs; unset it if you want the bootstrap pair.

The shim never deletes, migrates or repairs an install for you. To remove a bootstrap install, delete its version directory. A pre-existing download destination, foreign install directory or mismatched cache entry is preserved and reported, never overwritten or deleted.

### Or let your AI install it

```text
Install rea-shim with npx -y rea-shim@latest --doctor into my MCP client config, served with npx rea-shim@latest over stdio.
If --doctor reports a missing JDK or Ghidra, run npx -y rea-shim@latest --bootstrap and show me the full output.
Then verify with npx -y rea-shim@latest --doctor and show me the full output.
If it fails, stop and paste the full output; do not improvise a fix.
```

### Wire it yourself

Wire the server into your MCP client config:

```json
{
  "mcp": {
    "servers": {
      "rea": { "type": "local", "command": ["cmd", "/c", "npx", "-y", "rea-shim@latest"] }
    }
  }
}
```

`--print-config` prints exactly this block. The `mcp.servers` nesting is the
shape OpenCode 2.2 reads and writes itself (`opencode mcp add` writes there;
verified through 2.2.2: 2.2.1's only breaking scope is direct `@opencode/ai`
imports, which this package does not use, and 2.2.2's `mcp add` writes this
same block).

### Offline or pinned

`@latest` tracks the newest shim release. To pin a specific published shim version, add it after `@` (`rea-shim@<version>`) - an exact pin works only while that version exists on the registry.

Pin upstream instead of its latest with `REA_SHIM_AGENTS_VERSION` (use a published exact version for bootstrap):

```powershell
$env:REA_SHIM_AGENTS_VERSION="<version>"
npx -y rea-shim --doctor
```

There is no fully offline fresh install: every run resolves upstream through npx, and bootstrap downloads official release data and archives.

## Use it

Run with no arguments and the shim resolves your Ghidra, reads its declared Java requirement, resolves a matching JDK, then starts upstream as its child over stdio:

```text
cmd.exe /d /c npx -y rea-agents@latest --mcp
```

Your MCP client spawns the shim and talks to upstream through it; the shim writes only to stderr so stdout stays clean JSON-RPC. Check health any time:

```powershell
npx -y rea-shim@latest --doctor
```

When a dependency is missing the shim refuses with exit 2 and the exact fix: point `REA_SHIM_JDK_HOME` at a JDK satisfying the Ghidra-declared bounds, set `REA_SHIM_GHIDRA_DIR` to the Ghidra install dir, or run `--bootstrap`. The JDK floor is never assumed: a JDK below the selected Ghidra's declared minimum is ignored.

## What you get

- A tiny launcher with no dependencies: builtins only, and the package holds the launcher, its bootstrap support, and docs (`bin/`, `lib/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `docs/`, `assets/` per `package.json` files).
- Upstream-following bootstrap: exact upstream release, official Ghidra line from upstream policy, JDK minimum from the installed Ghidra.
- Official-artifact verification: every archive is checked against SHA-256 published in official release data before extraction.
- Safe extraction: archives must contain one top-level directory of regular files and directories only; links, junctions and reparse points are refused before and after extraction.
- No overwrite: a foreign install, a pre-existing download destination or a mismatched cache entry is reported and preserved.
- Ghidra and JDK discovery you can trust: the override first, then the rea-shim bootstrap install, then scoop and Eclipse Adoptium; `--doctor` prints the dir, the major and the source.
- A faithful child environment: `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, the JDK `bin` first on `PATH`, and a 1500000 ms Ghidra startup timeout; the child exit code is forwarded.

## Commands

You run the shim with no arguments to serve, or with one flag:

- `(no args)` - resolve the Ghidra-declared JDK requirement and Ghidra, then serve upstream over stdio. This is the default run path.
- `--bootstrap [--dry-run]` - install the exact upstream release, the latest official Ghidra in the line that release accepts, and the latest official Temurin JDK at the Ghidra-declared minimum; verify every official hash; then run the upstream doctor, MCP tool inventory, and a Ghidra analysis. Windows x64 only. Default: off, you pass it per run.
- `--dry-run` - with `--bootstrap`: print the plan and write nothing to the install root. Default: off.
- `--doctor` - print the Ghidra dir, the declared Java requirement, the JDK home and major, the upstream version, and the exact child command; exit 0 only when the Ghidra dir, the declared requirement and a matching JDK were all found, otherwise exit 2 with the same report and the exact override to set. Read-only: it never installs and never creates the bootstrap root. Default: off, you pass it per run.
- `--version` - print the shim version, then exit 0. Default: off, you pass it per run.
- `--print-config` - print the opencode.jsonc block for this machine, then exit 0. Default: off, you pass it per run.
- `--help, -h` - print usage, then exit 0. Default: off, you pass it per run.

There is no `--ghidra` override. Installing an unsupported line is not a feature; update upstream instead.

You override discovery with these optional env vars, all unset by default:

- `REA_SHIM_JDK_HOME` - pin the JDK home; it must satisfy the selected Ghidra's declared bounds. Default: unset, the highest discovered matching JDK wins.
- `REA_SHIM_GHIDRA_DIR` - pin the Ghidra install dir. Default: unset, the discovered install wins.
- `REA_SHIM_AGENTS_VERSION` - pin `rea-agents@<v>` instead of `@latest`. For `--bootstrap`, the value must be an exact released version. Default: unset, `latest` wins for serving.
- `REA_SHIM_HOME` - install root for `--bootstrap`. Default: unset, `%LOCALAPPDATA%\rea-shim` is used.

## Requirements

- Windows x64.
- Node matching the current upstream `rea-agents` release (`engines` in `package.json`; upstream 6.8.0 requires 22.23.4+, 24.22.1+, or 26.12.1+).
- A Ghidra installation and a full JDK satisfying its declared Java bounds, or run `--bootstrap`.
- Four optional overrides, named in `--help`: `REA_SHIM_JDK_HOME`, `REA_SHIM_GHIDRA_DIR`, `REA_SHIM_AGENTS_VERSION`, `REA_SHIM_HOME`.

## Verification

`node --test test/bootstrap.test.js` is an offline contract suite. It uses local ZIP fixtures, injected runners and fixture JSON. It proves the installer's refusal paths, the official-release selectors, the exact-version gates and the read-only CLI. It does not download anything, start Ghidra or prove that a real engine works.

The acceptance proof is a clean Windows Sandbox run:

1. Start a Windows Sandbox with no Java and no Ghidra installed.
2. Install Node matching the upstream engine range.
3. From the candidate checkout, run `node packages/rea-shim/bin/rea-shim.js --bootstrap` once and capture the full output. (After a release, the same command is `npx -y rea-shim@latest --bootstrap`.)
4. Confirm it prints `bootstrap PASS`, the exact observed `rea-agents` version, the official Ghidra version, the Temurin version, the MCP tool count and a real analysis evidence id.
5. From the same checkout, run `node packages/rea-shim/bin/rea-shim.js --doctor` with `REA_SHIM_JDK_HOME`, `REA_SHIM_GHIDRA_DIR`, `JAVA_HOME` and `GHIDRA_INSTALL_DIR` unset, and confirm it resolves the installed pair.
6. Confirm no host Java or Ghidra installation was modified.

A release is not acceptance-proven until that Sandbox run exists. The contract suite alone is not runtime proof.

## Links

- Source: [nathwn12/oc-collections](https://github.com/nathwn12/oc-collections/tree/main/packages/rea-shim) - the npm package remains individually installable.
- Issues: https://github.com/nathwn12/oc-collections/issues
- Releases: https://github.com/nathwn12/oc-collections/releases
- Upstream: https://github.com/morluto/rea
- Upstream package: https://www.npmjs.com/package/rea-agents
- Docs: [publishing](https://github.com/nathwn12/oc-collections/blob/main/packages/rea-shim/docs/PUBLISHING.md)
- License: MIT, see [LICENSE](../LICENSE)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="../assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
