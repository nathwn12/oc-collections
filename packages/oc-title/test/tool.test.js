import { expect, test } from "bun:test";
import plugin from "../index.js";
import { createFakeCtx } from "./fake-ctx.js";

const stamped = (title, state) => ({ title, metadata: { "oc-title": { state, at: 1 } } });

function mount(ctx) {
  ctx.attachCleanup(plugin.setup(ctx));
  return ctx.tools.find((t) => t.name === "oc_title_refresh");
}
const call = (tool, input, id) => tool.execute(input, { sessionID: id });
const payload = (res) => JSON.parse(res.content);
const updates = (ctx, id) => ctx.updates.filter((u) => u.sessionID === id);

test("the plugin registers one oc_title_refresh tool", async () => {
  const ctx = createFakeCtx();
  const tool = mount(ctx);
  expect(typeof tool?.execute).toBe("function");
  expect(ctx.tools.filter((t) => t.name === "oc_title_refresh").length).toBe(1);
  await ctx.cleanup();
});

test("the tool refreshes the scope from the latest user request", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s1", stamped("active: old scope", "active"));
  ctx.seedMessages("s1", [
    { role: "user", text: "New Scope Now", time: 2 },
    { role: "assistant", text: "working", time: 1 },
  ]);
  const tool = mount(ctx);
  const out = payload(await call(tool, {}, "s1"));
  await ctx.flush();
  expect(out.ok).toBe(true);
  expect(updates(ctx, "s1").at(-1).title).toBe("active: new scope now");
  await ctx.cleanup();
});

test("an explicit scope wins over the message reader", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s2", stamped("parked: old scope", "parked"));
  const tool = mount(ctx);
  const out = payload(await call(tool, { scope: "Explicit Scope" }, "s2"));
  await ctx.flush();
  expect(out.ok).toBe(true);
  expect(updates(ctx, "s2").at(-1).title).toBe("parked: explicit scope");
  await ctx.cleanup();
});

test("a tool-only latest user message refreshes nothing", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s3", stamped("active: old scope", "active"));
  ctx.seedMessages("s3", [{ role: "user", text: "", tools: [{ name: "shell" }], time: 1 }]);
  const tool = mount(ctx);
  const out = payload(await call(tool, {}, "s3"));
  await ctx.flush();
  expect(out.ok).toBe(false);
  expect(updates(ctx, "s3").length).toBe(0);
  await ctx.cleanup();
});

test("a closed session is never refreshed through the tool", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s4", stamped("closed: old scope", "closed"));
  const tool = mount(ctx);
  const out = payload(await call(tool, { scope: "New Scope" }, "s4"));
  await ctx.flush();
  expect(out.ok).toBe(false);
  expect(updates(ctx, "s4").length).toBe(0);
  await ctx.cleanup();
});

test("the tool refuses a call with no session id", async () => {
  const ctx = createFakeCtx();
  const tool = mount(ctx);
  const out = payload(await call(tool, { scope: "New Scope" }, undefined));
  expect(out.ok).toBe(false);
  await ctx.cleanup();
});
