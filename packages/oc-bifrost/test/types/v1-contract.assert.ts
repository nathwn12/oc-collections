/**
 * Compile-time contract assertions. Never executed: `test/v1-contract.test.js`
 * runs `tsc -p test/types/tsconfig.json` and requires exit 0.
 *
 * Every `@ts-expect-error` below is a NEGATIVE assertion. If the contract ever
 * loosens enough to admit the value, the directive becomes unused (TS2578) and
 * the check goes red - that is the regression alarm. The positive controls at
 * the bottom keep the file honest: a well-formed definition must still compile
 * with no directive.
 */
import type { V1ChatParamsOutput, V1ToolDefinition } from "../../src/v1-contract.js"

// A tool without an executor is a tool the bridge cannot run: refused at
// registration, and unrepresentable here.
// @ts-expect-error - execute is required
export const noExecutor: V1ToolDefinition = { description: "no executor" }

// A tool's declared parameters are a schema handed to the model, not a scalar.
// @ts-expect-error - args must be an object schema
export const scalarParameters: V1ToolDefinition = { args: "type:object", execute: () => ({ content: "" }) }

// chat.params values are written straight into the model request, so a string
// temperature is a corrupted request rather than a value the bridge can use.
// @ts-expect-error - temperature is a finite number
export const stringTemperature: V1ChatParamsOutput = { temperature: "hot" }

// @ts-expect-error - topP is a finite number
export const stringTopP: V1ChatParamsOutput = { topP: "0.9" }

// Positive control: a well-formed definition typechecks with no directive.
export const validDefinition: V1ToolDefinition = {
  description: "runs",
  args: { type: "object", properties: { q: { type: "string" } } },
  execute: (args) => ({ content: String(args) }),
}

export const validParams: V1ChatParamsOutput = {
  temperature: 0.2,
  topP: 0.9,
  topK: 40,
  maxOutputTokens: 128,
  options: { reasoningEffort: "low" },
}
