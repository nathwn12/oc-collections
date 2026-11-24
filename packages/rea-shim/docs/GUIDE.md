<h1 align="center">rea-shim guide</h1>

## One command

```powershell
npx -y rea-shim@latest
```

The command takes no argument. It verifies the pinned payload, installs it, prepares one first-run setting and starts the app window. `--version` prints the shim version and `--help` prints the short usage. No other option exists.

## What is pinned

| Fact | Value |
| --- | --- |
| Product | Craft Anything, official Windows x64 portable build |
| Tag | v0.6.1 |
| Archive | craft-anything-0.6.1-windows-x64-portable.zip |
| Bytes | 69,934,191 |
| SHA-256 | bd370fbaa2b44dbc13581db5ffd2bf66924ed40e433c7902212aa17ca781de54 |

The checksum was checked against the signed upstream checksum file during release preparation. At runtime the shim checks those bytes itself with native Node crypto before any extraction. It does not fetch a trust list, run a signature tool or use a package manager at runtime. No other platform or architecture has a pinned verified hash, so the shim exits with an explicit message on any host other than Windows x64.

## Where things go

The install root is `%LOCALAPPDATA%\rea-shim\craft-anything`. The app is placed in a version-named folder below it, and a marker records the exact version and hash. A rerun that finds that marker and the executable starts the app directly: zero download requests and no write to the app or its settings.

The stable settings folder is `config` under that same root. On every launch the shim sets the native environment override `CRAFT_ANYTHING_CONFIG_DIR` to that folder. This key is the first source Craft v0.6.1 reads for its config directory, ahead of the portable marker beside the executable.

If `config.toml` does not exist, the shim creates it with exactly one line:

```toml
auto_mode = false
```

Craft v0.6.1 declares every other setting with a default and sets `auto_mode` to true, so that one key is the smallest change that keeps the app benign on a fresh install. No agent, server, deep-inspection or target-analysis setting is enabled. If a config file already exists, the shim leaves it byte for byte and never merges into it; the user's own choice wins.

## Recovery

A partial or altered download fails at the hash check. The shim deletes only the partial file it created, installs nothing and prints the expected and observed hashes with one instruction: run the same command again. The next run downloads again and completes. No orphan is left behind.

A good archive already placed in the shim-owned cache under its SHA-256 is used without a download, after the same hash check. That is the offline staging route for an isolated native run: it exercises the same no-argument entry, not a substitute wrapper. A foreign or mismatched cache file is reported and preserved, never deleted.

## Boundaries

No administrator prompt, no change to `PATH`, no service, no scheduled task, no Start Menu or registry entry, and no background updater. The shim does not configure an agent, a client, a server or an automation workflow. Upgrades are tied to a shim release that pins a new verified payload.

## Verification

The offline suite in `test/` is a contract suite. It uses small local archives and injected download and start functions. It proves the pin, the hash gate before extraction, the safe-path checks, the single first-run key, byte-identical settings on rerun, zero fetches on rerun and the explicit refusal for an unsupported host. A passing suite is not a claim that the third-party window was started on a clean machine. That evidence comes from an isolated native run, captured separately, and is not produced by this package.
