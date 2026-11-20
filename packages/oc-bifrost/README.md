<p align="center">
  <img src="https://raw.githubusercontent.com/nathwn12/oc-collections/main/packages/oc-bifrost/assets/icon.svg" width="120" height="120" alt="oc-bifrost icon" />
</p>

<h1 align="center">oc-bifrost</h1>

<p align="center"><strong>Run V1-era OpenCode plugins on OpenCode V2: supported hooks bridge across, the rest refuse out loud.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nathwn12/oc-bifrost"><img src="https://img.shields.io/npm/v/@nathwn12/oc-bifrost" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="platform">
</p>

## Why

The V1 plugin hook API does not mount unchanged on the V2 runtime. `oc-bifrost` takes 24 V1 hooks: 5 bridge fully, 10 bridge with a stated loss, and 9 refuse by design. A lost hook is named, never silently dropped.

Every load prints one verdict per hook — `full`, `partial`, or `unsupported` — and mirrors it to a durable report file, because the host discards stdout in service and stdio modes. Four plugin sources are supported: a GitHub snapshot, a registry package, a local path, and the bundled offline `preset:rtk`.

## Install

Add one entry to the `plugins` array in your `opencode.jsonc` and restart OpenCode. OpenCode fetches the package itself; you run no install command:

```jsonc
{
  "plugins": [
    {
      "package": "@nathwn12/oc-bifrost",
      "options": {
        "plugins": ["github:obra/superpowers"],
        "trustRemote": true
      }
    }
  ]
}
```

## Use

Name the plugins you want in the `plugins` option. A cold `github:` cache refuses until you set `trustRemote`, then pins the snapshot by commit and digest. Registry packages, local paths and `preset:rtk` need no remote trust.

On each start, read the mount report. It gives one line per hook, so a `partial` or `unsupported` verdict tells you exactly what changed before you blame your own plugin. The same lines are written to the durable report file for headless runs.

## Configure

All settings live in the `options` object of the entry above:

| Option | Effect |
| --- | --- |
| `plugins` | The V1 plugins to mount. Accepts `github:`, registry, local path, and `preset:` sources. |
| `trustRemote` | Allows a cold GitHub fetch. Without it the bridge refuses instead of fetching unverified code. |
| `provision` | How snapshot dependencies are resolved: from the host store, an `npm install --no-save` fallback, or no action. |

A stranded-file scan warns when a V1 plugin file sits in a discovery directory the host would reject before the bridge runs.

## Requirements

- OpenCode 2.2.6 or newer.
- Node 22 or later.
- The npm registry must be reachable for the first fetch of a registry or GitHub plugin.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Guide](https://github.com/nathwn12/oc-collections/blob/main/packages/oc-bifrost/docs/GUIDE.md)
- [Third-party notices](https://github.com/nathwn12/oc-collections/blob/main/packages/oc-bifrost/THIRD-PARTY-NOTICES.md)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)

<p align="center"><sub>Built by nathwn12</sub></p>
