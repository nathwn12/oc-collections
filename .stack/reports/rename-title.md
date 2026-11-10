# rename-title — report

```text
Diff:       src/tui/index.tsx (1 line: plugin id), fixtures/scaffold.test.ts (1 line: the pin), dist/tui/index.js (regenerated)
Red first:  bun test fixtures/scaffold.test.ts — expected "oc-flight-deck", received "flight-deck-tui", 8 pass / 1 fail (exit 1)
a11y:       unchanged — no control, label, focus order or keybinding touched; the row is host-rendered from `id`
Bundle:     dist/tui/index.js 151000 -> 150999 bytes (-1: "flight-deck-tui" 15 chars -> "oc-flight-deck" 14)
```

## Outcome

The TUI plugin id is now `oc-flight-deck`, so the plugin-manager row reads `oc-flight-deck` instead of the id-derived `flight-deck-tui`. Nothing else changed: one object field, the test that pins it, and the regenerated bundle.

The previous brief's target was wrong and its edits were reverted before this one began. The `title: "Flight Deck"` toasts (3) and `DEFAULT_FOOTER_TEXT` are byte-identical to `1eed113` — an earlier session-visible edit to those four strings and to `fixtures/config.test.ts` was undone with `git restore` and the tree verified clean (`git status --porcelain` printed only `?? .stack/`). The lead's correction stands: the row is the plugin id, not the footer title.

## Evidence

All commands run at repo head `1eed1138fb6a4fd453b6bb73fb354f6fff1b9980`, cwd `packages/oc-flight-deck`, bun 1.4.4 / node v26.13.0.

**Host mechanism (upstream, `Q:\PROJECTS\INSPIRATION\opencode` @ `e311199f4a`).** The row label is the id, not a name:

```text
packages/plugin/src/tui/plugin.ts
export interface Definition {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
```

```text
packages/tui/src/feature-plugins/system/plugins.tsx
function label(entry: Entry, context: Plugin.Context) {
  if (entry.runtime === "tui") return entry.id ?? entry.target
  return entry.plugin.id ?? source(entry.plugin, context)
}
```

There is no `name` field to set; the dialog's `title` for a `runtime === "tui"` entry is `entry.id ?? entry.target`. Enabling by directive also matches on id (`packages/tui/src/config/index.tsx:79` `plugins: Schema.Array(Plugin)`, "Ordered plugin enablement directives"; `matches(target, plugin.id)` in `packages/tui/src/plugin/context.tsx`).

**Red first — `fixtures/scaffold.test.ts:298` was flipped to the new id before source changed:**

```text
298 |     expect(flightDeck.id).toBe("oc-flight-deck");
error: expect(received).toBe(expected)
Expected: "oc-flight-deck"
Received: "flight-deck-tui"
(fail) flight deck plugin > registers the sidebar slot by default and removes it on cleanup [1.36ms]
 8 pass
 1 fail
EXIT=1
```

**Green — same file after the one-line source change:**

```text
 9 pass
 0 fail
Ran 9 tests across 1 file. [97.00ms]
EXIT=0
```

**Brief's check, run at the final state (staged dist, no commit):**

```text
$ bun run typecheck && bun test
$ tsc --noEmit
 555 pass
 0 fail
 3391 expect() calls
Ran 555 tests across 25 files. [5.70s]
CHECK_EXIT=0
COMPILE_EXIT=0
DIST_DIFF_EXIT=0          # git diff --exit-code -- packages/oc-flight-deck/dist, after staging dist
```

`COMPILE_EXIT=0` immediately followed by `DIST_DIFF_EXIT=0` is the reopen: a second compile changed nothing against the staged bundle, so the build is deterministic and `check:dist` would pass at this tree.

**The whole diff (3 files, 3 lines):**

```diff
diff --git a/packages/oc-flight-deck/src/tui/index.tsx b/packages/oc-flight-deck/src/tui/index.tsx
@@ -45,7 +45,7 @@
 export default Plugin.define({
-  id: "flight-deck-tui",
+  id: "oc-flight-deck",
   setup(context) {
diff --git a/packages/oc-flight-deck/fixtures/scaffold.test.ts b/packages/oc-flight-deck/fixtures/scaffold.test.ts
@@ -295,7 +295,7 @@ describe("flight deck plugin", () => {
-    expect(flightDeck.id).toBe("flight-deck-tui");
+    expect(flightDeck.id).toBe("oc-flight-deck");
diff --git a/packages/oc-flight-deck/dist/tui/index.js b/packages/oc-flight-deck/dist/tui/index.js
@@ -4255,7 +4255,7 @@
 var tui_default = Plugin.define({
-  id: "flight-deck-tui",
+  id: "oc-flight-deck",
```

**Built output, the new id:**

```text
dist/tui/index.js:4258: id: "oc-flight-deck",
```

**No `flight-deck-tui` literal survives in `dist/`, or anywhere in the repo:**

```text
--- any flight-deck-tui in dist (expect none) ---
                                   # no hits
--- flight-deck-tui anywhere in repo (expect none) ---
REPO_GREP_EXIT=1                   # git grep -n flight-deck-tui -> no match
```

**Persisted keys are explicit literals, checked not assumed.** Declared in source, passed straight to `storage.memory(...)`, no interpolation of the plugin id anywhere near them:

```text
src/tui/guard.ts:106:  export const GUARD_KEY = "flight-deck.guard";
src/tui/go.ts:167:     export const GO_KEY = "flight-deck.go";
src/tui/ticker.ts:70:  export const TICKER_KEY = "flight-deck.frame";

src/tui/guard.ts:223:  opened = storage.memory(GUARD_KEY, { initial: { value: null } });
src/tui/go.ts:242:     opened = storage.memory(GO_KEY, { initial: { value: null, reason: null } });
src/tui/ticker.ts:95:  opened = storage.memory(TICKER_KEY, { initial: { frame: 0 } });

dist/tui/index.js:2752: var GUARD_KEY = "flight-deck.guard";
dist/tui/index.js:3002: var GO_KEY = "flight-deck.go";
dist/tui/index.js:3524: var TICKER_KEY = "flight-deck.frame";
```

A grep of the three key modules plus `index.tsx` for `` `flight-deck `` / `context.id` / `plugin.id` returned one hit only, a comment naming the config file:

```text
src/tui/index.tsx:42: //   2. the one global config file, `flight-deck.jsonc` in the opencode
```

So `flight-deck.guard`, `flight-deck.go` and `flight-deck.frame` are unaffected by the id change: they are constants in the bundle, not derived from `id`. The config path `~/.config/opencode/flight-deck.jsonc` is likewise untouched.

**The other id in this package did not move:**

```text
dist/index.js:5: id: "flight-deck.host",
```

**No local enablement directive is orphaned.** Grep of the owner's own config for the old id:

```text
C:\Users\nathan\.config\opencode\opencode.jsonc:21: "oc-flight-deck@0.21.3"   # package spec, not an id
# no flight-deck-tui anywhere under ~/.config/opencode
```

## Unverified

- **The row rendering in a live TUI.** I did not launch the TUI and open the plugin manager; there is no headless harness for it here. The claim rests on host source at `e311199` (`label()` above) plus the dialog test at `packages/tui/test/cli/tui/plugins-dialog.test.tsx`, which identifies rows by ids like `team.plugins`, `broken.plugin`, `local.plugin`.
- **The exact string in the owner's screenshot.** Today's installed copy (`~/.cache/opencode/npm/oc-flight-deck@0.21.1/.../dist/tui/index.js:4258`) declares `id: "flight-deck-tui"`, so a row labelled from the id should read `flight-deck-tui`, not `flight-deck`. Either the row was truncated to the dialog width or that install differs. It does not change the change: after this, the id — and therefore the label — is `oc-flight-deck`.
- **The published package.** Nothing was built for or published to npm, so I cannot show the row in the version the owner actually runs.

## Scope

Touched, all inside `packages/oc-flight-deck`:

| Path | Why | In `Owns`? |
|---|---|---|
| `src/tui/index.tsx` | the id, one line | yes |
| `dist/tui/index.js` | regenerated by `bun scripts/build.ts`, never hand-edited | yes (`dist/**`) |
| `fixtures/scaffold.test.ts` | the pin on `flightDeck.id`; without it the check cannot pass | **no — see note** |

`fixtures/scaffold.test.ts` is outside the brief's literal `Owns` list but inside `packages/oc-flight-deck`, and the brief's own `Check` (`bun run check`) cannot exit 0 while the fixture asserts the old id. I made the smallest edit there — the assertion value — and touched nothing else in the file.

Not done on purpose:

- **No `CHANGELOG.md` entry.** The instruction was "keep the diff to the id". Recommended before publish, since the id is the key for enable/disable directives: anyone with `plugin: ["-flight-deck-tui"]` in `opencode.jsonc`, or a `plugin_enabled` record keyed by it, loses that directive and should re-point it at `oc-flight-deck`.
- No version bump, no commit, no publish. The three paths are staged so `git diff --exit-code -- dist` reads 0 at the handed-back tree; the lead commits.
- The host plugin id `flight-deck.host` (`src/index.ts`) was left alone — the row in question is the TUI plugin.
- Temp files I wrote under `.stack/` while capturing output were deleted.

## Lesson

The row's label is `entry.id ?? entry.target` in `packages/tui/src/feature-plugins/system/plugins.tsx`, so a "display name" for a TUI plugin does not exist as a separate field — the id *is* the display surface, and it is also the enablement key. That double duty is the whole risk: a rename is a one-line diff whose consequence lives in users' config files, which is why the keys that must not move (`flight-deck.guard`, `flight-deck.go`, `flight-deck.frame`, the `flight-deck.jsonc` path) were checked as literals in the bundle rather than assumed from the old brief.
