<p align="center">
  <img src="https://raw.githubusercontent.com/nathwn12/oc-collections/main/packages/oc-harness-setup/assets/icon.svg" width="120" height="120" alt="oc-harness-setup icon" />
</p>

<h1 align="center">oc-harness-setup</h1>

<p align="center"><strong>A consent-first OpenCode starter for Windows with skills and a doctor gate in one command.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/oc-harness-setup"><img src="https://img.shields.io/npm/v/oc-harness-setup" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/platform-windows--64bit-2b3137" alt="Windows x64" />
  <a href="https://github.com/nathwn12/oc-collections/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT licence" /></a>
</p>

## Install

```bash
npx --yes oc-harness-setup setup
```

Setup checks your host, finds your config dir, collects the files and prints a plan before it writes anything. It waits for your `y` at the plan, then backs up what it replaces, merges your config, runs the doctor and prints a summary. `--dry-run` changes nothing at all.

## Use it

Run `setup` to install the starter, then answer `y` at the plan. The pack puts ten agents on one routing table, seven skills behind seven commands, five playbooks behind `/playbook`, and twelve on-demand references loaded one at a time from an index.

Every agent gets a trigger, an owned path set and a check, so a verdict never comes from the author. Each run ends on the doctor gate: a 19-law check names the failing law and its fix. The install is reversible by journal: SHA-256 per file, so `--uninstall` restores what was there and removes exactly what it added.

- `/playbook` matches a task to one of five procedures and copies its steps into the todo before work starts.
- `evolve` turns a repeated workflow into a skill, command, agent or playbook.
- `--uninstall` restores the pre-install state from the journal.
- `--dry-run` shows the plan without writing.

### Configure it

There is no config file to edit by hand. Your model, provider, keys, plugins and state are kept while the pack owns runtime policy. The command line is the surface:

| Command | Effect |
| --- | --- |
| `setup` | Install the starter in six ordered stages, then report the doctor verdict. |
| `setup --list-stages` | Print the ordered stage list and exit without writing. |
| `setup --stage <id>` | Run up to and including that stage, then stop. |
| `setup --from <id>` | Start at that stage and run to the end. |
| `setup --ask` | Ask whether to keep your existing config values when an install-owned key collides, then ask "Install the playbooks?"; both default to yes. |
| `evolve <kind> <id>` | Write an artifact from its template, add its required companions, run the doctor and report the verdict. |
| `--dry-run` | Print the plan without writing. |
| `--uninstall` | Restore files from the journal. |

Setup records progress in `state/setup-state.yaml` in the config dir. Plain `setup` still runs every stage and remains the upgrade path; recorded progress never makes it skip work.

## Requirements

- Windows 10 or 11.
- Node.js 22 or newer.
- OpenCode 2.2.0 or newer. A 2.0/2.1 host warns before installing; a 1.x host is refused before anything is written.

## Status

**Unverified** — as-is, use at your own risk.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Guide](https://github.com/nathwn12/oc-collections/blob/main/packages/oc-harness-setup/docs/GUIDE.md)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)
