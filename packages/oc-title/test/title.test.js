import { expect, test } from "bun:test";
import { STATES, stateOf, bodyOf, cleanBody, normalizeTitle } from "../title.js";

const hasState = (value) =>
  Array.isArray(STATES)
    ? STATES.includes(value)
    : Object.keys(STATES).includes(value) || Object.values(STATES).includes(value);

test("STATES names all three session states", () => {
  expect(hasState("active")).toBe(true);
  expect(hasState("parked")).toBe(true);
  expect(hasState("closed")).toBe(true);
});

test("stateOf reads active, parked and closed prefixes", () => {
  expect(stateOf("active: hello")).toBe("active");
  expect(stateOf("parked: hello")).toBe("parked");
  expect(stateOf("closed: hello")).toBe("closed");
});

test("stateOf returns null for an unprefixed title", () => {
  expect(stateOf("hello")).toBeNull();
});

test("bodyOf strips one prefix", () => {
  expect(bodyOf("active: hello world")).toBe("hello world");
  expect(bodyOf("parked: vst3 audio")).toBe("vst3 audio");
});

test("bodyOf leaves an unprefixed title as the body", () => {
  expect(bodyOf("hello world")).toBe("hello world");
});

test("cleanBody strips stacked state prefixes", () => {
  expect(cleanBody("active: parked: x")).toBe("x");
  expect(cleanBody("parked: closed: vst3")).toBe("vst3");
});

test("cleanBody keeps the body text", () => {
  expect(cleanBody("vst3")).toBe("vst3");
  expect(cleanBody("api v2")).toBe("api v2");
});

test("cleanBody removes control, bidi and zero-width characters", () => {
  expect(cleanBody("\u0000ab\u0007c\u001Fd\u200Be\u200Bf\u202Eg\u2066h\uFEFFi")).toBe("abcdefghi");
});

test("cleanBody collapses whitespace", () => {
  expect(cleanBody("  a   b\t\n c  ")).toBe("a b c");
});

test("cleanBody enforces its maxLength argument", () => {
  expect(cleanBody("abcdefghij".repeat(30), 10)).toBe("abcdefghij");
});

test("cleanBody of an empty title is empty", () => {
  expect(cleanBody("")).toBe("");
});

test("normalizeTitle writes <state>: <lowercased text>", () => {
  expect(normalizeTitle("Hello World", "active")).toBe("active: hello world");
  expect(normalizeTitle("VST3", "parked")).toBe("parked: vst3");
});

test("normalizeTitle never stacks a state prefix", () => {
  expect(normalizeTitle("active: foo", "parked")).toBe("parked: foo");
  expect(normalizeTitle("active: parked: x", "closed")).toBe("closed: x");
});

test("normalizeTitle falls back when the body is empty", () => {
  expect(normalizeTitle("   ", "active", { fallbackTitle: "untitled session" })).toBe(
    "active: untitled session",
  );
  expect(normalizeTitle("", "parked")).toBe("parked: untitled session");
});

test("normalizeTitle caps the body through the maxLength option", () => {
  expect(normalizeTitle("abcdefghijklmnop", "active", { maxLength: 4 })).toBe("active: abcd");
});

test("normalizeTitle lowercases a mixed-case title", () => {
  expect(normalizeTitle("Mixed Case Title", "parked")).toBe("parked: mixed case title");
});

test("normalizeTitle preserves inner punctuation exactly", () => {
  expect(normalizeTitle("Fix: API v2 — Ship It!", "active")).toBe(
    "active: fix: api v2 — ship it!",
  );
});

// A UTF-16 slice can end between the two halves of an emoji; the title then
// carries a lone surrogate that no encoder can represent.
test("cleanBody never splits a surrogate pair at the cap", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const straddling = "a".repeat(199) + "\u{1F600}";
  const kept = cleanBody(straddling, 200);
  expect(kept).toBe(straddling);
  expect(lone.test(kept)).toBe(false);
  const cut = cleanBody("a".repeat(200) + "\u{1F600}", 200);
  expect(cut).toBe("a".repeat(200));
  expect(lone.test(cut)).toBe(false);
});

test("cleanBody drops a lone surrogate already present in the input", () => {
  expect(cleanBody("ab\uD83Dcd")).toBe("abcd");
  expect(cleanBody("ab\uDE00cd")).toBe("abcd");
});
test("normalizeTitle caps a 300-character body at the 200-character default", () => {
  const input = "active: " + "a".repeat(300);
  const result = normalizeTitle(input, "parked");
  expect(result).toBe("parked: " + "a".repeat(200));
  expect(result.length).toBe(208);
});
