# oc-collections

OpenCode plugins, MCP servers and tooling by nathwn12. Each package installs on its own; there is no bundle and no all-in-one.

## Usage

**[Browse `packages/`](https://github.com/nathwn12/oc-collections/tree/main/packages)**

Each package is a folder with its own README. That README carries the install steps for that package and nothing else. Nothing here requires the whole repo.

## Packages

| Package | Kind | Version | What it does | Install |
| --- | --- | --- | --- | --- |
| janua | MCP | `0.3.1` | Persistent interactive terminals: spawn a program, type into it, read live output, resize it, kill it. | `npx -y @nathwn12/janua` (stdio MCP server). |
| oc-bifrost | plugin | `1.6.13` | Runs older OpenCode plugins on the current runtime. | Add `@nathwn12/oc-bifrost` to `plugins`. |
| oc-flight-deck | plugin | `0.21.1` | Live session telemetry in the OpenCode sidebar. | Add `oc-flight-deck` to `plugins`. |
| oc-harness-setup | CLI | `1.0.0` | Installs the Windows agent harness. | `npx -y oc-harness-setup setup` |
| oc-talk | plugin | `0.1.7` | Cross-session talk: list live sessions, send one message to a peer, read its reply. | Add `oc-talk` to `plugins`. |
| rea-shim | MCP | `0.2.2` | Launcher for the rea reverse-engineering server. | `npx -y rea-shim --doctor` |
| oc-collections | repo | — | This index and npm-workspaces monorepo. | — |

Each package's own README has the full steps, options and requirements.

The `gladius` and `puppet` MCP servers live in their own repositories. Their launchers fetch engine binaries from those repositories' release assets on first run.

## Requirements

Windows. Every package here targets Windows and none of them claims support elsewhere.

## Development

From the repo root:

```sh
npm install
npm run check
npm run pack:check
```

`npm run check` runs the docs checker, its self-test, and every workspace's own check. `pack:check` runs check and build, then verifies each tarball.

Releases use tags of the form `<package>@<version>`. The release workflow publishes over OIDC with provenance and no stored token.

## License

MIT. See [LICENSE](LICENSE).
