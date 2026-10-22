# oc-harness-setup

A compact OpenCode starter that runs a real loop, researches before it claims, keeps a ledger, cleans up after itself, and grows the next skill you need.

## Install

```bash
npx --yes oc-harness-setup setup
```

First run prints a manifest of everything it will touch and waits for you to type `y`. It then lays the agents, commands, skills, references, doctor gate, and merged base config into your OpenCode config dir, seeds your state dir, and ends on the harness doctor gate. `setup --dry-run` prints the same manifest and touches nothing.

## What it does

- Lays down a working OpenCode setup: 9 agents, 6 skills, and 12 on-demand references.
- Closes the loop: goal, worker, verifier, historian, cleaner, close, with no self-verdicts.
- Researches before it claims: a finding arrives sourced or marked unverified.
- Keeps your model, provider, keys, and state across upgrades, and reverses cleanly on uninstall.
- Grows with you: one skill, command, reference, seat, or config change at a time.

## Requirements

Windows 10/11 only, with Node.js 22 or newer plus the OpenCode CLI installed and runnable.

## Full documentation

- Guide: <https://github.com/nathwn12/oc-collections/blob/main/packages/oc-harness-setup/docs/GUIDE.md>
- Package: <https://www.npmjs.com/package/oc-harness-setup>

The guide covers the full command list, the safe upgrade path, what the doctor gate checks, and how `evolve` grows the setup. It also links the changelog, the licence, and the issue tracker.
