import { test, expect } from "bun:test";
import { resolveModel, splitModelID, catalogIDs } from "../src/models.js";

const catalog = [
  { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
  { providerID: "openai", id: "deepseek-v4.1-flash" },
];

test("resolves an exact qualified model only when catalogued and allowlisted", () => {
  expect(resolveModel("opencode-go/deepseek-v4.1-flash", catalog, ["opencode-go/deepseek-v4.1-flash"]))
    .toEqual({ id: "opencode-go/deepseek-v4.1-flash", providerID: "opencode-go", modelID: "deepseek-v4.1-flash" });
  expect(() => resolveModel("openai/deepseek-v4.1-flash", catalog, ["opencode-go/deepseek-v4.1-flash"])).toThrow(/OpenCode Go provider/);
  expect(() => resolveModel("missing/model", catalog, ["missing/model"])).toThrow(/OpenCode Go provider/);
  expect(() => resolveModel("openai/absent", catalog, ["openai/absent"])).toThrow(/OpenCode Go provider/);
});

test("rejects malformed and variant IDs while preserving model remainders", () => {
  for (const id of ["deepseek-v4.1-flash", "/model", "provider/", "openai/model#variant"]) {
    expect(() => resolveModel(id, catalog, [id])).toThrow();
  }
  expect(splitModelID("openai/model/extra").modelID).toBe("model/extra");
});

test("reads Go catalog entries and rejects bad catalog shapes", () => {
  expect(catalogIDs({ data: catalog })).toEqual(new Set([
    "opencode-go/deepseek-v4.1-flash",
  ]));
  expect(() => catalogIDs({ data: [{ id: "bare" }] })).toThrow(/catalog/);
});

test("deduplicates repeated host rows by their canonical model identity", () => {
  const repeated = { id: "gpt-6.1-terra", modelID: "gpt-6.1-terra", providerID: "openai" };
  expect(catalogIDs({ data: [repeated, { ...repeated }] })).toEqual(new Set());
  expect(catalogIDs({ data: [repeated, { ...repeated, id: "different-model" }] })).toEqual(new Set());
});

test("uses providerID and modelID as canonical identity, ignoring host id aliases", () => {
  const rows = [
    { id: "gpt-6.1-terra", modelID: "gpt-6.1-terra", providerID: "opencode-go" },
    { id: "gpt-6.1-terra-2026-11-13", modelID: "gpt-6.1-terra", providerID: "opencode-go" },
    { id: "gpt-6.1-terra", modelID: "gpt-6.1-terra-fast", providerID: "opencode-go" },
  ];
  expect(catalogIDs({ data: rows })).toEqual(new Set([
    "opencode-go/gpt-6.1-terra",
    "opencode-go/gpt-6.1-terra-fast",
  ]));
});

test("ignores rows for unavailable providers without inspecting their entries", () => {
  expect(catalogIDs({ data: [
    { providerID: "openai", id: "alias-one", modelID: "gpt-6.1-terra" },
    { providerID: "openai", id: null, modelID: null },
    { providerID: "opencode", id: "beam-free", modelID: "beam-free" },
  ] })).toEqual(new Set());
});
