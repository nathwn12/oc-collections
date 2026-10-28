import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { registerV1Hooks, V1ToolDefinitionError } from "../dist/hooks.js"
import { createReporter } from "../dist/report.js"

/**
 * The V1 tool/`chat.params` contract, held at the two places it can leak:
 *
 *   1. runtime - a definition the bridge cannot honour must be refused by name,
 *      never registered as a tool that answers with empty content;
 *   2. compile time - the vendored types must reject the same shapes, proven by
 *      `@ts-expect-error` assertions in `types/v1-contract.assert.ts`.
 *
 * Both are exercised because a JS plugin (or a cast) bypasses types, and a type
 * check alone never runs the bridge.
 */

/** Minimal V2 context; records tool transforms and session hook callbacks. */
function fakeContext() {
  const transforms = []
  const sessionHooks = new Map()
  const ctx = {
    location: { directory: process.cwd(), project: { id: "test" } },
    options: {},
    app: { name: "opencode", version: "2.2.0", channel: "test" },
    tool: {
      hook: async () => {},
      transform: async (callback) => {
        transforms.push(callback)
      },
      list: async () => [],
      reload: async () => {},
    },
    shell: { hook: async () => {} },
    session: {
      hook: async (name, callback) => {
        const list = sessionHooks.get(name) ?? []
        list.push(callback)
        sessionHooks.set(name, list)
      },
    },
    permission: { hook: async () => {} },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {},
      }),
    },
    storage: { get: async () => undefined, set: async () => {} },
  }
  return { ctx, transforms, sessionHooks }
}

test("contract: a tool definition with no executor is refused, not registered as empty content", async () => {
  const { ctx, transforms } = fakeContext()
  await assert.rejects(
    () => registerV1Hooks(ctx, { tool: { broken: { description: "declared but not runnable" } } }, createReporter("no-exec", {})),
    (error) => {
      assert.ok(error instanceof V1ToolDefinitionError, `expected V1ToolDefinitionError, got ${error?.name}`)
      assert.equal(error.code, "oc-bifrost/v1-tool-definition")
      assert.equal(error.tool, "broken")
      assert.equal(error.field, "execute")
      assert.match(error.message, /execute is missing/)
      assert.match(error.message, /answer with empty content/)
      return true
    },
  )
  assert.equal(transforms.length, 0, "a refused definition must not queue a tool transform")
})

test("contract: a non-callable executor is refused by name", async () => {
  const { ctx } = fakeContext()
  await assert.rejects(
    () => registerV1Hooks(ctx, { tool: { broken: { execute: "echo" } } }, createReporter("bad-exec", {})),
    (error) => {
      assert.equal(error.code, "oc-bifrost/v1-tool-definition")
      assert.equal(error.field, "execute")
      assert.match(error.message, /execute is string, not a function/)
      return true
    },
  )
})

test("contract: a tool whose args is not an object schema is refused", async () => {
  const { ctx, transforms } = fakeContext()
  await assert.rejects(
    () => registerV1Hooks(ctx, { tool: { bad: { args: "type:object", execute: () => "" } } }, createReporter("bad-args", {})),
    (error) => {
      assert.equal(error.code, "oc-bifrost/v1-tool-definition")
      assert.equal(error.tool, "bad")
      assert.equal(error.field, "args")
      assert.match(error.message, /not an object schema/)
      return true
    },
  )
  assert.equal(transforms.length, 0)
})

test("contract: a well-formed V1 tool still registers and runs", async () => {
  const { ctx, transforms } = fakeContext()
  await registerV1Hooks(
    ctx,
    {
      tool: {
        echo: {
          description: "echoes",
          args: { type: "object", properties: { q: { type: "string" } } },
          execute: async (input) => ({ content: `got ${input}` }),
        },
      },
    },
    createReporter("ok", {}),
  )
  assert.equal(transforms.length, 1, "a valid definition must reach ctx.tool.transform")
  const added = []
  transforms[0]({ add: (tool) => added.push(tool), update: () => {}, remove: () => {}, list: () => [], get: () => undefined })
  assert.equal(added.length, 1)
  assert.equal(added[0].name, "echo")
  assert.deepEqual(added[0].input, { type: "object", properties: { q: { type: "string" } } })
  assert.deepEqual(await added[0].execute("x"), { content: "got x" })
})

test("contract: a wrong-typed generation setting never reaches the model request", async () => {
  // Plain JS on purpose: this is the cast/JS-plugin path the types cannot catch.
  const { ctx, sessionHooks } = fakeContext()
  const warnings = []
  const reporter = createReporter("params", { sink: (line) => warnings.push(line) })
  await registerV1Hooks(
    ctx,
    {
      "chat.params": async (_input, output) => {
        output.temperature = "hot"
        output.topP = 0.9
      },
    },
    reporter,
  )
  const callbacks = sessionHooks.get("context") ?? []
  assert.equal(callbacks.length, 1, "chat.params must register on the context kind")
  const event = { sessionID: "s", model: {}, options: { temperature: 0.5 } }
  await callbacks[0](event)

  assert.equal(event.options.temperature, 0.5, "a string temperature must not overwrite the request")
  assert.equal(event.options.topP, 0.9, "a valid numeric setting must still land")
  assert.ok(
    warnings.some((line) => line.includes("ignored output.temperature")),
    `the refusal must be logged; warnings: ${warnings.join(" | ")}`,
  )
})

test("contract: the vendored V1 types reject an unexecutable tool and a non-numeric setting", () => {
  // The compile-time half: `types/v1-contract.assert.ts` carries @ts-expect-error
  // on every shape the contract must refuse. A looser contract makes those
  // directives unused (TS2578), so tsc exits non-zero here.
  const require = createRequire(import.meta.url)
  const tsc = require.resolve("typescript/bin/tsc")
  const config = fileURLToPath(new URL("./types/tsconfig.json", import.meta.url))
  const result = spawnSync(process.execPath, [tsc, "-p", config], { encoding: "utf8" })
  assert.equal(result.status, 0, `the type contract must fail closed:\n${result.stdout ?? ""}${result.stderr ?? ""}`)
})
