<p align="center">
  <img src="assets/icon.svg" width="120" height="120" alt="oc-unified icon" />
</p>
<h1 align="center">oc-unified</h1>
<p align="center"><strong>Watch worker sessions, track tool liveness, and keep session titles consistent from one background plugin.</strong></p>

## Install

The package is private and not yet published, so there is no install command today. When it is published, the entry will be `oc-unified` in the `plugins` array; once loaded, the plugin with id `oc-unified` wires fleet, lifeline, and masthead in guarded steps. You need an OpenCode v2 host already running.

### Wire it yourself

When the package is published, the entry will be:

```json
{
  "plugins": [
    {
      "package": "oc-unified",
      "options": {
        "config": "<config-dir>/oc-unified.jsonc",
        "stateDir": "<state-dir>/opencode"
      }
    }
  ]
}
```

The `config` and `stateDir` keys match the option names the resolver reads in `config.ts`. An absent file or block is not an error: each feature falls back to neutral observe-only defaults. There is no working install command until that publish happens.

## Use it

Run your sessions as normal. Fleet writes its status file and surfaces escalation notes in model context. Query the `oc-lifeline` snapshot or the `lifeline` tool for stale tools; the tool's `repair` action is observation-only and the sweep interrupt fires only once you arm `lifeline.repair`. Give masthead a `statuses` and `seats` vocabulary to enforce titles; without one it only observes.

## What you get

- Fleet watcher: follows the event stream, writes the status file, and queues a silent context note for `error`, `stalled`, `wedged`, and `terminal-all` only.
- Lifeline daemon: ages each in-flight tool against per-tool bounds under a global ceiling, records findings in the observation ledger, and reports through the `oc-lifeline` snapshot and the `lifeline` tool.
- Masthead renamer: keeps top-level titles in your configured grammar and assigns a durable `untitled <N>` label when no title can be derived.
- One shared `oc-unified.jsonc` file with `fleet`, `masthead`, `lifeline`, and `caution` blocks; unconfigured installs observe and never rename, escalate, or interrupt.

## Requirements

- OpenCode v2 host; the host loads the `.ts` entry points directly with no build step.
- Bun >= 1.4.0 or Node >= 22.
- One runtime dependency: `@opencode/plugin` 2.0.26.
- Optional: an `oc-unified.jsonc` file when you want behavior beyond the neutral defaults.

## Links

- Source: [nathwn12/oc-collections](https://github.com/nathwn12/oc-collections/tree/main/packages/oc-unified) — the package is private and not published, so there is no npm install.
- License: [LICENSE](LICENSE) (MIT)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
