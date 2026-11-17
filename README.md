<h1 align="center">oc-collections</h1>

**OpenCode plugins, MCP servers and CLIs that install one at a time, one folder each.**

## Install

Open [`packages/`](packages) and pick one. Each folder carries its own README with that package's install step, and nothing here requires the whole repository.

## Use it

| Package | Kind | Version | What it does | Install |
| --- | --- | --- | --- | --- |
| janua | MCP | `0.5.1` | Persistent interactive terminals: spawn a program, write to it, read live output, resize it, kill it. | `npx @nathwn12/janua` |
| oc-bifrost | plugin | `1.7.1` | Runs V1-era OpenCode plugins on OpenCode V2. | Add `@nathwn12/oc-bifrost` to `plugins`. |
| oc-flight-deck | plugin | `0.22.0` | Live cost, token, cache and context telemetry in the sidebar. | Add `oc-flight-deck` to `plugins`. |
| oc-harness-setup | CLI | `1.0.2` | Installs a Windows OpenCode starter, behind a doctor gate. | `npx --yes oc-harness-setup setup` |
| oc-plugin-view | plugin | `0.2.0` | Lists every loaded server plugin in the sidebar. | `opencode plugin add oc-plugin-view` |
| oc-talk | plugin | `0.5.0` | Sends one message into any live session and reads what it said back. | Add `oc-talk` to `plugins`. |
| rea-shim | MCP | `0.2.3` | Launches the upstream `rea` reverse-engineering MCP and can bootstrap its JDK and Ghidra. | `npx -y rea-shim@latest --doctor` |
| oc-collections | repo | — | This index and the npm-workspaces monorepo behind it. | — |

An MCP goes into your client's server list, a plugin into `plugins` in your `opencode.jsonc`, and a CLI runs once. The `gladius` and `puppet` MCP servers keep their source here but publish from the repositories that build their engines; `oc-fallback`, `oc-graphify` and `oc-terminal` are private and load by path. None of the five carries a version row.

## Requirements

- Node 22 or newer. `janua` and `rea-shim` narrow that to `^22.23.4`, `^24.22.1` or `>=26.12.1`; `oc-flight-deck` and `oc-plugin-view` also run under Bun 1.4 or newer.
- OpenCode 2 for the plugins and the starter. The floors differ per package: `2.1.1` for `oc-flight-deck`, `2.2.0` for `oc-harness-setup`, `2.2.6` for `oc-bifrost` and `oc-plugin-view`. Each package README states its own.
- Windows 10 or 11 for `oc-harness-setup`, and Windows x64 plus a JDK and Ghidra, or `--bootstrap`, for `rea-shim`. `janua` runs on Windows, Linux and macOS.
- An MCP client for `janua` and `rea-shim`.

## Development

From the repo root:

```sh
bun install --frozen-lockfile
bun run check
bun run pack:check
```

`bun run check` runs the vocabulary and launcher guards, the index check and its self-test, the docs check and its self-test, then every workspace's own check. `bun run pack:check` adds a build and verifies each tarball.

Releases are cut by [docs/RELEASE.md](docs/RELEASE.md): a merge to `main` derives each package's version from the commits since its tag, then tags it and publishes over OIDC with provenance. Every package keeps its own history in its own CHANGELOG.

## Status

**Experimental** — pre-release; interfaces may change.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Release lane](docs/RELEASE.md)
- [Changelog](CHANGELOG.md)
- [MIT licence](LICENSE)
