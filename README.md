# oc-collections

OpenCode plugins, MCP servers and tooling by nathwn12.

Each package installs on its own. There is no bundle and no all-in-one — you take one thing, not the set.

## Start here

**[Browse `packages/`](https://github.com/nathwn12/oc-collections/tree/main/packages)**

Every package is a folder with its own README. Open the one you want; its README carries the install steps for that package and nothing else. Nothing here requires the whole repo.

## What's in it

| Package | Kind | What it does | Install |
| --- | --- | --- | --- |
| oc-bifrost | plugin | Runs older OpenCode plugins on the current runtime. | Add `@nathwn12/oc-bifrost` to your `plugins`. |
| oc-flight-deck | plugin | Live session telemetry in the OpenCode sidebar. | Add `oc-flight-deck` to your `plugins`. |
| oc-harness-setup | CLI | Installs the Windows agent harness. | `npx -y oc-harness-setup setup` |
| rea-shim | MCP | Launcher for the rea reverse-engineering server. | `npx -y rea-shim --doctor` |

Each package's own README has the full steps, options and requirements. This page only tells you which folder to open.

The `gladius` and `puppet` MCP servers are not in this repo — they live in their own repositories. Their launchers fetch engine binaries from those repositories' release assets on first run.

Two packages are in the tree but not published: `oc-session-driver` and the docs tooling. They are not install targets yet.

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

## Licence

MIT. See [LICENSE](LICENSE).

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
