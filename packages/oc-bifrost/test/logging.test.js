import { test } from "node:test"
import assert from "node:assert/strict"
import { createCorrelationId, formatLogLine, log } from "../dist/log.js"
import { createReporter } from "../dist/report.js"
import { buildV1Context } from "../dist/context.js"

/**
 * Structured, correlated, payload-free logging.
 *
 * Every bridge line carries level + a short event name + plugin id where
 * relevant + one correlation id per bridge invocation, and plugin code or
 * user data never enters the log.
 */

function captureConsole() {
  const original = { log: console.log, warn: console.warn }
  const logged = []
  const warned = []
  console.log = (line) => logged.push(String(line))
  console.warn = (line) => warned.push(String(line))
  return {
    logged,
    warned,
    restore() {
      console.log = original.log
      console.warn = original.warn
    },
  }
}

function fakeContext() {
  return {
    location: { directory: process.cwd(), project: { id: "test" } },
    options: {},
    app: { name: "opencode", version: "2.0.0", channel: "test" },
    tool: { hook: async () => {} },
    shell: { hook: async () => {} },
    session: { hook: async () => {} },
    permission: { hook: async () => {} },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    storage: { get: async () => undefined, set: async () => {} },
  }
}

test("logging: lines are JSON with level, event, plugin, and correlation id", () => {
  const line = formatLogLine("warn", "bridge.warn", {
    plugin: "my-plugin",
    correlationId: "abc123",
    detail: "something happened",
  })
  const parsed = JSON.parse(line)
  assert.equal(parsed.level, "warn")
  assert.equal(parsed.event, "bridge.warn")
  assert.equal(parsed.plugin, "my-plugin")
  assert.equal(parsed.correlationId, "abc123")
  assert.equal(parsed.detail, "something happened")
  assert.ok(typeof parsed.ts === "string")
})

test("logging: info goes to stdout, warn/error to stderr, and the line is returned", () => {
  const cap = captureConsole()
  try {
    const info = log("info", "bridge.mount_report", { plugin: "p", correlationId: "c" })
    const warn = log("warn", "bridge.warn", { plugin: "p", correlationId: "c" })
    const error = log("error", "bridge.sink_unavailable", { correlationId: "c" })
    assert.equal(cap.logged.length, 1)
    assert.equal(cap.warned.length, 2)
    assert.equal(cap.logged[0], info)
    assert.deepEqual(cap.warned, [warn, error])
    assert.equal(JSON.parse(info).level, "info")
  } finally {
    cap.restore()
  }
})

test("logging: correlation ids are unique per bridge invocation", () => {
  const first = createCorrelationId()
  const second = createCorrelationId()
  assert.ok(typeof first === "string" && first.length > 0)
  assert.notEqual(first, second)
})

test("logging: the reporter emits structured lines with its plugin id and correlation id", () => {
  const cap = captureConsole()
  const lines = []
  try {
    const reporter = createReporter("my-plugin", { sink: (line) => lines.push(line), correlationId: "corr-1" })
    assert.equal(reporter.correlationId, "corr-1")
    reporter.warn("a warning happened")
    assert.equal(cap.warned.length, 1)
    const parsed = JSON.parse(cap.warned[0])
    assert.equal(parsed.level, "warn")
    assert.equal(parsed.event, "bridge.warn")
    assert.equal(parsed.plugin, "my-plugin")
    assert.equal(parsed.correlationId, "corr-1")
    assert.match(parsed.detail, /a warning happened/)
    assert.deepEqual(lines, cap.warned, "the sink mirrors the same structured line")
  } finally {
    cap.restore()
  }
})

test("logging: hook records carry short event names", () => {
  const cap = captureConsole()
  try {
    const reporter = createReporter("evt-plugin", { correlationId: "corr-2" })
    reporter.record("config", "unsupported", "no equivalent")
    reporter.record("tool.execute.after", "partial", "a stated loss")
    assert.equal(cap.warned.length, 2)
    assert.equal(JSON.parse(cap.warned[0]).event, "hook.unsupported")
    assert.equal(JSON.parse(cap.warned[1]).event, "hook.partial")
    for (const line of cap.warned) {
      const parsed = JSON.parse(line)
      assert.equal(parsed.plugin, "evt-plugin")
      assert.equal(parsed.correlationId, "corr-2")
    }
  } finally {
    cap.restore()
  }
})

test("logging: client.app.log never emits the message body", async () => {
  const cap = captureConsole()
  try {
    const lines = []
    const reporter = createReporter("facade-plugin", { sink: (line) => lines.push(line), correlationId: "corr-3" })
    const facade = buildV1Context(fakeContext(), reporter)
    const sentinel = `SENTINEL-${Math.random().toString(36).slice(2)}`
    await facade.client.app.log({ body: { service: "my-service", message: sentinel } })
    assert.equal(cap.logged.length, 1)
    const parsed = JSON.parse(cap.logged[0])
    assert.equal(parsed.event, "app.log")
    assert.equal(parsed.plugin, "my-service")
    assert.equal(parsed.correlationId, "corr-3")
    assert.equal(parsed.messageLength, sentinel.length)
    assert.ok(!cap.logged[0].includes(sentinel), "the payload body must not enter the log")
  } finally {
    cap.restore()
  }
})

test("logging: payload-shaped fields are stripped defensively", () => {
  const line = formatLogLine("info", "app.log", {
    plugin: "p",
    body: { secret: 1 },
    input: { command: "rm -rf ~" },
    output: "user data",
    options: { tag: "user value" },
    message: "a body",
  })
  const parsed = JSON.parse(line)
  for (const key of ["body", "input", "output", "options", "message"]) {
    assert.ok(!(key in parsed), `${key} must be stripped`)
  }
  assert.ok(!line.includes("user value"))
  assert.ok(!line.includes("rm -rf"))
})
