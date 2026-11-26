import { expect, test } from "bun:test";
import plugin from "../index.js";

function ctxFor({ tools = [], options = {} } = {}) {
  const hooks = [];
  const transforms = [];
  const tool = {
    hook(name, cb) {
      hooks.push({ name, cb });
      return { dispose() {} };
    },
    transform(cb) {
      const editor = {
        list: () => tools,
        update(id, fn) {
          const t = tools.find((x) => x.id === id);
          if (t) fn(t);
        },
      };
      cb(editor);
      transforms.push(cb);
      return { dispose() {} };
    },
    list() {
      return tools;
    },
  };
  return { ctx: { tool, options }, hooks, transforms, tools };
}

test("1. clamp: foreground shell timeout above the cap is lowered to 600000", async () => {
  const { ctx, hooks } = ctxFor();
  await plugin.setup(ctx);
  const before = hooks.find((h) => h.name === "execute.before");
  expect(before).toBeDefined();
  const event = { tool: "shell", input: { command: "sleep 3000", timeout: 14400000 } };
  before.cb(event);
  expect(event.input.timeout).toBe(600000);
  expect(event.input.command).toBe("sleep 3000");
});

test("2. background exemption: a background shell keeps its large timeout", async () => {
  const { ctx, hooks } = ctxFor();
  await plugin.setup(ctx);
  const before = hooks.find((h) => h.name === "execute.before");
  const event = { tool: "shell", input: { command: "x", background: true, timeout: 14400000 } };
  before.cb(event);
  expect(event.input.timeout).toBe(14400000);
});

test("3. small timeout untouched: a timeout at or below the cap is unchanged", async () => {
  const { ctx, hooks } = ctxFor();
  await plugin.setup(ctx);
  const before = hooks.find((h) => h.name === "execute.before");
  const event = { tool: "shell", input: { timeout: 120000 } };
  before.cb(event);
  expect(event.input.timeout).toBe(120000);
});

test("4. non-object input: null and string inputs do not throw", async () => {
  const { ctx, hooks } = ctxFor();
  await plugin.setup(ctx);
  const before = hooks.find((h) => h.name === "execute.before");
  const nullEvent = { tool: "shell", input: null };
  const stringEvent = { tool: "shell", input: "nope" };
  expect(() => before.cb(nullEvent)).not.toThrow();
  expect(() => before.cb(stringEvent)).not.toThrow();
  expect(nullEvent.input).toBeNull();
  expect(stringEvent.input).toBe("nope");
});

test("5. deadline: a never-resolving read fails fast with a terse reason", async () => {
  const tools = [{ id: "read", execute: () => new Promise(() => {}) }];
  const { ctx } = ctxFor({ tools, options: { timeoutMs: 40 } });
  await plugin.setup(ctx);
  const start = Date.now();
  let error;
  try {
    await tools[0].execute({}, {});
  } catch (err) {
    error = err;
  }
  expect(Date.now() - start).toBeLessThan(2000);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("oc-fix");
  expect(error.message).toContain("read");
  expect(error.message).toContain("abandoned");
});

test("6. fast path: a resolving tool passes its result through unchanged", async () => {
  const out = { content: "ok" };
  const tools = [{ id: "read", execute: () => Promise.resolve(out) }];
  const { ctx } = ctxFor({ tools });
  await plugin.setup(ctx);
  const result = await tools[0].execute({}, {});
  expect(result).toBe(out);
});

test("7. exempt: a task tool keeps its original execute identity", async () => {
  const original = () => new Promise(() => {});
  const tools = [{ id: "task", execute: original }];
  const { ctx } = ctxFor({ tools });
  await plugin.setup(ctx);
  expect(tools[0].execute).toBe(original);
});

test("8. no double wrap: a second transform keeps one wrapper and one result", async () => {
  const tools = [{ id: "read", execute: () => Promise.resolve({ content: "ok" }) }];
  const { ctx } = ctxFor({ tools });
  await plugin.setup(ctx);
  const once = tools[0].execute;
  await plugin.setup(ctx);
  expect(tools[0].execute).toBe(once);
  const result = await tools[0].execute({}, {});
  expect(result.content).toBe("ok");
});

test("9. a clamped call carries an inspectable oc-fix mark", async () => {
  const { ctx, hooks } = ctxFor();
  await plugin.setup(ctx);
  const before = hooks.find((h) => h.name === "execute.before");
  const after = hooks.find((h) => h.name === "execute.after");
  expect(typeof after?.cb).toBe("function");
  const call = { tool: "shell", id: "call_1", input: { command: "sleep 3000", timeout: 9999999 } };
  before.cb(call);
  expect(call.input.timeout).toBe(600000);
  const done = { tool: "shell", id: "call_1", status: "completed", result: { content: "ok" } };
  after.cb(done);
  expect(done.result.metadata["oc-fix"].clamped).toBe(true);
  expect(done.result.metadata["oc-fix"].requested).toBe(9999999);
  expect(done.result.metadata["oc-fix"].applied).toBe(600000);
  expect(done.result.content).toBe("ok");
});

test("10. an unclamped call leaves no mark", async () => {
  const { ctx, hooks } = ctxFor();
  await plugin.setup(ctx);
  const after = hooks.find((h) => h.name === "execute.after");
  const done = { tool: "shell", id: "call_2", status: "completed", result: { content: "ok" } };
  after.cb(done);
  expect(done.result.metadata).toBeUndefined();
});
