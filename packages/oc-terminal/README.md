# oc-terminal

The Windows spawn guard for OpenCode. It exists because of one concrete bug:
inside the compiled Bun host, `process.execPath` is `opencode.exe`, not Node.
A plugin that spawned `process.execPath` to run a JavaScript file started a
second OpenCode, which died with `ENOTDIR`, and - because the spawn carried no
`windowsHide` - Windows Terminal adopted the console and left the dead pane
behind.

Two things, one package, one guarantee: a child of the host never gets a
visible console it did not explicitly ask for.

- `packages/oc-terminal/lib.js` resolves a real JavaScript runtime (`bun` or
  `node`) and never the host binary. `spawnHidden` and `spawnSyncHidden` pass
  `windowsHide: true` on Windows.
- `packages/oc-terminal/index.js` installs a process-wide guard when the host
  loads it: `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync`
  and `fork` from `node:child_process`, plus `Bun.spawn` and `Bun.spawnSync`,
  all default to a hidden console. `OC_TERMINAL_ALLOW_VISIBLE=1` disables the
  guard for one deliberate diagnostic.

The guard is idempotent: the wrapper functions carry a mark, so a hot reload
does not stack a second wrapper.

## Install

Put the package where OpenCode discovers plugins, as a junction so this
repository stays the only writer:

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.config\opencode\plugins\oc-terminal" `
  -Target "Q:\PROJECTS\PERSONAL\oc-collections\packages\oc-terminal"
```

Restart the host once; the plugins directory is read at startup.

## Status

The plugin registers `terminal_status`, which reports whether the guard is
installed in this host process and which real JavaScript runtime it would use.
A `patched: false` answer with `windows: true` means only explicitly hidden
spawns are safe in that process.

## Check

```sh
npm run check -w packages/oc-terminal
```

The check pins the option merge for every spawn shape, the idempotent patch,
the Bun twins, the runtime refusal of `opencode.exe`, a real hidden child, and
the manifest's `node:`-only imports.

## Limit

The guard patches the module objects the host process can reach. Code that
captured a spawn function before the plugin loaded, or that spawns from a
different process, is outside it. The root-cause fix in
`packages/oc-graphify/lib.js` is the guarantee for that path: it resolves a
real runtime and passes `windowsHide` explicitly.
