<h1 align="center">rea-shim guide</h1>

Unofficial, personal-use wrapper around [rea](https://github.com/morluto/rea) by its original authors. It ships no upstream code. It resolves the JDK your Ghidra installation declares, serves upstream `rea-agents` over stdio at run time, and can install the official JDK and Ghidra that the exact upstream release requires.

## How it works

**Serving.** With no arguments the shim resolves the Ghidra install, reads the Java requirement that installation declares, resolves a JDK satisfying it, then spawns upstream as its child:

```text
cmd.exe /d /c npx -y rea-agents@latest --mcp
```

Your MCP client spawns the shim and talks to upstream through it. The shim writes only to stderr, so stdout stays clean JSON-RPC, and it forwards the child's exit code. The child environment is set deliberately: `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, the JDK `bin` first on `PATH`, and a `1500000` ms Ghidra startup timeout. `REA_GHIDRA_STARTUP_TIMEOUT_MS` is not a setting: an inherited value has no effect.

**Discovery.** Ghidra and the JDK come from a set of candidate sources, not a fixed precedence order: the `rea-shim` bootstrap install, scoop (`apps/ghidra/current`), and for JDKs `%ProgramFiles%\Eclipse Adoptium`, falling back to `C:\Program Files` when that is unset. Selection sorts the viable candidates by version, highest first. An explicit override is different: `REA_SHIM_GHIDRA_DIR` pins the Ghidra install, and `REA_SHIM_JDK_HOME` is taken when it satisfies the Ghidra-declared bounds. The JDK floor is never assumed — it is read from the selected Ghidra — so a JDK below that minimum is not viable and the highest viable one wins.

**Provisioning, on request only.** `--bootstrap` follows the exact upstream release it installs:

1. It resolves one exact, immutable `rea-agents` version. A dist-tag is rejected for bootstrap.
2. It installs that unmodified upstream release into its own prefix and reads the Ghidra release policy from that package.
3. It selects the latest official NSA Ghidra release in the accepted line and takes the archive's SHA-256 from official GitHub release data — the asset digest, a published checksum asset, or the release notes.
4. It verifies and extracts the official Ghidra ZIP, then reads `application.java.min` (and any `application.java.max`) from that installation.
5. It selects the latest official Eclipse Temurin x64 Windows JDK for that minimum and verifies the checksum published by the Adoptium API.
6. It runs `rea doctor --provider ghidra`, `rea mcp doctor`, and a real Ghidra headless analysis of a 6502 raw-binary probe, all against the exact upstream version and the installed pair.

There is no Ghidra or JDK version constant in this package. The accepted Ghidra line is read from the exact installed `rea-agents` release through its own policy, and the JDK minimum from the installed Ghidra's `application.properties`. An unsupported line is never installed and there is no fallback to a stale shim pin.

As of 2026-10-26, `rea-agents` 6.8.0 accepts Ghidra 12.1.x (verified with 12.1.4) and rejects 12.2 as unsupported; Ghidra 12.1.4 declares Java 21 with no maximum. Those are examples of what the upstream policy currently says, not shim constants: when upstream changes the policy, the bootstrap follows the new release.

**Where a bootstrap install lands.** Default root `%LOCALAPPDATA%\rea-shim`, overridable with `REA_SHIM_HOME`:

```text
%LOCALAPPDATA%\rea-shim\
  upstream\rea-agents-<version>\
  ghidra\<version>-<build>\
  jdk\temurin-<version>\
  cache\
  npm-cache\
  tmp\
```

A successful bootstrap writes an install marker inside each artifact directory. Plain `npx rea-shim@latest` then finds the pair automatically; an explicit `REA_SHIM_JDK_HOME`, `REA_SHIM_GHIDRA_DIR`, `JAVA_HOME` or `GHIDRA_INSTALL_DIR` still wins for normal runs, so unset it if you want the bootstrap pair.

## Configuration

Five commands, then four variables. Every one is optional except the first.

| Command | Default | Effect |
| --- | --- | --- |
| *(no flag)* | — | Serves upstream `rea` over stdio. This is what your MCP client runs. |
| `--doctor` | off | Prints node, the resolved Ghidra dir, the declared Java requirement, the JDK home and major, the upstream version, and the exact child command. Read-only: it never installs and never creates the bootstrap root. |
| `--print-config` | off | Prints the `opencode.jsonc` block for this machine, byte for byte what your MCP client reads. |
| `--bootstrap` | off | Installs the exact upstream release, the Ghidra line it declares, and the JDK that Ghidra needs. Explicit, and the only mutating command. |
| `--version`, `--help` | off | Print the shim version, or the usage block. |

| Variable | Default | Effect |
| --- | --- | --- |
| `REA_SHIM_HOME` | per-user application-data dir | Where `--bootstrap` installs, and where the npm cache for it lives. |
| `REA_SHIM_GHIDRA_DIR` | discovered automatically | The extracted Ghidra install to serve. Set it when discovery cannot see yours. |
| `REA_SHIM_JDK_HOME` | discovered automatically | The full JDK home to serve with. Set it when discovery cannot see yours. |
| `REA_SHIM_AGENTS_VERSION` | `latest` | Pins an exact upstream `rea-agents` version. `--bootstrap` accepts exact versions only. |

`--bootstrap` also takes `--dry-run`, which prints the plan and writes nothing to the install root. The upstream version lookup may still use npm's own metadata cache; pass an exact `REA_SHIM_AGENTS_VERSION` to keep the dry run fully local.

## Commands

Each command below names what it returns and what its exit status means.

| Invocation | Returns | Exit |
| --- | --- | --- |
| `npx -y rea-shim@latest` | A stdio MCP server: upstream's `initialize` and `tools/list` answers pass through | the child's own code |
| `npx -y rea-shim@latest --doctor` | The report rows, one per fact, with a `Fix:` line naming the override to set | `0` when the Ghidra dir, the declared requirement and a matching JDK were all found; `2` otherwise |
| `npx -y rea-shim@latest --print-config` | The `mcp.servers` block for this machine | `0` |
| `npx -y rea-shim@latest --bootstrap` | The stage log, then `bootstrap PASS` with the exact observed versions, the MCP tool count and an analysis evidence id | `0` on pass; non-zero naming the stage that failed |
| `npx -y rea-shim@latest --bootstrap --dry-run` | The plan, and nothing written to the install root | `0` |
| `npx -y rea-shim@latest --version` / `--help` | The version, or the usage block | `0` |

Check health at any time:

```powershell
npx -y rea-shim@latest --doctor
```

A doctor report is a list of resolved facts, not a score. When a dependency is missing the shim refuses with exit `2` and the exact fix: point `REA_SHIM_JDK_HOME` at a JDK satisfying the Ghidra-declared bounds, set `REA_SHIM_GHIDRA_DIR` to the Ghidra install dir, or run `--bootstrap`. The recipe is always the same: run `--doctor`, read the `Fix:` line, set that one variable, run it again.

`--bootstrap` never overwrites an existing install and never changes `JAVA_HOME`, `PATH`, or a host JDK or Ghidra installation. A pre-existing download destination, foreign install directory or mismatched cache entry is preserved and reported, never overwritten or deleted. To remove a bootstrap install, delete its version directory — the shim never deletes, migrates or repairs one for you.

The Ghidra and JDK archives are large (several hundred MiB each), and the extracted pair is roughly 2.5 GiB. `--bootstrap` needs network access for official release data, the archives, the upstream package, and the checks.

## Troubleshooting

**`--doctor` exits `2`.** One of the three facts is missing: the Ghidra dir, the declared Java requirement, or a matching JDK. The report marks the missing row and the `Fix:` line names the single variable to set.

**A JDK is installed but ignored.** It does not satisfy the selected Ghidra's declared bounds. A JDK below the minimum is skipped by design, so install one at or above the declared major, or point `REA_SHIM_JDK_HOME` at it.

**`--bootstrap` rejects your version.** It accepts exact released versions only, never a dist-tag. Set `REA_SHIM_AGENTS_VERSION` to a published exact version, or leave it unset to take the latest.

**`--bootstrap` refuses the Ghidra line.** The line is unsupported by the exact upstream release being installed. Update to a newer `rea-agents` release rather than forcing a Ghidra build.

**`--bootstrap` fails with a missing policy path.** Upstream renamed or removed the module the bootstrap reads. That failure is the signal to update the reader, not to add a fallback pin.

**A pre-existing directory is reported and kept.** By design. The shim never deletes or overwrites something it did not create; point `REA_SHIM_HOME` at a fresh root if you want it to install anyway.

**The MCP client sees no tools.** Check the child command with `--doctor`, then confirm your client is configured to run the shim with no flag. A refusal writes nothing to stdout, so a misconfigured client sees an empty JSON-RPC stream rather than a broken one.

**A run after `--bootstrap` still uses the old JDK.** An explicit `REA_SHIM_JDK_HOME`, `REA_SHIM_GHIDRA_DIR`, `JAVA_HOME` or `GHIDRA_INSTALL_DIR` wins over the bootstrap pair. Unset it.

## Limitations

- **Ships no upstream code.** The package holds the launcher, its bootstrap support and docs (`bin/`, `lib/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `docs/`, `assets/`). Upstream `rea-agents` is resolved at run time and installed only by an explicit `--bootstrap`.
- **No dependency of its own.** Builtins only; the launcher declares no runtime dependency and names no MCP client package.
- **No `--ghidra` override.** Installing an unsupported line is not a feature. Update upstream instead.
- **No fully offline fresh install.** Every run resolves upstream through npx, and `--bootstrap` downloads official release data and archives.
- **No maintenance verbs.** The shim does not delete, migrate or repair an install; removal is deleting the version directory.
- **Windows x64 only.** The bootstrap installs official Windows archives and the launcher spawns `cmd.exe`.
- **Node range tracks upstream.** The current upstream `rea-agents` `engines` field is the source of truth, and this package's `engines` mirrors that range.
- **It does not proxy or transform the MCP protocol.** It starts the child, keeps stdout clean, and forwards the exit code.

## Verification

`node --test test/bootstrap.test.js` is an offline contract suite. It uses local ZIP fixtures, injected runners and fixture JSON. It proves the installer's refusal paths, the official-release selectors, the exact-version gates and the read-only CLI. It does not download anything, start Ghidra or prove that a real engine works.

The acceptance proof is a clean Windows Sandbox run:

1. Start a Windows Sandbox with no Java and no Ghidra installed.
2. Install Node matching the upstream engine range.
3. From the candidate checkout, run `node packages/rea-shim/bin/rea-shim.js --bootstrap` once and capture the full output. After a release, the same command is `npx -y rea-shim@latest --bootstrap`.
4. Confirm it prints `bootstrap PASS`, the exact observed `rea-agents` version, the official Ghidra version, the Temurin version, the MCP tool count and a real analysis evidence id.
5. From the same checkout, run `node packages/rea-shim/bin/rea-shim.js --doctor` with `REA_SHIM_JDK_HOME`, `REA_SHIM_GHIDRA_DIR`, `JAVA_HOME` and `GHIDRA_INSTALL_DIR` unset, and confirm it resolves the installed pair.
6. Confirm no host Java or Ghidra installation was modified.

A release is not acceptance-proven until that Sandbox run exists. The contract suite alone is not runtime proof.

## Links

- Source: <https://github.com/nathwn12/oc-collections/tree/main/packages/rea-shim>
- Package: <https://www.npmjs.com/package/rea-shim>
- Issues: <https://github.com/nathwn12/oc-collections/issues>
- Releases: <https://github.com/nathwn12/oc-collections/releases>
- Upstream: <https://github.com/morluto/rea>
- Upstream package: <https://www.npmjs.com/package/rea-agents>
- Publishing: [PUBLISHING.md](PUBLISHING.md)
- License: MIT, see [LICENSE](../LICENSE)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="../assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
