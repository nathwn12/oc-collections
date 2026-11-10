# Install parity research

## Outcome

**Question:** Can the V2 plugin deliver the shipped agents, slash command, skills and tools from one configured Git package, without writing into `~/.config/opencode` beyond the user's config line?

**Pinned:** OpenCode `v2.2.6`, specified by `.stack/briefs/install-parity.md:7,34`; the installed executable independently returned `opencode v2.2.6`. Git tag `v2.2.6` resolves to `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06`. All upstream source links below are pinned to that commit, retrieved 2026-11-10, tier 1. Local repo observations are not upstream guarantees.

**Verdict: PARITY** — the pinned V2 APIs support a one-line Git install with in-memory agent, command and skill registration, but oc-stacked must first implement agent and command registration; this is a feasibility verdict, not a claim that the current package already has parity.

## Evidence

### 1. Package specification and cache

The one-line configuration, using this checkout's origin, is:

```json
{"plugins":["oc-stacked@git+https://github.com/nathwn12/oc-stacked.git"]}
```

The published-package form would be `{"plugins":["oc-stacked"]}` or `{"plugins":["oc-stacked@1.2.3"]}` **if that name and version are published**. Local `package.json:2,45` says `"name": "oc-stacked"` and `"private": true`; publication and ownership of that registry name are not established.

* [V2 plugin docs:9-15,107-109,123-125](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/services/site/src/docs/content/plugins.mdx#L9-L15) show `"plugins": [ "opencode-acme-plugin", "opencode-acme-plugin@1.2.0" ]` and say “Package installation accepts npm names with versions, tags, or ranges, plus npm-compatible Git package specifications.” They also say “Server startup loads cached package plugins immediately, installs missing packages in the background”.
* [resolver `packages/core/src/plugin/module.ts:107-113`](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/plugin/module.ts#L107-L113) calls `npm.resolve(operation.target)` or `npm.add(operation.target)` for a non-local target. [`packages/util/src/npm.ts:59-76,139,343-346`](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/util/src/npm.ts#L59-L76) uses `npa(pkg)`, accepts `result.type === "git"`, recognizes registry `"version", "range", "tag"`, and places installs under `path.join(global.cache, "npm", key(pkg, target))`.
* Git spelling is the npm-compatible named Git form used in local Superpowers `.opencode/INSTALL.md:21-28`: `"plugins": ["superpowers@git+https://github.com/obra/superpowers.git"]`. That example is tier 5; the pinned resolver and documentation above are the authority. No live Git installation was attempted.

### 2. Agents: yes, via update-as-upsert, not V1 config hook

* [V2 server docs:15-23,1809-1810](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/services/site/src/docs/content/build/plugins/server.mdx#L1809-L1810): “`setup` runs when the plugin loads” and “V2 reads the default export's `id` and `setup()` (or `effect()` for Effect plugins), ignoring `server()`.”
* [Promise API `packages/plugin/src/promise/agent.ts:6-16`](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/plugin/src/promise/agent.ts#L6-L16) exposes `readonly transform: Transform<AgentEditor>` and `update(id: string, update: (agent: ...) => void)`; there is no `add` in that interface. Critically, [implementation `packages/core/src/agent.ts:80-84`](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/agent.ts#L80-L84) says `const current = editor.agents.get(id) ?? (Info.default(id) ...); if (!editor.agents.has(id)) editor.agents.set(id, current); fn(current)`. Therefore `await ctx.agent.transform(editor => { for (...) editor.update(id, agent => { ... }) })` creates new IDs as well as updating existing ones; the loop is not limited by a schema count.
* [Agent schema:23-34](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/schema/src/agent.ts#L23-L34) explicitly has `model: Model.Ref.pipe(optional)`, `system: Schema.String.pipe(optional)`, `description: Schema.String.pipe(optional)`, and `mode: Schema.Literals(["subagent", "primary", "all"])`. The inline prompt field is **`system`**, not `prompt`; set `agent.system = body`. The existing config-to-agent bridge demonstrates model conversion into `{ id: item.model.model, providerID: item.model.providerID, ... }` and `agent.system = item.system` at [config/plugin/agent.ts:82-97](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/config/plugin/agent.ts#L82-L97). Routing values require correct parsing into that structured model form.
* For static config the V2 field is plural `agents`, not `config.agent`: [config schema:64-65](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/schema/src/config.ts#L64-L65) says `agents: Schema.Record(Schema.String, ConfigAgent.Info)`; [config agent schema:11-16](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/schema/src/config/agent.ts#L11-L16) has `system: Schema.String.pipe(optional)`.

### 3. Commands: yes, transform with inline executor

* [Promise API `packages/plugin/src/promise/command.ts:13-25`](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/plugin/src/promise/command.ts#L13-L25) defines `CommandDefinition` as `name`, optional `description`, and `execute: (input: CommandInvocation) => Promise<void>`, with `editor.add(definition)` and `ctx.command.transform`.
* [Server docs:395-408](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/services/site/src/docs/content/build/plugins/server.mdx#L395-L408) show an inline body: `await ctx.command.transform((editor) => { editor.add({ ... execute: async ({ sessionID, prompt, delivery }) => { await ctx.session.prompt({ ...prompt, sessionID, text: \`Review these changes for security issues.\n\n${prompt.text}\`, delivery }) } }) })`.
* Static config uses `commands` and `template`: [config.ts:94-95](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/schema/src/config.ts#L94-L95) says `commands: Schema.Record(Schema.String, ConfigCommand.Info)`, and [config/command.ts:7-13](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/schema/src/config/command.ts#L7-L13) says `template: Schema.String`, `agent: Schema.String.pipe(optional)`, plus model/subagent options. It is not file-only. For exact `/stack` equivalence the custom executor must preserve `$ARGUMENTS`, empty-input behavior and `agent: lead` semantics from `commands/stack.md:2-10`; the native config executor's implementation is [config/plugin/command.ts:49-105,154-176](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/config/plugin/command.ts#L49-L105). Exact semantic equivalence has not been implemented or tested.

### 4. Skills: the brief's V1 mechanism does not apply to V2

* [V2 config schema:91-92](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/schema/src/config.ts#L91-L92) specifies `skills: Schema.String.pipe(Schema.Array, optional)`, not an object with `.paths`. The cited local Superpowers `.opencode/plugins/superpowers.js:228-236` explicitly checks `if (Array.isArray(config.skills)) return;` and labels the push as V1; lines 274-283 describe V2 setup separately.
* [Promise skill API:6-16](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/plugin/src/promise/skill.ts#L6-L16) exposes `add(skill: Skill.Info): void` and `readonly transform: Transform<SkillEditor>`. The V2 docs say “Register a transform to inspect, add, update, or remove skills” at [server.mdx:878-886](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/services/site/src/docs/content/build/plugins/server.mdx#L878-L886).
* Local `lib/skills.js:7-11,19-47` calculates `packageRoot` from `fileURLToPath(import.meta.url)`, joins `skills`, and reads absolute skill file paths. This calculation is module-relative, not cwd-relative, if the module was loaded from the cached package. It is not a guarantee about the standalone resolution of relative strings in OpenCode's `skills` config. Local `index.js:4-6` describes its existing V2 skill registration; inspect/runtime test required to prove its full success in a cached install.

### 5. Remaining writes and limitations

* An actual install necessarily writes the **harness package cache**, per the resolver evidence; the question excludes plugin writes into global OpenCode config, not cache writes. An edit to `opencode.json` is itself needed. The shipped `scripts/install.mjs:184-190` currently links the plugin and copies agents and commands into the config directories; those writes are avoidable after implementation of the APIs above, not automatically avoided by the current package.
* Local `package.json:8-10` declares a `stack` executable; `bin/stack.js:2-5,9-15` describes it as a fallback CLI usable without OpenCode. A harness-cached package does not establish a globally available `stack` command. If global PATH access to that optional fallback is required, expose/install it separately; `node <cached-package>/bin/stack.js ...` is a possible direct invocation, subject to knowing the cache path. This does not block parity for the plugin, slash command and tools.
* Stack project state writes are part of operation, not global config installation: `lib/tools.js:85-91` describes ledger writes and `index.js:19` imports `seedStack`. No claim is made that runtime is filesystem-write-free everywhere.
* Git access, registry publication, installed package contents at the remote branch, the native command's exact model/agent behavior, and first-run ordering are not proven by this source read. The Git URL is unpinned; pin a tag or complete commit for reproducibility. The local checkout's files or uncommitted changes need not exist at origin.

### Command receipts

* `git ls-remote --tags https://github.com/anomalyco/opencode.git 'refs/tags/v2.2.6' 'refs/tags/v2.2.6^{}'` → `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06 refs/tags/v2.2.6`; exit 0.
* `opencode --version` → `opencode v2.2.6`; exit 0. `git remote get-url origin` → `https://github.com/nathwn12/oc-stacked.git` (same shell invocation; command completed successfully before version check).
* Local search: `Get-ChildItem 'Q:\PROJECTS' -Directory -Recurse -Filter opencode -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'packages\opencode\src') } | Select-Object -ExpandProperty FullName` → no output; the appended `$LASTEXITCODE` was empty, not a valid native exit-status receipt. It searched only the legacy path requested in the brief, not every possible V2 checkout.
* `Invoke-RestMethod https://api.github.com/repos/anomalyco/opencode/git/trees/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06?recursive=1` filtered for `packages/(core|schema)/src/(plugin|config|agent|command|skill)` → paths including `packages/core/src/agent.ts`, `packages/core/src/plugin/module.ts`, `packages/schema/src/config.ts`; `truncated: False`; PowerShell completed normally. Subsequent pinned raw GitHub reads used `Invoke-WebRequest` and printed the cited numbered lines; the batch printed `PowerShell exit: 0` (explicit completion marker, not an independently captured native process exit status).

## Unverified

* UNVERIFIED: successful real Git install and cache population on this Windows host — no install was run, to avoid outside-seam writes.
* UNVERIFIED: exact `/stack` executor equivalence, routing/model handling, all 24 agents visible, and full startup behavior — implementation and end-to-end test are outside this research seam.
* UNVERIFIED: a published npm package named `oc-stacked` belonging to this project — local manifest marks it private; no registry identity check was made.
* UNVERIFIED: whether `stack` is globally on PATH after cache installation — no runtime install was attempted; no upstream guarantee was located in the cited material.

## Scope

Only `.stack/reports/install-parity.md`, the brief's Owns path, was written. No implementation files were edited; no commit was made.

## Lesson

V2's `AgentEditor.update` looks update-only in its interface but creates absent agents in its implementation. Conversely, Superpowers' attractive `skills.paths.push` snippet is explicitly V1. Read both the versioned implementation and the schema before deciding that an install requires copied files; then prove the candidate with an isolated cached-install integration test.
