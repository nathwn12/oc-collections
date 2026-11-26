import { expect, test } from "bun:test";
import { createFakeCtx } from "./fake-ctx.js";
import { createWriter } from "../write.js";

const stamped = (title, state, extra = {}) => ({
  title,
  metadata: { "oc-title": { state, at: 1 }, ...extra },
  ...extra,
});
const updates = (ctx, id) => ctx.updates.filter((u) => u.sessionID === id);

async function run(ctx, id, scope, options = {}) {
  const writer = createWriter(ctx, { options });
  const outcome = await writer.refresh(id, scope);
  return { writer, outcome };
}

test("refresh changes the scope but keeps the current state and metadata", async () => {
  const ctx = createFakeCtx();
  ctx.seed("a", { ...stamped("active: old scope", "active"), metadata: { "oc-title": { state: "active", at: 1 }, keep: "me" } });
  const { outcome } = await run(ctx, "a", "New Scope");
  expect(outcome).toBe("refreshed");
  expect(updates(ctx, "a").length).toBe(1);
  expect(updates(ctx, "a")[0].title).toBe("active: new scope");
  expect(updates(ctx, "a")[0].metadata.keep).toBe("me");
  expect(updates(ctx, "a")[0].metadata["oc-title"].state).toBe("active");
  expect(typeof updates(ctx, "a")[0].metadata["oc-title"].at).toBe("number");
});

test("refresh keeps a parked state parked", async () => {
  const ctx = createFakeCtx();
  ctx.seed("b", stamped("parked: old scope", "parked"));
  await run(ctx, "b", "New Scope");
  expect(updates(ctx, "b")[0].title).toBe("parked: new scope");
});

test("closed is final: a refresh never reopens a closed title", async () => {
  const ctx = createFakeCtx();
  ctx.seed("c", stamped("closed: old scope", "closed"));
  const { outcome } = await run(ctx, "c", "New Scope");
  expect(outcome).not.toBe("refreshed");
  expect(updates(ctx, "c").length).toBe(0);
  expect(ctx.record("c").title).toBe("closed: old scope");
});

test("an archived record is never refreshed even if metadata says active", async () => {
  const ctx = createFakeCtx();
  ctx.seed("d", { ...stamped("active: old scope", "active"), archived: true });
  const { outcome } = await run(ctx, "d", "New Scope");
  expect(outcome).not.toBe("refreshed");
  expect(updates(ctx, "d").length).toBe(0);
});

test("an unstamped title is left alone: refresh only updates an existing auto title", async () => {
  const ctx = createFakeCtx();
  ctx.seed("e", { title: "raw title" });
  const { outcome } = await run(ctx, "e", "New Scope");
  expect(outcome).not.toBe("refreshed");
  expect(updates(ctx, "e").length).toBe(0);
  expect(ctx.record("e").title).toBe("raw title");
});

test("an empty or tool-only scope invents no title", async () => {
  for (const scope of ["", "   ", "\t\n"]) {
    const ctx = createFakeCtx();
    ctx.seed("f", stamped("active: old scope", "active"));
    const { outcome } = await run(ctx, "f", scope);
    expect(outcome).not.toBe("refreshed");
    expect(updates(ctx, "f").length).toBe(0);
  }
});

test("an unchanged scope writes nothing", async () => {
  const ctx = createFakeCtx();
  ctx.seed("g", stamped("active: same scope", "active"));
  const { outcome } = await run(ctx, "g", "Same Scope");
  expect(outcome).toBe("unchanged");
  expect(updates(ctx, "g").length).toBe(0);
});

test("a child refresh stays a bare title with preserved metadata", async () => {
  const ctx = createFakeCtx();
  ctx.seed("h", { ...stamped("old scope", "parked"), parentID: "parent" });
  await run(ctx, "h", "New Scope");
  expect(updates(ctx, "h")[0].title).toBe("new scope");
  expect(updates(ctx, "h")[0].title).not.toContain(":");
  expect(updates(ctx, "h")[0].metadata["oc-title"].state).toBe("parked");
});

test("a refresh respects the body cap", async () => {
  const ctx = createFakeCtx();
  ctx.seed("i", stamped("active: old", "active"));
  await run(ctx, "i", "abcdefghij", { maxLength: 5 });
  expect(updates(ctx, "i")[0].title).toBe("active: abcde");
});

test("refresh and lifecycle events share one serialized chain", async () => {
  const ctx = createFakeCtx();
  ctx.seed("j", stamped("active: old scope", "active"));
  const writer = createWriter(ctx, {});
  await writer.flush();
  ctx.updates.length = 0;
  const a = writer.enqueue("j", "active", 1);
  const b = writer.refresh("j", "New Scope");
  const c = writer.enqueue("j", "parked", 2);
  await Promise.all([a, b, c]);
  expect(updates(ctx, "j").at(-1).title).toBe("parked: new scope");
});
