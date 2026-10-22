# Install - oc-flight-deck

Compatible with opencode 2.1.1.

One route: the npm registry. Plugin entries are bare strings in the `plugins` array of `opencode.jsonc`.

```jsonc
{ "plugins": ["oc-flight-deck"] }
```

Use the package name (`"oc-flight-deck"`): it resolves through npm and honours the package's `exports`. A local directory path will not work — OpenCode looks for `index.js`/`index.ts` at the directory root, ignores `exports`, and drops the entry silently (no load, no error, no log line). This is a real limitation, not a supported route.

The bare name tracks the newest release; append `@<version>` to pin an exact published version. The npm tarball ships the compiled `dist/` (the `prepublishOnly` step builds it before packing), so the registry entry always has a working entry point. Restart OpenCode after editing the config.

The TUI half has no direct observation surface in this build; verify it by its visible effect (the sidebar rendering).
