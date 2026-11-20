<p align="center">
  <img src="https://raw.githubusercontent.com/nathwn12/oc-collections/main/packages/oc-harness-setup/assets/icon.svg" width="120" height="120" alt="oc-harness-setup icon" />
</p>

<h1 align="center">oc-harness-setup</h1>

<p align="center"><strong>A consent-first OpenCode starter for Windows: ten seats, six skills and a doctor gate in one command.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/oc-harness-setup"><img src="https://img.shields.io/npm/v/oc-harness-setup" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-windows--64bit-2b3137?logo=windows&amp;logoColor=white" alt="platform">
</p>

## Why

A starter that writes files is only safe if you can see and undo what it does. `oc-harness-setup` prints a full manifest before anything moves and waits for you to type `y`. It gives every agent a trigger, an owned path set and a check, so a verdict never comes from the author. A doctor gate ends each run on an 18-law check that names the failing law and its fix.

The install is reversible by journal: SHA-256 per file, so `--uninstall` restores what was there and removes exactly what it added.

## Install

```bash
npx --yes oc-harness-setup setup
```

The first run prints the manifest of everything it will touch and waits for confirmation. `--dry-run` changes nothing at all.

## Use

Run `setup` to install the starter, then answer `y` at the manifest. The pack puts ten seats on one routing table, six skills behind six commands, and twelve on-demand references loaded one at a time from an index.

Afterwards:

- `evolve` turns a repeated workflow into one skill, command, reference, seat, or config change.
- `--uninstall` restores the pre-install state from the journal.
- `--dry-run` shows the plan without writing.

## Configure

There is no config file to edit by hand. Your model, provider, keys, plugins and state are kept while the pack owns runtime policy. The command line is the surface:

| Command | Effect |
| --- | --- |
| `setup` | Install the starter behind the manifest and doctor gate. |
| `evolve` | Grow the setup by one skill, command, reference, seat, or config change. |
| `--dry-run` | Print the plan without writing. |
| `--uninstall` | Restore files from the journal. |

## Requirements

- Windows 10 or 11.
- Node.js 22 or newer.
- OpenCode 2.2.0 or newer. A 2.0/2.1 host warns before installing; a 1.x host is refused before anything is written.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Guide](https://github.com/nathwn12/oc-collections/blob/main/packages/oc-harness-setup/docs/GUIDE.md)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)

<p align="center"><sub>Built by nathwn12</sub></p>
