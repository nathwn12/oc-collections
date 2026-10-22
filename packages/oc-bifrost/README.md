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

On first run the bridge fetches the listed snapshot, executes its entry file with your rights, and prints a per-plugin mount report. List any other legacy plugin in `options.plugins`; the guide carries the offline preset and the other sources.

## What it does

- Bridges V1 hook factories and V1 modules onto the V2 runtime, hook by hook.
- Reports what really happened per hook: bridged, bridged with a stated loss, or refused.
- Mounts plugins from a GitHub snapshot, a registry package, a local path, or the bundled offline preset.
- Fetches remote code only after you consent, then pins the snapshot by commit and digest.
- Writes a mount report on every load, so a lost hook is named rather than silently dropped.

## Requirements

Any platform OpenCode V2 runs on, with OpenCode V2 (2.x) and Node 22 or later installed; the npm registry must be reachable for the first fetch.

## Full documentation

- Guide: <https://github.com/nathwn12/oc-collections/blob/main/packages/oc-bifrost/docs/GUIDE.md>
- Package: <https://www.npmjs.com/package/@nathwn12/oc-bifrost>

The guide covers every option key, all four plugin sources, the hook-by-hook bridge contract, and the setup and verification records.
