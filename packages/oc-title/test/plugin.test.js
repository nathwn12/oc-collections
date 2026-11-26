import { expect, test } from "bun:test";
import plugin from "../index.js";
import { createFakeCtx, event } from "./fake-ctx.js";

function mount(ctx) {
  ctx.attachCleanup(plugin.setup(ctx));
  return ctx;
}

const lastUpdateFor = (ctx, sessionID) =>
  ctx.updates.filter((u) => u.sessionID === sessionID).at(-1);
const lastFor = (ctx, sessionID) => lastUpdateFor(ctx, sessionID)?.title;

test("setup is synchronous and returns a cleanup function", async () => {
  const ctx = createFakeCtx();
  const cleanup = plugin.setup(ctx);
  expect(plugin.id).toBe("oc-title");
  expect(typeof cleanup).toBe("function");
  ctx.attachCleanup(cleanup);
  await ctx.cleanup();
});

test("session.created writes active: with the title lowercased", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s1", { title: "Hello World" });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.created", { id: "s1", seq: 1, title: "Hello World" }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  expect(lastFor(ctx, "s1")).toBe("active: hello world");
});

test("session.idle on active: foo writes parked: foo without stacking", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s2", { title: "active: foo", time: { busy: 10, idle: 5 } });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.idle", { id: "s2", seq: 2 }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  expect(lastFor(ctx, "s2")).toBe("parked: foo");
  expect(ctx.updates.some((u) => u.title?.includes("active: parked:"))).toBe(false);
});

test("a child is renamed to bare lowercased text with no prefix or colon", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s3", { title: "Fix YTM UI-first timing", parentID: "parent-1" });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.idle", { id: "s3", seq: 1, title: "Fix YTM UI-first timing" }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  expect(lastFor(ctx, "s3")).toBe("fix ytm ui-first timing");
  expect(lastFor(ctx, "s3")).not.toContain(":");
});

test("an archived record is forced to closed and stays closed", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s4", { title: "parked: foo", archived: true });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.idle", { id: "s4", seq: 2 }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  expect(ctx.updates.filter((u) => u.sessionID === "s4").length).toBe(1);
  expect(lastFor(ctx, "s4")).toBe("closed: foo");
  ctx.updates.length = 0;
  ctx.push(event("session.idle", { id: "s4", seq: 3 }));
  await ctx.waitFor(() => ctx.consumed >= 2);
  await ctx.flush();
  await ctx.cleanup();
  expect(ctx.updates.length).toBe(0);
  expect(ctx.record("s4").title).toBe("closed: foo");
});

test("a lower durable.seq event is dropped", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s5", { title: "active: foo", time: { busy: 10, idle: 5 } });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.idle", { id: "s5", seq: 5 }));
  ctx.push(event("session.execution.started", { id: "s5", seq: 3 }));
  await ctx.waitFor(() => ctx.consumed >= 2);
  await ctx.flush();
  await ctx.cleanup();
  expect(lastFor(ctx, "s5")).toBe("parked: foo");
});

test("two events fired without awaiting end in the later state", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s6", { title: "fresh" });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.created", { id: "s6", seq: 1 }));
  ctx.push(event("session.idle", { id: "s6", seq: 2 }));
  await ctx.waitFor(() => ctx.consumed >= 2);
  await ctx.flush();
  await ctx.cleanup();
  expect(lastFor(ctx, "s6")).toBe("parked: fresh");
});

test("a session that is already stamped ignores an unmapped event", async () => {
  const ctx = createFakeCtx();
  ctx.seed("c1", { title: "active: foo", time: { busy: 10, idle: 5 }, metadata: { "oc-title": { state: "active", at: 1 } } });
  mount(ctx);
  await ctx.flush();
  ctx.updates.length = 0;
  ctx.push(event("session.suspended", { id: "c1", seq: 9 }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  expect(ctx.updates.length).toBe(0);
});

test("an unmapped event repairs a session the plugin never stamped", async () => {
  const ctx = createFakeCtx();
  mount(ctx);
  await ctx.waitFor(() => ctx.listCalls.length > 0);
  await ctx.flush();
  ctx.seed("c2", { title: "Fix The Board", time: { busy: 1, idle: 2 } });
  ctx.push(event("session.suspended", { id: "c2", seq: 1 }));
  const wrote = await ctx.waitFor(() => ctx.updates.length === 1);
  expect(wrote).toBe(true);
  await ctx.flush();
  await ctx.cleanup();
  expect(lastFor(ctx, "c2")).toBe("parked: fix the board");
  expect(lastUpdateFor(ctx, "c2")?.metadata?.["oc-title"]?.state).toBe("parked");
});

test("a catch-up confirms a closed title instead of reopening it", async () => {
  const ctx = createFakeCtx();
  mount(ctx);
  await ctx.waitFor(() => ctx.listCalls.length > 0);
  await ctx.flush();
  ctx.seed("c3", { title: "closed: done thing", time: { busy: 1, idle: 2 } });
  ctx.push(event("session.suspended", { id: "c3", seq: 1 }));
  await ctx.waitFor(() => ctx.updates.length === 1);
  await ctx.flush();
  await ctx.cleanup();
  expect(lastFor(ctx, "c3")).toBeUndefined();
  expect(ctx.record("c3").title).toBe("closed: done thing");
  expect(ctx.record("c3").metadata["oc-title"].state).toBe("closed");
});

test("a mapped lifecycle event does not reopen a closed title", async () => {
  const ctx = createFakeCtx();
  ctx.seed("c5", { title: "closed: done thing" });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.execution.started", { id: "c5", seq: 1 }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  expect(ctx.record("c5").title).toBe("closed: done thing");
  expect(ctx.record("c5").metadata["oc-title"].state).toBe("closed");
});

test("a created event that beats its own record still writes", async () => {
  const ctx = createFakeCtx({}, { getMisses: 2 });
  mount(ctx);
  await ctx.waitFor(() => ctx.listCalls.length > 0);
  await ctx.flush();
  ctx.seed("c4", { title: "Late Record" });
  ctx.push(event("session.created", { id: "c4", seq: 1 }));
  const wrote = await ctx.waitFor(() => ctx.updates.length === 1, 3000);
  expect(wrote).toBe(true);
  expect(ctx.getCalls.length).toBeGreaterThanOrEqual(3);
  await ctx.flush();
  await ctx.cleanup();
  expect(lastFor(ctx, "c4")).toBe("active: late record");
});

test("an event with no resolvable session id writes nothing", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s8", { title: "active: foo", time: { busy: 10, idle: 5 } });
  mount(ctx);
  await ctx.flush();
  ctx.updates.length = 0;
  ctx.push(event("session.idle", { seq: 1 }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  expect(ctx.updates.length).toBe(0);
});

test("a record with no title field writes nothing", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s9", {});
  mount(ctx);
  await ctx.flush();
  ctx.updates.length = 0;
  ctx.push(event("session.created", { id: "s9", seq: 1 }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  expect(ctx.updates.length).toBe(0);
});

test("setup sweeps a stale title into exactly one normalized update", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s10", { title: "active: Stale Title", time: { busy: 10, idle: 5 } });
  mount(ctx);
  await ctx.flush();
  expect(ctx.updates.length).toBe(1);
  expect(ctx.updates[0].sessionID).toBe("s10");
  expect(ctx.updates[0].title).toBe("active: stale title");
  await ctx.cleanup();
});

test("a subscription that throws once restarts and processes a later event", async () => {
  const ctx = createFakeCtx();
  ctx.seed("s11", { title: "One" });
  mount(ctx);
  await ctx.flush();
  ctx.updates.length = 0;
  ctx.push(event("session.created", { id: "s11", seq: 1 }));
  await ctx.waitFor(() => ctx.updates.some((u) => u.title === "active: one"));
  expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(1);
  ctx.end(new Error("stream boom"), 0);
  await ctx.waitFor(() => ctx.subscriptions.length >= 2, 2000);
  ctx.seed("s11", { title: "Two" });
  ctx.push(event("session.idle", { id: "s11", seq: 2 }));
  await ctx.waitFor(() => ctx.updates.some((u) => u.title === "parked: two"));
  await ctx.flush();
  await ctx.cleanup();
  expect(ctx.updates.some((u) => u.title === "active: one")).toBe(true);
  expect(lastFor(ctx, "s11")).toBe("parked: two");
});

test("cleanup settles an in-flight write", async () => {
  const ctx = createFakeCtx({}, { updateDelayMs: 20 });
  ctx.seed("s12", { title: "active: foo", time: { busy: 10, idle: 5 } });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.idle", { id: "s12", seq: 1 }));
  await ctx.waitFor(() => ctx.inFlight > 0);
  await ctx.cleanup();
  expect(ctx.subscribeArgs.some((args) => args.signal?.aborted)).toBe(true);
  expect(ctx.inFlight).toBe(0);
  const settled = ctx.updates.length;
  await ctx.waitFor(() => false, 30);
  expect(ctx.updates.length).toBe(settled);
  expect(ctx.inFlight).toBe(0);
});

test("parent and child diverge on the same idle event", async () => {
  const ctx = createFakeCtx();
  ctx.seed("parent", { title: "Build The Thing", time: { busy: 10, idle: 5 } });
  ctx.seed("child", { title: "Build The Thing", parentID: "parent" });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.idle", { id: "parent", seq: 1 }));
  ctx.push(event("session.idle", { id: "child", seq: 1 }));
  await ctx.waitFor(() => ctx.consumed >= 2);
  await ctx.flush();
  await ctx.cleanup();
  expect(lastFor(ctx, "parent")).toBe("parked: build the thing");
  expect(lastFor(ctx, "child")).toBe("build the thing");
});

test("a parent records parked state in oc-title metadata", async () => {
  const ctx = createFakeCtx();
  ctx.seed("m1", { title: "active: foo", time: { busy: 10, idle: 5 } });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.idle", { id: "m1", seq: 1 }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  const update = lastUpdateFor(ctx, "m1");
  expect(update?.metadata?.["oc-title"]?.state).toBe("parked");
  expect(typeof update?.metadata?.["oc-title"]?.at).toBe("number");
});

test("a child keeps a bare title but still records parked metadata", async () => {
  const ctx = createFakeCtx();
  ctx.seed("m2", { title: "Fix YTM UI-first timing", parentID: "parent" });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.idle", { id: "m2", seq: 1 }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  const update = lastUpdateFor(ctx, "m2");
  expect(update?.title).toBe("fix ytm ui-first timing");
  expect(update?.title).not.toContain(":");
  expect(update?.metadata?.["oc-title"]?.state).toBe("parked");
});

test("existing metadata survives alongside oc-title", async () => {
  const ctx = createFakeCtx();
  ctx.seed("m3", {
    title: "active: foo",
    time: { busy: 10, idle: 5 },
    metadata: { keep: "me" },
  });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.idle", { id: "m3", seq: 1 }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  const update = lastUpdateFor(ctx, "m3");
  expect(update?.metadata?.keep).toBe("me");
  expect(update?.metadata?.["oc-title"]?.state).toBe("parked");
});

test("wrapped get and list responses are handled", async () => {
  const ctx = createFakeCtx({}, { wrapGet: true, wrapList: true });
  ctx.seed("s14", { title: "active: Wrapped", time: { busy: 10, idle: 5 } });
  mount(ctx);
  await ctx.flush();
  ctx.push(event("session.idle", { id: "s14", seq: 1 }));
  await ctx.waitFor(() => ctx.consumed >= 1);
  await ctx.flush();
  await ctx.cleanup();
  expect(lastFor(ctx, "s14")).toBe("parked: wrapped");
});
