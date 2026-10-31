# oc-bifrost

Runs your V1-era OpenCode plugins on OpenCode V2: supported hooks bridge across, the rest refuse out loud.

## Install

Add one entry to the `plugins` array in your `opencode.jsonc`, then restart OpenCode. OpenCode fetches the package itself, so you run no install command:

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

## What you get

| Capability | What it does for you |
| --- | --- |
| Hook-by-hook bridging | Takes 24 V1 hooks: 5 bridge fully, 10 bridge with a stated loss, 9 refuse by design. |
| Shape-based routing | V1 factories and V1 modules mount through the bridge; V2 `{ id, setup }` definitions mount as-is; Effect-only definitions refuse out loud. |
| Mount report | Prints one verdict per hook on every load — `full`, `partial`, `unsupported` — so a lost hook is named, never silently dropped. |
| Durable report file | Mirrors every report line to a file, because the host discards stdout in service and stdio modes. |
| Four plugin sources | Mounts a GitHub snapshot, a registry package, a local path, or the bundled offline `preset:rtk`. |
| Consent-gated fetching | A cold `github:` cache refuses until you set `trustRemote`, then pins the snapshot by commit and digest. |
| Dependency provisioning | Resolves snapshot dependencies from the host store, falls back to `npm install --no-save`, or does nothing, per `provision`. |
| Stranded-file scan | Warns when a V1 plugin file sits in a discovery directory the host would reject before the bridge ever runs. |

## Requirements

OpenCode V2 (2.x) with Node 22 or later, on any platform the host runs on; the npm registry must be reachable for the first fetch.

## Going deeper

The manual at <https://github.com/nathwn12/oc-collections/blob/main/packages/oc-bifrost/docs/GUIDE.md> covers the bridge contract hook by hook, every option and environment variable, the mount report, and what the bridge refuses.

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
