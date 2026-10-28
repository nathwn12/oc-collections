/**
 * The V1 plugin contract, vendored.
 *
 * This package is the V1 -> V2 bridge, so it must speak both eras - but it must
 * not *depend* on both eras. Importing the 1.x plugin package to obtain these
 * types made the bridge a mixed-generation package: its own manifest named a
 * 1.x package next to the 2.x host it mounts on. The 2.x line is
 * `@opencode/plugin`; the 1.x line is a different scope entirely. So the V1
 * shapes live here, transcribed, and `src/types.ts` re-exports them as the
 * package's V1 surface.
 *
 * These are the shapes the bridge *hands to* a V1 hook, not the 1.x SDK's rich
 * envelope types. That distinction is deliberate: the 1.x `Hooks` declaration
 * typed payloads with 1.x SDK values (`Message`, `Part`, `Model`, `Event`,
 * `Permission`, `Config`), and those types were never load-bearing here -
 * every hook payload is already handled structurally (`asHandler`,
 * `Record<string, unknown>` casts in `hooks.ts`). Declaring what this bridge
 * actually passes keeps the contract honest and keeps the 1.x line out of the
 * dependency graph.
 *
 * Hook returns are `unknown`, not `Promise<void>`: the 1.x contract said
 * `Promise<void>`, but every call site `await`s the result, so a V1 plugin that
 * returns a plain value already works at runtime. Typing it permissively
 * matches that behaviour instead of rejecting plugins the bridge runs fine.
 *
 * `unknown` survives ONLY where a value crosses the boundary untouched: a tool
 * executor's argument bag, a tool result's metadata written back on the same
 * channel it arrived on, an opaque handle (`client`, `$`), or a host-owned id
 * the bridge never dereferences. Where the bridge writes a value back into a
 * model request - `chat.params` numerics - or reads a value to build one -
 * a tool's `args` schema - the type is exact, because a mismatch there is silent
 * corruption rather than a refusal.
 */

/** Per-plugin options, passed to a V1 factory as its second argument. */
export type V1PluginOptions = Record<string, unknown>

/**
 * The V1 factory input facade (`buildV1Context` in `context.ts`).
 *
 * Fields V2 cannot describe faithfully (`client`, `$`) are opaque here: the
 * facade returns guarded proxies that warn or throw, so no caller may assume a
 * 1.x method exists.
 */
export interface V1PluginInput {
  client: unknown
  project: { id?: string } & Record<string, unknown>
  directory: string
  worktree: string
  /** A placeholder: V2 hands a plugin no server address. */
  serverUrl: URL
  experimental_workspace: { register(type: string): void }
  $: unknown
}

/**
 * A JSON-schema-shaped parameter declaration for a V1 tool.
 *
 * Deliberately not `unknown`: the bridge forwards this verbatim as the tool's
 * declared input schema (`editor.add({ input })`), so a scalar here is a
 * malformed definition rather than a pass-through value.
 */
export type V1ToolParameters = Record<string, unknown>

/** A V1 tool definition, as found in a V1 `Hooks.tool` map. */
export interface V1ToolDefinition {
  description?: string
  /** Parameter schema handed to the model. Must be an object; see V1ToolParameters. */
  args?: V1ToolParameters
  /**
   * Required. A definition the bridge cannot execute is refused at
   * registration (typed error), never registered as a tool that answers with
   * empty content. `args` stays `unknown`: the model's call input is handed
   * to the plugin untouched and never inspected here.
   */
  execute: (args: unknown, context?: unknown) => unknown
}

/* ------------------------------------------------------------------ */
/* Hook payload envelopes (what the bridge supplies / reads back)      */
/* ------------------------------------------------------------------ */

export interface V1ToolExecuteBeforeInput {
  tool: string
  sessionID: string
  callID: string
}

export interface V1ToolExecuteBeforeOutput {
  args: unknown
}

export interface V1ToolExecuteAfterInput {
  tool: string
  sessionID: string
  callID: string
  args: unknown
}

export interface V1ToolExecuteAfterOutput {
  title: string
  output: string
  metadata: unknown
}

export interface V1ShellEnvInput {
  cwd: string
}

export interface V1ShellEnvOutput {
  env: Record<string, string>
}

export interface V1ChatParamsInput {
  sessionID: unknown
  model: unknown
}

export interface V1ChatParamsOutput {
  /**
   * Generation settings are written straight into the V2 model request
   * (`hooks.ts`, `session.hook(kind)`), so they are finite numbers here: a
   * string would corrupt the request silently instead of being refused.
   */
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  /** Provider options, merged into the request's `options` object. */
  options?: Record<string, unknown>
}

export interface V1ChatHeadersInput {
  sessionID: unknown
  model: unknown
}

export interface V1ChatHeadersOutput {
  headers: Record<string, string>
}

export interface V1ChatMessageInput {
  sessionID: unknown
  messageID: unknown
}

export interface V1ChatMessageOutput {
  message: {
    role: string
    content?: string
    files?: unknown
    agents?: unknown
    skills?: unknown
  }
  parts: unknown[]
}

export interface V1PermissionAskInput {
  sessionID: unknown
  action: unknown
  resources: unknown
}

export interface V1PermissionAskOutput {
  status?: unknown
}

export interface V1MessagesTransformInput {
  sessionID: unknown
}

export interface V1MessagesTransformOutput {
  messages: Array<{ info: Record<string, unknown>; parts: unknown[] }>
}

export interface V1SystemTransformInput {
  sessionID: unknown
  model: unknown
}

export interface V1SystemTransformOutput {
  system: string[]
}

export interface V1CompactingInput {
  sessionID: unknown
}

export interface V1CompactingOutput {
  /** Appended to the compaction system prompt. */
  context: string[]
  /** Accepted and ignored: V2 compaction carries no prompt field. */
  prompt?: string
}

export interface V1ToolDefinitionInput {
  toolID: string
}

export interface V1ToolDefinitionOutput {
  description: string
  parameters: unknown
}

/**
 * The V1 hook table a V1 factory returns.
 *
 * Every key `hooks.ts` recognises, refused ones included - a refused hook is
 * still part of the contract a V1 plugin may declare, and the bridge's job is
 * to answer it out loud rather than reject the type.
 */
export interface V1Hooks {
  dispose?: () => unknown
  event?: (input: { event: unknown }) => unknown
  config?: (input: unknown) => unknown
  auth?: unknown
  provider?: unknown
  tool?: { [key: string]: V1ToolDefinition }
  "tool.execute.before"?: (input: V1ToolExecuteBeforeInput, output: V1ToolExecuteBeforeOutput) => unknown
  "tool.execute.after"?: (input: V1ToolExecuteAfterInput, output: V1ToolExecuteAfterOutput) => unknown
  "shell.env"?: (input: V1ShellEnvInput, output: V1ShellEnvOutput) => unknown
  "chat.params"?: (input: V1ChatParamsInput, output: V1ChatParamsOutput) => unknown
  "chat.headers"?: (input: V1ChatHeadersInput, output: V1ChatHeadersOutput) => unknown
  "chat.message"?: (input: V1ChatMessageInput, output: V1ChatMessageOutput) => unknown
  "permission.ask"?: (input: V1PermissionAskInput, output: V1PermissionAskOutput) => unknown
  "experimental.chat.messages.transform"?: (
    input: V1MessagesTransformInput,
    output: V1MessagesTransformOutput,
  ) => unknown
  "experimental.chat.system.transform"?: (input: V1SystemTransformInput, output: V1SystemTransformOutput) => unknown
  "experimental.session.compacting"?: (input: V1CompactingInput, output: V1CompactingOutput) => unknown
  "tool.definition"?: (input: V1ToolDefinitionInput, output: V1ToolDefinitionOutput) => unknown
  "command.execute.before"?: (input: unknown, output: unknown) => unknown
  "experimental.provider.small_model"?: (input: unknown, output: unknown) => unknown
  "experimental.compaction.autocontinue"?: (input: unknown, output: unknown) => unknown
  "experimental.text.complete"?: (input: unknown, output: unknown) => unknown
}

/** A V1 plugin factory: `async (input) => Hooks`. */
export type V1Plugin = (input: V1PluginInput, options?: V1PluginOptions) => Promise<V1Hooks>
