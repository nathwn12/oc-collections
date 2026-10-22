# oc-collections

The single source for nathwn12's OpenCode plugins and MCP servers, each installable on its own.

## Install

**OpenCode plugins.** Add the package name to the `plugins` array in `opencode.jsonc`, then restart OpenCode:

```json
{ "plugins": ["@nathwn12/oc-bifrost"] }
```

Use `oc-flight-deck` in the same position for the sidebar panel.

**Command-line tools.** Run:

```sh
npx -y oc-harness-setup setup
```

**MCP servers.** Run:

```sh
npx -y rea-shim --doctor
npx -y gladius-mcp
npx -y puppet-mcp
```

The gladius and puppet launchers download their engine binaries from those packages' own release assets on first run.

## Packages

| Repo | What it does | Pin | Status | Install | Links |
| --- | --- | --- | --- | --- | --- |
| oc-bifrost | Runs V1-era OpenCode plugins on the V2 runtime. | `@nathwn12/oc-bifrost@1.6.10` | Pending release | `"@nathwn12/oc-bifrost"` in `plugins` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/@nathwn12%2Foc-bifrost) |
| gladius-mcp | Browser-use MCP server; engine binaries come from its original release lane. | `gladius-mcp@0.4.2` | Published from its original repo | `npx -y gladius-mcp` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/gladius-mcp) |
| puppet-mcp | Windows desktop-control MCP server; engine binaries come from its original release lane. | `puppet-mcp@4.5.3` | Published from its original repo | `npx -y puppet-mcp` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/puppet-mcp) |
| oc-flight-deck | Live session telemetry in the OpenCode sidebar. | `oc-flight-deck@0.20.2` | Pending release | `"oc-flight-deck"` in `plugins` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/oc-flight-deck) |
| oc-harness-setup | Installs and orchestrates the Windows harness. | `oc-harness-setup@0.4.4` | Pending release | `npx -y oc-harness-setup setup` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/oc-harness-setup) |
| oc-unified | Session watching, tool liveness, and title renaming in one plugin. | not on npm | Private; not on npm | none | [repo](https://github.com/nathwn12/oc-collections) |
| rea-shim | One-line MCP launcher for rea. | `rea-shim@0.1.2` | Pending release | `npx -y rea-shim --doctor` | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/rea-shim) |
| oc-todo | Archived todo plugin; OpenCode now ships the built-in feature. | `oc-todo@0.5.1` | End-of-life | none; use OpenCode's built-in todo | [repo](https://github.com/nathwn12/oc-collections) · [npm](https://www.npmjs.com/package/oc-todo) |
| oc-collections | This private index and npm-workspaces monorepo. | not on npm | Private; not published | none; this index | [repo](https://github.com/nathwn12/oc-collections) |

## Not published from this repo

- `oc-unified` is private and not on npm.
- `oc-todo` is end-of-life; OpenCode's built-in todo feature replaces it.
- `gladius-mcp` and `puppet-mcp` keep their own release lanes; the launchers here carry placeholders and are not published from this repo.

## Development

From the repo root:

```sh
npm install
npm run check
npm test
npm run pack:check
```

`npm run check` runs the workspace checks and the documentation/index checks; `pack:check` builds and verifies every tarball.

Package releases use tags `<package>@<version>`. The `release` workflow is OIDC-only, `dry_run` defaults to true, and the lane has not run yet.

## Licence

MIT. See [LICENSE](LICENSE).

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
