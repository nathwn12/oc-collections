<h1 align="center">oc-harness-setup guide</h1>

## How it works

`setup` is a one-shot installer, not a runtime. It reads a file manifest, prints it, waits for your `y`, then writes into your OpenCode config directory. It ships no plugin and starts no process: everything it lays down is markdown, JSON, and one doctor script that Node runs.

**What lands where.** The config dir receives `opencode.jsonc` (merged, never replaced), `AGENTS.md`, `agents/` (10 seats), `commands/` (6 commands), `skills/` (6 skills), `reference/` (12 on-demand files behind one index), `scripts/harness-doctor.mjs`, `gitignore.template`, and `.docs/`. Your state dir is seeded once with `state/lessons.md` and `state/template.md` and is never overwritten afterwards.

**The loop it installs.** Brief → seat → skill → evidence → verify → memory. One routing table in `reference/flow.md` gives each seat its trigger, owned paths, and check. The verifier never authored the work it grades, and no seat certifies its own output.

**Consent gate.** The full manifest prints before anything moves: destination, incoming file count, and the policy line naming how many files update in place, how many are kept beside a `.new` copy, how many are added, and how many are skipped as identical. Nothing is written until you type `y`; `--dry-run` prints the same manifest and exits.

**Merge policy.** Your config is merged, not replaced. The pack owns runtime policy — the `permissions[]`/`policies[]` deny block, `default_agent: orchestrator`, and the skill allow entries — while your model, provider, keys, MCP servers, plugins and any other key survive untouched. A key you set that the pack also owns is reported rather than silently overruled.

**Journal and uninstall.** Every written path is recorded in `oc-harness-setup.manifest.json` inside the config dir, with a SHA-256 per file. `setup --uninstall` reads that manifest and removes exactly what it lists, restoring the pre-install originals from its backup path.

**Doctor gate.** Every setup run ends by running `scripts/harness-doctor.mjs` against the config dir. It grades 18 laws and names the failing law with the fix. A failing doctor exits non-zero, and re-running setup is idempotent, so the recipe is: read the named fix, apply it, run again.

## Configuration

Two environment variables, and the config keys the pack owns.

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENCODE_CONFIG_DIR` | the path the OpenCode CLI reports, else the platform default under your config home | Overrides the config dir. Use it when the CLI cannot report a path. A relative value is rejected because the host echoes it verbatim. |
| `OPENCODE_CONFIG` | unset | The host's own single-file config pointer, honoured when present so the installer targets the config the host actually reads. |

| Key in `opencode.jsonc` | What the pack sets | Why |
| --- | --- | --- |
| `default_agent` | `orchestrator` | The routing seat is the entry point; an existing 0.3.x config keeps resolving. |
| `permissions[]` / `policies[]` | The deny block, last | Hard denies land after your rules so the gate cannot be widened by ordering. |
| `skill` allow entries | The six shipped skills | Retired skills are pruned; custom skills are left alone. |

Everything else in that file is yours. There are no model pins and no credentials anywhere in the pack.

## Commands

| Command | Arguments | What it returns | Exit |
| --- | --- | --- | --- |
| `oc-harness-setup setup` | none (the default when you pass no command) | Prints the manifest, waits for `y`, installs, ends on the doctor gate | `0` on a clean install, `1` when the doctor fails or an argument is unknown |
| `oc-harness-setup setup --dry-run` | — | The same manifest, and nothing is written | `0` |
| `oc-harness-setup setup --ci` | — | The manifest only, refusing to mutate | `0` |
| `oc-harness-setup setup --uninstall` | `--dry-run` / `--ci` also accepted | Removes exactly the manifest-listed files and restores originals; a preview writes nothing | `0`, or `1` on a doctor failure during setup |
| `oc-harness-setup --version` | — | The package version | `0` |
| `oc-harness-setup --help` | — | The usage block | `0` |

One example, the one worth running before a first install:

```bash
npx --yes oc-harness-setup setup --dry-run
```

It prints the destination config dir, the incoming file count split into new and already-identical, and the policy line — then exits without touching the disk. Restart OpenCode after a real install so the new agents, commands and skills load.

## Safe upgrade

- Your `opencode.jsonc` settings, providers, MCP servers, plugins, and state survive.
- `default_agent` stays `orchestrator`, so an existing 0.3.x config keeps resolving.
- The installer is additive: an unmodified package file updates in place, while a file you edited or own is kept byte-identical and the new version lands beside it as `<name>.new`.
- Stale pack paths the new distro no longer ships are retired only when still byte-identical to the prior install (journaled, restorable on uninstall); anything you modified moves to `state/archive/legacy-0.3.x/` instead of being deleted, and is reported.
- Stale `skill` allow entries for retired skills are pruned; custom skills are left alone.
- The custom `/goal` looper ships as `/loop` (`commands/loop.md` plus `skills/loop/SKILL.md`); a fresh install writes neither `commands/goal.md` nor `skills/goal`, and both `/loop` bodies name the host's native `/goal` session-continuation command so the distinction is explicit.
- An upgrade settles a tracked `/goal` path only when a prior manifest entry lists it with a recorded hash, per file: matching bytes are retired, differing bytes are archived under `state/archive/legacy-0.3.x/`.
- A `/goal` path the prior manifest never listed, an entry with no recorded hash, or an install with no prior manifest is left in place — so it can still collide with the native `/goal` name; remove it yourself if it does.
- `setup --dry-run` previews all of it; `--uninstall` restores the pre-upgrade snapshot.

## Grow it

This starter grows through `evolve`: the smallest deliberate extension — one skill, command, reference, seat, or config change at a time, always 1:1 and doctor-checked. Repeat something twice, and `evolve` is how it earns a place.

## Troubleshooting

**Setup refuses to start on a 1.x host.** Deliberate. 1.x uses a different config dialect, so the installer stops before writing anything. Upgrade OpenCode first.

**Setup warns on a 2.0 or 2.1 host.** The merged `permissions[]`/`policies[]` deny gate is not proven there, so the install proceeds with a warning rather than a claim. 2.2.0 or newer is the tested floor.

**The config dir cannot be found.** The CLI is asked first, then `OPENCODE_CONFIG_DIR`, then the platform default. Set `OPENCODE_CONFIG_DIR` explicitly — a relative value is rejected, so give an absolute path.

**The doctor fails.** It names the law and the fix. Apply the fix and re-run `setup`; it is idempotent. Removing `state/template.md`, for example, fails the doctor by name.

**The doctor did not run at all.** If `scripts/harness-doctor.mjs` is missing from the config dir, setup warns that the 18 laws are unverified and exits `0`. That is a warning, not a pass.

**A file I edited got a `.new` beside it.** By design: your bytes were kept and the new version landed next to them. Merge by hand, then delete the `.new`.

**An `apiKey` is rejected by the doctor.** A literal key fails; a pointer to one passes. Keep credentials out of `opencode.jsonc`.

**Uninstall left something behind.** Uninstall removes only manifest-listed paths. A file you created after the install, or one the manifest never listed, is not ours to delete and is kept.

**`/goal` collides with the host's native command.** A fresh install ships `/loop`, not `/goal`. If an old `/goal` pair predates the manifest, it is left in place — remove it yourself.

## Limitations

- Windows 10/11 only. macOS and Linux are not supported, and the installer refuses rather than half-working.
- OpenCode 2.2.0 or newer is the tested floor; 2.0/2.1 warns, 1.x is refused before anything is written.
- It is an installer, not a manager: there is no `update` command, no daemon, and no runtime. Re-running `setup` is the upgrade path.
- It cannot verify a law it did not ship. A missing doctor script is reported as unverified, never as green.
- It never deletes a file it did not install. Leftovers you own stay yours, including a colliding `/goal`.
- No plugin, no model pins, no credentials: if you want a plugin or a pinned model, that is your config to write.
- The pack owns runtime policy keys; a key you set that the pack also owns is reported rather than merged both ways.

## Links

- Source: <https://github.com/nathwn12/oc-collections/tree/main/packages/oc-harness-setup>
- Published package: <https://www.npmjs.com/package/oc-harness-setup>
- Changelog: [CHANGELOG.md](../CHANGELOG.md)
- Releases: <https://github.com/nathwn12/oc-collections/releases>
- Issues: <https://github.com/nathwn12/oc-collections/issues>
- License: [LICENSE](../LICENSE)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="../assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
