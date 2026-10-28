import { describe, expect, test } from "bun:test";
import { statLine } from "../src/tui/rows.js";
import { createSessionReads } from "../src/tui/session-reads.js";

//   cost  - the CURRENT model's spend: recorded step costs for that model, with
//           the host's fork guard applied. The TUI surface has no paging, so the
//           history on hand is a window and the figure is a floor.
//   total - the host's family roll-up, resolved from the session's ROOT
//           (`cost()` answers a family only for a root). Persisted, so exact.
//
// The five probes below are the verifier's, numbered as they raised them.

type Message = Record<string, unknown>;

const FLOOR = String.fromCharCode(0x2265);

const CATALOG = [
  { id: "paid-a", providerID: "prov", cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }] },
  { id: "paid-b", providerID: "prov", cost: [{ input: 1, output: 5, cache: { read: 0.1, write: 1.25 } }] },
];

function stub(
  gets: Record<string, unknown> = {},
  families: Record<string, readonly string[]> = {},
  messages: Record<string, readonly Message[]> = {},
  options: { hostCost?: (sessionID: string) => number; root?: string; catalog?: readonly unknown[] } = {},
) {
  const directory = "C:\\workspace";
  const context = {
    location: { directory },
    data: {
      location: { default: () => ({ directory }), model: { list: () => options.catalog ?? CATALOG } },
      session: {
        get: (id: string) => gets[id],
        root: () => options.root ?? "root",
        status: () => "idle",
        family: (id: string) => families[id] ?? [id],
        ...(options.hostCost === undefined ? {} : { cost: options.hostCost }),
        message: { list: (id: string) => messages[id] ?? [] },
        permission: { list: () => [] },
      },
      shell: { list: () => [] },
    },
  };
  return context as unknown as Parameters<typeof createSessionReads>[0];
}

function step(id: string, model: string, cost: number, created = 1_000, input = 10): Message {
  return {
    id,
    type: "assistant",
    model: { id: model, providerID: "prov" },
    time: { created, completed: created + 500 },
    cost,
    tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

describe("probe 1: gapped history is not exact", () => {
  test("an omitted intermediate charge leaves a floor, not an exact figure", () => {
    // History starts at the session's creation and the tail is present, but the
    // charge at 1.5s is gone: the window looks anchored and is not complete.
    const record = { cost: 3, model: { id: "paid-a", providerID: "prov" }, time: { created: 1_000 } };
    const messages = { root: [step("m1", "paid-a", 1, 1_000), step("m3", "paid-a", 1, 3_000)] };
    const reads = createSessionReads(stub({ root: record }, { root: ["root"] }, messages, { hostCost: () => 3 }));

    expect(reads.sessionCost("root", record)).toEqual({ cost: 2, kind: "bounded" });
    expect(statLine("cost", { cost: 2, costKind: "bounded" }, { hasTotalRow: true })).toBe(
      `cost      ${FLOOR}$2.00`,
    );
  });
});

describe("probe 2: resumed session, empty message list", () => {
  test("total is the root roll-up, not 0", () => {
    // The resumed record reports 0 (the provider reported nothing); the host's
    // roll-up still knows the family's 4.
    const record = { cost: 0, model: { id: "paid-a", providerID: "prov" }, time: { created: 0 } };
    const reads = createSessionReads(stub({ root: record }, { root: ["root"] }, {}, { hostCost: () => 4 }));
    expect(reads.treeTotals("root")).toMatchObject({ cost: 4, kind: "exact" });
  });
});

describe("probe 3: fork guard", () => {
  test("inherited 3 is excluded, so a fork that spent 1 reports 1", () => {
    const record = { cost: 1, model: { id: "paid-a", providerID: "prov" }, time: { created: 2_000 } };
    // A copied step from before the fork existed, then the fork's own step.
    const messages = { root: [step("old", "paid-a", 3, 1_000), step("new", "paid-a", 1, 3_000)] };
    const reads = createSessionReads(stub({ root: record }, { root: ["root"] }, messages, { hostCost: () => 1 }));
    expect(reads.sessionCost("root", record)).toEqual({ cost: 1, kind: "bounded" });
  });
});

describe("probe 4: child-only pricing", () => {
  test("a zero-cost root with a priced child shows an estimate across the family", () => {
    const gets = {
      root: { cost: 0, model: { id: "paid-a", providerID: "prov" }, tokens: {} },
      child: { cost: 0, model: { id: "paid-a", providerID: "prov" }, tokens: {} },
    };
    const messages = {
      root: [],
      child: [step("c1", "paid-a", 0, 1_000, 1_000_000)],
    };
    const reads = createSessionReads(
      stub(gets, { root: ["root", "child"] }, messages, { hostCost: () => 0 }),
    );
    const tree = reads.treeTotals("root");
    expect(tree?.kind).toBe("estimated");
    // 1M input at $3/M plus the step's single output token at $15/M.
    expect(tree?.cost).toBeCloseTo(3.000015, 6);
    expect(statLine("total", { tree })).toBe("total     ~$3.00 · 1 subagent");
  });
});

describe("probe 5: no cost accessor", () => {
  test("the fallback includes children rather than claiming the root alone", () => {
    const gets = { root: { cost: 1 }, child: { cost: 2 } };
    const reads = createSessionReads(stub(gets, { root: ["root", "child"] }, {}));
    expect(reads.treeTotals("root")).toMatchObject({ cost: 3, count: 1, kind: "exact" });
  });
});

describe("the total decision table", () => {
  test("row 1: rolled > 0, complete, rolled >= visible -> rolled exact", () => {
    // Root aggregate 4 with a step showing 3: the host's figure covers what is
    // visible, and the family is complete.
    const record = { cost: 4, time: { created: 1_000 }, tokens: { input: 5 } };
    const messages = { root: [step("m1", "unknown", 3, 2_000)] };
    const reads = createSessionReads(
      stub({ root: record }, { root: ["root"] }, messages, { hostCost: () => 4, catalog: [] }),
    );
    expect(reads.treeTotals("root")).toMatchObject({ cost: 4, kind: "exact" });
  });

  test("row 2: rolled > 0, incomplete or rolled < visible -> rolled bounded", () => {
    // (a) the aggregate was corrected 4 -> 1 while a stale charge of 4 is still
    // on the message list: the host's 1 is the figure, never the larger charge.
    const stale = { cost: 1, time: { created: 1_000 } };
    const staleReads = createSessionReads(
      stub({ root: stale }, { root: ["root"] }, { root: [step("m1", "unknown", 4, 2_000)] }, {
        hostCost: () => 1,
        catalog: [],
      }),
    );
    expect(staleReads.treeTotals("root")).toMatchObject({ cost: 1, kind: "bounded" });

    // (b) a listed child with no record: complete is false, so the roll-up is a
    // floor at its own value - never promoted to exact.
    const missing = createSessionReads(
      stub({ root: { cost: 4 } }, { root: ["root", "child"] }, {}, { hostCost: () => 4 }),
    );
    expect(missing.treeTotals("root")).toMatchObject({ cost: 4, kind: "bounded" });
  });

  test("row 3: rolled == 0, visible > 0 -> visible bounded", () => {
    // No catalog entry, so nothing can be priced: the recorded charges are the
    // only evidence, and they contradict a roll-up of zero.
    const record = { cost: 0, model: { id: "unknown", providerID: "prov" }, time: { created: 1_000 } };
    const messages = { root: [step("m1", "unknown", 1, 2_000), step("m2", "unknown", 1, 3_000)] };
    const reads = createSessionReads(
      stub({ root: record }, { root: ["root"] }, messages, { hostCost: () => 0, catalog: [] }),
    );
    const tree = reads.treeTotals("root");
    expect(tree).toMatchObject({ cost: 2, kind: "bounded" });
    expect(statLine("total", { tree })).toBe(`total     ${FLOOR}$2.00 · 0 subagents`);
  });

  test("row 4: rolled == 0, visible == 0, complete -> 0 exact", () => {
    const record = { cost: 0, time: { created: 0 } };
    const reads = createSessionReads(
      stub({ root: record }, { root: ["root"] }, {}, { hostCost: () => 0, catalog: [] }),
    );
    expect(reads.treeTotals("root")).toMatchObject({ cost: 0, kind: "exact" });
    expect(statLine("total", { tree: reads.treeTotals("root") })).toBe("total     $0.000 · 0 subagents");
  });

  test("row 5: rolled == 0, visible == 0, incomplete -> 0 bounded", () => {
    // A listed child with no record and nothing priced: the rail must not claim
    // an established zero for a family it cannot see.
    const reads = createSessionReads(
      stub({ root: { cost: 0 } }, { root: ["root", "child"] }, {}, { hostCost: () => 0, catalog: [] }),
    );
    const tree = reads.treeTotals("root");
    expect(tree).toMatchObject({ cost: 0, kind: "bounded" });
    expect(statLine("total", { tree })).toBe(`total     ${FLOOR}$0.000 · 0 subagents`);
  });
});

describe("scope", () => {
  test("two models: cost is the selected model's, total the roll-up", () => {
    const messages = { root: [step("m1", "paid-b", 3, 1_000), step("m2", "paid-a", 1, 2_000)] };
    const record = {
      cost: 4,
      model: { id: "paid-a", providerID: "prov" },
      time: { created: 1_000 },
      tokens: { input: 20, output: 2 },
    };
    const reads = createSessionReads(stub({ root: record }, { root: ["root"] }, messages, { hostCost: () => 4 }));
    expect(reads.sessionCost("root", record)?.cost).toBe(1);
    expect(reads.treeTotals("root")).toMatchObject({ cost: 4, kind: "exact" });
  });

  test("zero with no tokens is a real $0.000, drawn bare", () => {
    const record = { cost: 0, model: { id: "paid-a", providerID: "prov" } };
    const reads = createSessionReads(stub({ root: record }, { root: ["root"] }, {}, { hostCost: () => 0 }));
    expect(statLine("total", { tree: reads.treeTotals("root") })).toBe("total     $0.000 · 0 subagents");
  });
});
