import { describe, expect, test } from "bun:test";
import { detectCautions, type CautionThresholds } from "../src/tui/caution.js";
import { statLine } from "../src/tui/stats.js";
import { createSessionReads } from "../src/tui/session-reads.js";

// A stale host `running` flag is not evidence of work. These fixtures hold the
// three states apart: stale-and-idle, genuinely open, and waiting on a person.

const MINUTE = 60_000;
const NOW = 1_700_000_000_000;
const thresholds: CautionThresholds = {
  toolWatchMs: 3 * MINUTE,
  toolCautionMs: 7 * MINUTE,
  turnWatchMs: 10 * MINUTE,
  turnCautionMs: 20 * MINUTE,
  repeatThreshold: 3,
  exemptTools: ["question"],
};

interface Host {
  status?: string;
  messages?: Record<string, readonly unknown[]>;
  permissions?: readonly unknown[];
  shells?: readonly unknown[];
  families?: Record<string, readonly string[]>;
  childStatus?: Record<string, string>;
}

function reads(host: Host = {}) {
  const directory = "C:\\workspace";
  const context = {
    location: { directory },
    data: {
      location: { default: () => ({ directory }), model: { list: () => [] } },
      session: {
        get: (id: string) => ({ id, time: { created: 0 } }),
        status: (id: string) => host.childStatus?.[id] ?? host.status,
        family: (id: string) => host.families?.[id] ?? [id],
        message: { list: (id: string) => host.messages?.[id] ?? [] },
        permission: { list: () => host.permissions ?? [] },
      },
      shell: { list: () => host.shells ?? [] },
    },
  };
  return createSessionReads(context as unknown as Parameters<typeof createSessionReads>[0]);
}

const closedTurn = {
  id: "m1",
  type: "assistant",
  time: { created: NOW - 31 * MINUTE, completed: NOW - 30 * MINUTE },
  tokens: { output: 10 },
};
const openTurn = {
  id: "m2",
  type: "assistant",
  time: { created: NOW - 31 * MINUTE, streamed: NOW - 30 * MINUTE },
  tokens: { output: 10 },
};
const question = {
  type: "tool",
  name: "question",
  state: { status: "running", input: { questions: [] } },
  time: { ran: NOW - MINUTE },
};

function statusOf(host: Host): string | undefined {
  const r = reads(host);
  const busy = r.busy("root");
  const paused = r.pausedOf("root");
  return statLine("status", { status: host.status, busy, paused, frame: 0 });
}

describe("status and caution tell the truth", () => {
  test("a stale running flag with a closed turn reads idle and raises no caution", () => {
    const host: Host = { status: "running", messages: { root: [closedTurn] } };
    const r = reads(host);
    expect(r.openTurnOf("root")).toBe(false);
    expect(r.busy("root")).toBe(false);
    expect(r.pausedOf("root")).toBe(false);
    expect(statusOf(host)).toBe("status    ○ idle");
    expect(
      detectCautions({
        parts: [],
        now: NOW,
        sessionRunning: true,
        openTurn: r.openTurnOf("root"),
        lastMessageAt: NOW - 30 * MINUTE,
        thresholds,
      }),
    ).toEqual([]);
  });

  test("an open turn older than the watch threshold still raises silent-turn", () => {
    const host: Host = { status: "running", messages: { root: [openTurn] } };
    const r = reads(host);
    expect(r.openTurnOf("root")).toBe(true);
    expect(r.busy("root")).toBe(true);
    expect(statusOf(host)).toBe("status    ⠋ running");
    expect(
      detectCautions({
        parts: [],
        now: NOW,
        sessionRunning: true,
        openTurn: r.openTurnOf("root"),
        lastMessageAt: NOW - 30 * MINUTE,
        thresholds,
      }).map((caution) => caution.kind),
    ).toEqual(["silent-turn"]);
  });

  test("a pending permission reads paused, outranking a busy session", () => {
    const host: Host = {
      status: "running",
      messages: { root: [openTurn] },
      permissions: [{ id: "p1", action: "bash", resources: ["src"] }],
    };
    expect(reads(host).pausedOf("root")).toBe(true);
    expect(statusOf(host)).toBe("status    ‖ paused");
  });

  test("a live question tool reads paused without a permission request", () => {
    const host: Host = {
      status: "running",
      messages: { root: [closedTurn, { id: "m3", type: "assistant", content: [question] }] },
    };
    expect(reads(host).pausedOf("root")).toBe(true);
    expect(statusOf(host)).toBe("status    ‖ paused");
  });

  test("a live tool with a closed turn still reads running", () => {
    const host: Host = {
      status: "running",
      messages: {
        root: [
          closedTurn,
          {
            id: "m4",
            type: "assistant",
            content: [{ type: "tool", name: "read", state: { status: "running" }, time: { ran: NOW - 1_000 } }],
          },
        ],
      },
    };
    expect(reads(host).busy("root")).toBe(true);
    expect(statusOf(host)).toBe("status    ⠋ running");
  });

  test("a running child or shell is still evidence of work", () => {
    const child: Host = {
      status: "idle",
      messages: { root: [closedTurn] },
      families: { root: ["root", "child"] },
      childStatus: { child: "running" },
    };
    expect(reads(child).busy("root")).toBe(true);
    const shell: Host = {
      status: "idle",
      messages: { root: [closedTurn] },
      shells: [
        {
          status: "running",
          command: "npm install",
          time: { started: NOW - 1_000 },
          metadata: { sessionID: "root" },
        },
      ],
    };
    expect(reads(shell).busy("root")).toBe(true);
  });

  test("a host that says nothing at all stays undefined rather than a guess", () => {
    expect(reads({ messages: { root: [closedTurn] } }).busy("root")).toBeUndefined();
  });
});
