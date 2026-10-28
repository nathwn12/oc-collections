<h1 align="center">oc-harness-setup</h1>
<p align="center"><strong>A compact OpenCode starter that runs a real loop, researches before it claims, keeps a ledger, cleans up after itself, and grows the next skill you need.</strong></p>

## Install

```bash
npx --yes oc-harness-setup setup
```

First run prints a manifest of everything it will touch and waits for you to type `y`. It then lays the agents, commands, skills, references, doctor gate, and merged base config into your OpenCode config dir, seeds your `state/` dir, and ends on the harness doctor gate.

## Why this starter

- Small on purpose: 9 agents, 6 skills, 12 on-demand references; the primary loads one, the rest wait for a trigger.
- A loop that closes: goal -> worker -> verifier -> historian -> cleaner -> close; no self-verdicts.
- Research that cites: researcher + search + canon; claims arrive sourced or `UNVERIFIED`.
- Memory that survives: historian writes session state; `state/` is seeded and preserved on upgrade.
- Cleanup that ships: cleaner removes this session's scratch; hygiene proves the tree clean.
- Grows with you: `evolve` turns a repeated workflow, a user request, or an upstream feature into a skill, command, reference, seat, or config change — 1:1 and doctor-checked.
- Reversible and fail-closed: manifest first, SHA-256 journal, uninstall restores originals, hard denies last.

## What you get

- 9 agents with bounded reach: one coordinator, one verdict, and seven specialists that each own exactly one surface.
- 6 skills behind 6 commands: close, evolve, fast, goal, search, and swarm.
- 12 on-demand references behind a single index; load only the file a rule names.
- 18-law doctor gate: every setup run ends on it, and failures name the check and the fix.
- Consent-first install: the full manifest prints before anything moves, and `--dry-run` changes nothing.
- Your settings and state survive: your model, provider, and keys are preserved while the pack owns runtime policy, and your state dir survives upgrades untouched.
- No plugin, no model pins, no credentials.

## Commands

```bash
npx --yes oc-harness-setup setup                # full install (default when you pass no args)
npx --yes oc-harness-setup setup --dry-run       # print the manifest, touch nothing
npx --yes oc-harness-setup setup --ci            # print-only, refuse to mutate
npx --yes oc-harness-setup setup --uninstall     # remove exactly the manifest-listed files
npx --yes oc-harness-setup --help                # print usage
```

Set `OPENCODE_CONFIG_DIR` to override the config dir when the OpenCode CLI cannot report a path; otherwise setup uses the path from the CLI first, then the platform default under your config home. Restart OpenCode after install so the new agents, commands, and skills load.

## Safe upgrade

- Your `opencode.jsonc` settings, providers, MCP servers, plugins, and state survive.
- `default_agent` stays `orchestrator`, so an existing 0.3.x config keeps resolving.
- Unmodified 0.3.x agents, commands, skills, references, and scripts are retired.
- Files you edited are archived under `state/archive/legacy-0.3.x/` instead of deleted, and reported.
- Stale `skill` allow entries for retired skills are pruned; custom skills are left alone.
- `setup --dry-run` previews it; `--uninstall` restores the pre-upgrade snapshot.

## Grow it

This starter grows through `evolve`: the smallest deliberate extension — one skill, command, reference, seat, or config change at a time, always 1:1 and doctor-checked. Repeat something twice, and `evolve` is how it earns a place.

## Requirements

- Windows 10/11 only; macOS and Linux are not supported.
- Node.js 22 or newer, the only runtime requirement with zero runtime dependencies.
- OpenCode 2.2.0 or newer (the tested floor). A 2.0/2.1 host warns — the merged `permissions[]`/`policies[]` deny gate is unproven there — and a 1.x host is refused before anything is written (different config dialect).
- PowerShell 7 for the doctor gate; without it the doctor reports skipped, never passed.

## Links

- Source: [nathwn12/oc-collections](https://github.com/nathwn12/oc-collections/tree/main/packages/oc-harness-setup) — the npm package remains individually installable.
- [Published package](https://www.npmjs.com/package/oc-harness-setup)
- [Changelog](../CHANGELOG.md)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [License](../LICENSE)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="../assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
