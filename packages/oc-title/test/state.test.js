import { expect, test } from "bun:test";
import { STATE_FOR, sessionIDOf, seqOf, isChild, isArchived, deriveState } from "../state.js";

const valueFor = (type) => (STATE_FOR instanceof Map ? STATE_FOR.get(type) : STATE_FOR[type]);

test("STATE_FOR maps every session event to its state", () => {
  expect(valueFor("session.created")).toBe("active");
  expect(valueFor("session.execution.started")).toBe("active");
  expect(valueFor("session.execution.succeeded")).toBe("parked");
  expect(valueFor("session.execution.failed")).toBe("parked");
  expect(valueFor("session.execution.interrupted")).toBe("parked");
  expect(valueFor("session.idle")).toBe("parked");
  expect(valueFor("session.archived")).toBe("closed");
  expect(valueFor("session.unarchived")).toBe("active");
});

test("sessionIDOf reads data.sessionID", () => {
  expect(sessionIDOf({ type: "session.idle", data: { sessionID: "s1" } })).toBe("s1");
});

test("sessionIDOf reads data.info.id", () => {
  expect(sessionIDOf({ type: "session.idle", data: { info: { id: "s2" } } })).toBe("s2");
});

test("sessionIDOf reads durable.aggregateID", () => {
  expect(sessionIDOf({ type: "session.idle", durable: { aggregateID: "s3" } })).toBe("s3");
});

test("sessionIDOf returns undefined when no id is resolvable", () => {
  expect(sessionIDOf({ type: "session.idle", data: {}, durable: {} })).toBeUndefined();
});

test("seqOf reads durable.seq", () => {
  expect(seqOf({ type: "session.idle", durable: { seq: 7 } })).toBe(7);
});

test("isChild recognizes both parent field spellings", () => {
  expect(isChild({ parentID: "p1" })).toBe(true);
  expect(isChild({ parent_id: "p2" })).toBe(true);
  expect(isChild({})).toBe(false);
});

test("isArchived recognizes both archived record shapes", () => {
  expect(isArchived({ archived: true })).toBe(true);
  expect(isArchived({ time: { archived: true } })).toBe(true);
  expect(isArchived({})).toBe(false);
});

test("deriveState returns closed for an archived record", () => {
  expect(deriveState({ archived: true })).toBe("closed");
});

test("deriveState returns active for a busy record", () => {
  expect(deriveState({ time: { busy: 10, idle: 5 } })).toBe("active");
});

test("deriveState returns parked for an idle record without an outcome", () => {
  expect(deriveState({ time: { busy: 0, idle: 20 } })).toBe("parked");
});

// A live record proves the shape: outcome is set on every session that ever ran,
// including ones sitting idle and unarchived, so it cannot mean closed.
test("deriveState reads outcome as the last run, not as a closed session", () => {
  expect(deriveState({ time: { busy: 0, idle: 20 }, outcome: "succeeded" })).toBe("parked");
  expect(deriveState({ time: { busy: 30, idle: 20 }, outcome: "succeeded" })).toBe("active");
});

test("deriveState compares the busy and idle timestamps", () => {
  expect(deriveState({ time: { busy: 1795653356184, idle: 1795653409435 } })).toBe("parked");
  expect(deriveState({ time: { busy: 1795653409435, idle: 1795653356184 } })).toBe("active");
});

test("deriveState falls back when only one timestamp is present", () => {
  expect(deriveState({ time: { busy: 5 } })).toBe("active");
  expect(deriveState({ time: { idle: 5 } })).toBe("parked");
});

test("deriveState returns parked for a plain record", () => {
  expect(deriveState({})).toBe("parked");
});
