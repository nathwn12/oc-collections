<h1 align="center">rea-shim</h1>

<p align="center"><strong>One command installs Craft Anything on Windows x64; --mcp serves a JSON-RPC client.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/rea-shim"><img src="https://img.shields.io/npm/v/rea-shim" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/platform-windows--64bit-2b3137" alt="Windows x64" />
  <a href="https://github.com/nathwn12/oc-collections/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT licence" /></a>
</p>

## Install

```powershell
npx -y rea-shim@latest
```

No argument installs the app. One optional flag, `--mcp`, serves a client instead. No path, configuration file or extra setup.

## Use it

The first run downloads the official portable build, checks it against a pinned SHA-256 before extracting, puts it under your user profile, writes one first-run setting and starts the app. Later runs start the same install without downloading again and leave your settings as they are.

### MCP client

`npx -y rea-shim@latest --mcp` is the MCP entry for a client such as OpenCode. It uses the same verified install and settings rule, then runs the bundled command line as a JSON-RPC server over standard input and output. Progress and errors go to stderr only, so stdout carries protocol frames only. The child's exit code is passed through. A first run completes the download before the channel starts.

If a download is interrupted or does not match the pin, nothing is installed. Run the same command again to retry.

### What it changes

- One application folder under your local app data, with the app and its files.
- One small settings file, only when no settings exist. It sets `auto_mode = false` and leaves every other default alone.
- Nothing else. No administrator prompt, no change to `PATH`, no service, no shortcut registration and no background updater.

Existing settings are never read, rewritten or reformatted. The app is pointed at the same stable settings folder on every launch.

### Upstream

REA means Reverse Engineer Anything. This shim keeps the name but no longer installs base REA. It installs Craft Anything, a separate product by its own authors. The two are not affiliated. The shim ships no upstream code; see the official site and release page in ## Links.

## Requirements

- Windows 10 or 11, 64-bit. Any other platform is refused with a clear message.
- Node matching the range in the package manifest.

## Status

**Active** — maintained, issues welcome.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Guide](https://github.com/nathwn12/oc-collections/blob/main/packages/rea-shim/docs/GUIDE.md)
- [Craft Anything](https://craft.wiki/apps/craft-anything)
- [Upstream releases](https://github.com/storytold/craft-anything/releases)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)
