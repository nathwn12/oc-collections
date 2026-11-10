# install-parity

## Out

A verdict on whether `oc-stacked` can install exactly the way `obra/superpowers` does: **one spec line in `opencode.json`, the harness fetches and caches the package itself, and the plugin writes nothing into `~/.config/opencode`**. Answer these five, each with a receipt:

1. **Plugin spec.** The exact V2 (2.2.6) string that installs a plugin from a GitHub repo. Both forms: git (`pkg@git+https://...`) and a published npm name. Quote the resolver code and the doc line.
2. **Agents.** Can a plugin register agent definitions at load time — 24 of them, each with description, model, mode, and a long prompt — without any file under `~/.config/opencode/agents`? Name the hook (`config` / `setup(ctx)` / other), the exact field (`config.agent[id] = { ... }`), and whether `prompt` accepts an inline string. Quote the schema.
3. **Commands.** Same question for `commands/stack.md` (a slash command). Config field, inline body support, or file-only?
4. **Skills.** Confirm the `config.skills.paths.push(dir)` path works for a package installed into the harness cache, and that the directory resolves relative to the plugin file, not the cwd. `obra/superpowers/.opencode/plugins/superpowers.js:230-236` is the reference.
5. **What still cannot be delivered this way.** Anything that forces a filesystem write or a global install. Be explicit; this list decides whether `scripts/install.mjs` survives as the user-facing path.

End with one of: `PARITY` (one config line is enough), `PARITY WITH CAVEATS` (one line plus a named manual step), or `NO PARITY` (install.mjs stays), and the reason in one sentence.

## Check

Every claim carries `file:line` from OpenCode's own source at the tag matching the installed `v2.2.6`, or a doc URL plus the quoted line. Command, output, exit code. A claim you could not verify is written `UNVERIFIED: <what> - <why>`, never smoothed over. Behaviour of `obra/superpowers` alone is not evidence about OpenCode; it is evidence of one working example.

## Owns

`.stack/reports/install-parity.md`

## Do not touch

Any other path. No edits to `index.js`, `scripts/install.mjs`, `package.json`, or anything under `skills/` or `agents/`. This is a read-only investigation: report findings, do not implement them.

## Read first

- `Q:\PROJECTS\INSPIRATION\obra\superpowers\.opencode\INSTALL.md` (whole file)
- `Q:\PROJECTS\INSPIRATION\obra\superpowers\.opencode\plugins\superpowers.js:215-320`
- `Q:\PROJECTS\PERSONAL\oc-stacked\scripts\install.mjs` (what we do today)
- `Q:\PROJECTS\PERSONAL\oc-stacked\index.js:1-30` (what we register today)

Local search first: is there an OpenCode source checkout on this machine (`packages/opencode/src`)? If not, fetch from `github.com/anomalyco/opencode` at tag `v2.2.6`. The installed binary is a compiled `C:\Users\nathan\scoop\persist\bun\bin\opencode.exe`; do not try to reverse it.

## Tier

Research. Upstream source and docs win over anything already on disk, including our own README.
