import { test, expect } from "bun:test";
import { createPlugin } from "../src/plugin.js";
import { loadOptions } from "../src/config.js";

function harness(runner, options, timing) {
  let tool;
  const progress = [];
  const ctx = {
    location: { directory: "C:\\workspace" },
    integration: { connection: { active: async () => ({ id: "go" }), resolve: async () => ({ type: "key", key: "secret" }) } },
    permission: { assert: async () => {} },
    tool: { transform: async fn => fn({ add: value => { tool = value; } }) },
  };
  return { plugin: createPlugin(runner, options, timing ?? { heartbeatMs: 25 }), ctx, progress, tool: () => tool, calls: progress };
}

const context = extra => ({ sessionID: "s", messageID: "m", id: "t", signal: new AbortController().signal, ...extra, progress: async value => extra.progress.push(value) });

test("registers one tool with a Go-model input schema and forwards the active credential", async () => {
  let request;
  const h = harness(async (input, report) => {
    request = input;
    report({ type: "thread", threadId: "thread-1" });
    report({ type: "text", text: "Working" });
    return { status: "completed", threadId: "thread-1", text: "Done", deniedApprovals: 0 };
  });
  await h.plugin.setup(h.ctx);
  const tool = h.tool();
  expect(tool.name).toBe("oc_dex");
  expect(tool.input.properties.model.enum).toEqual(["deepseek-v4.1-flash", "muse-spark-1.3-contributor"]);
  expect(tool.input.properties.mode.enum).toEqual(["read-only"]);

  const progress = [];
  const result = await tool.execute({ prompt: "do it" }, context({ progress }));
  expect(request.apiKey).toBe("secret");
  expect(request.cwd).toBe("C:\\workspace");
  expect(result.content).toContain("Done");
  expect(result.content).not.toContain("secret");
  // The default display is lean: the model's own output never becomes the status line.
  expect(progress.every(entry => !entry.status.includes("Working"))).toBe(true);
  expect(progress[0].title).toBe("oc-dex");
});

test("advertises workspace-write only when the operator enabled it", async () => {
  const h = harness(async () => ({ status: "completed", threadId: "t", text: "x", deniedApprovals: 0 }), loadOptions({ allowWorkspaceWrite: true }));
  await h.plugin.setup(h.ctx);
  expect(h.tool().input.properties.mode.enum).toEqual(["read-only", "workspace-write"]);
});

test("shows an observable heartbeat that advances while the run is silent", async () => {
  const h = harness(async () => {
    await new Promise(done => setTimeout(done, 120));
    return { status: "completed", threadId: "thread-1", text: "done", deniedApprovals: 0 };
  });
  await h.plugin.setup(h.ctx);
  const progress = [];
  await h.tool().execute({ prompt: "slow" }, context({ progress }));
  expect(progress.length).toBeGreaterThan(1);
  expect(progress[0].title).toContain("oc-dex");
  expect(progress[0].elapsedSeconds).toBe(0);
  const last = progress[progress.length - 1];
  expect(last.elapsedSeconds).toBeGreaterThanOrEqual(0);
  expect(typeof last.status).toBe("string");
  expect(last.status.length).toBeGreaterThan(0);
});

test("elapsed seconds in the heartbeat grow without duplicating the previous suffix", async () => {
  const h = harness(async () => {
    await new Promise(done => setTimeout(done, 1100));
    return { status: "completed", threadId: "thread-1", text: "done", deniedApprovals: 0 };
  });
  await h.plugin.setup(h.ctx);
  const progress = [];
  await h.tool().execute({ prompt: "slow" }, context({ progress }));
  for (const entry of progress) expect(entry.status.match(/s$/)).toBeTruthy();
  expect(progress.some(entry => entry.elapsedSeconds >= 1)).toBe(true);
  expect(progress.every(entry => !/\d+s · \d+s/.test(entry.status))).toBe(true);
});

test("throttles progress updates so a burst of deltas cannot flood the UI", async () => {
  let sent = 0;
  const h = harness(async (_input, report) => {
    for (let i = 0; i < 50; i += 1) { sent += 1; report({ type: "text", text: "x" }); }
    return { status: "completed", threadId: "thread-1", text: "done", deniedApprovals: 0 };
  }, loadOptions({ progress: "detailed" }));
  await h.plugin.setup(h.ctx);
  const progress = [];
  await h.tool().execute({ prompt: "burst" }, context({ progress }));
  expect(sent).toBe(50);
  expect(progress.length).toBeLessThan(10);
});

test("stops the heartbeat once the run returns", async () => {
  const h = harness(async () => ({ status: "completed", threadId: "thread-1", text: "done", deniedApprovals: 0 }));
  await h.plugin.setup(h.ctx);
  const progress = [];
  await h.tool().execute({ prompt: "quick" }, context({ progress }));
  const settled = progress.length;
  await new Promise(done => setTimeout(done, 80));
  expect(progress.length).toBe(settled);
});

test("fails closed if no Go credential is active", async () => {
  let tool;
  const ctx = {
    location: { directory: "C:\\workspace" },
    integration: { connection: { active: async () => undefined } },
    tool: { transform: async fn => fn({ add: value => { tool = value; } }) },
  };
  await createPlugin(() => { throw new Error("must not run"); }).setup(ctx);
  await expect(tool.execute({ prompt: "test" }, context({ progress: [] }))).rejects.toThrow("OpenCode Go");
});

test("propagates a permission rejection instead of running Codex", async () => {
  let ran = false;
  const h = harness(async () => { ran = true; return { status: "completed", threadId: "t", text: "", deniedApprovals: 0 }; });
  h.ctx.permission.assert = async () => { throw new Error("denied by policy"); };
  await h.plugin.setup(h.ctx);
  await expect(h.tool().execute({ prompt: "test" }, context({ progress: [] }))).rejects.toThrow("denied by policy");
  expect(ran).toBe(false);
});

test("asks for permission with the sandbox mode and directory it is about to use", async () => {
  let request;
  const h = harness(async () => ({ status: "completed", threadId: "t", text: "", deniedApprovals: 0 }));
  h.ctx.permission.assert = async value => { request = value; };
  await h.plugin.setup(h.ctx);
  await h.tool().execute({ prompt: "test" }, context({ progress: [] }));
  expect(request.action).toBe("oc_dex_run");
  expect(request.resources).toEqual(["C:\\workspace"]);
  expect(request.metadata.mode).toBe("read-only");
  expect(request.metadata.model).toBe("deepseek-v4.1-flash");
});

test("returns the thread id for resume and reports a cancelled run without throwing", async () => {
  const h = harness(async input => ({ status: "cancelled", threadId: input.threadId, text: "partial", deniedApprovals: 0 }));
  await h.plugin.setup(h.ctx);
  const result = await h.tool().execute({ prompt: "x", threadId: "previous" }, context({ progress: [] }));
  expect(result.content).toContain("previous");
  expect(result.content.toLowerCase()).toContain("cancel");
});

test("reports a timeout and a denied approval count", async () => {
  const h = harness(async () => ({ status: "timeout", threadId: "t", text: "", deniedApprovals: 2 }));
  await h.plugin.setup(h.ctx);
  const result = await h.tool().execute({ prompt: "x" }, context({ progress: [] }));
  expect(result.content.toLowerCase()).toContain("timeout");
  expect(result.content).toContain("2");
});

test("rejects a model outside the allowlist before doing any work", async () => {
  let ran = false;
  const h = harness(async () => { ran = true; return { status: "completed", threadId: "t", text: "", deniedApprovals: 0 }; });
  await h.plugin.setup(h.ctx);
  await expect(h.tool().execute({ prompt: "x", model: "glm-5.3" }, context({ progress: [] }))).rejects.toThrow(/allowlist/);
  expect(ran).toBe(false);
});
test("takes its allowlist from the plugin config entry", async () => {
  let tool;
  const ctx = {
    location: { directory: "C:\\workspace" },
    options: { models: ["muse-spark-1.3-contributor"], defaultModel: "muse-spark-1.3-contributor" },
    integration: { connection: {} },
    permission: { assert: async () => {} },
    tool: { transform: async fn => fn({ add: value => { tool = value; } }) },
  };
  await createPlugin(async () => ({ status: "completed", threadId: "t", text: "", deniedApprovals: 0 })).setup(ctx);
  expect(tool.input.properties.model.enum).toEqual(["muse-spark-1.3-contributor"]);
});

test("a bad config entry fails at setup, not at tool call time", async () => {
  const ctx = {
    location: { directory: "C:\\workspace" },
    options: { models: ["gpt-6.1-sol"] },
    integration: { connection: {} },
    tool: { transform: async fn => fn({ add: () => {} }) },
  };
  await expect(createPlugin(async () => ({})).setup(ctx)).rejects.toThrow(/Go model/);
});
test("passes the resolved options to the runner so its own validation cannot re-apply defaults", async () => {
  let received;
  const h = harness(async (input, report, options) => { received = options; return { status: "completed", threadId: "t", text: "", deniedApprovals: 0 }; }, loadOptions({ allowWorkspaceWrite: true }));
  await h.plugin.setup(h.ctx);
  await h.tool().execute({ prompt: "x", mode: "workspace-write" }, context({ progress: [] }));
  expect(received.allowWorkspaceWrite).toBe(true);
});
test("advertises a default deadline so a caller does not have to choose one", async () => {
  const h = harness(async () => ({ status: "completed", threadId: "t", text: "", deniedApprovals: 0 }));
  await h.plugin.setup(h.ctx);
  expect(h.tool().input.properties.timeoutSeconds.default).toBe(300);

  const narrow = harness(async () => ({ status: "completed", threadId: "t", text: "", deniedApprovals: 0 }), loadOptions({ maxTimeoutSeconds: 120 }));
  await narrow.plugin.setup(narrow.ctx);
  expect(narrow.tool().input.properties.timeoutSeconds.default).toBe(120);
});

test("quiet mode emits no event-driven updates but keeps the heartbeat moving", async () => {
  const h = harness(async (_input, report) => {
    report({ type: "status", status: "Starting Codex" });
    report({ type: "thread", threadId: "thread-1" });
    report({ type: "text", text: "Working" });
    await new Promise(done => setTimeout(done, 120));
    return { status: "completed", threadId: "thread-1", text: "done", deniedApprovals: 0 };
  }, loadOptions({ progress: "quiet" }));
  await h.plugin.setup(h.ctx);
  const progress = [];
  await h.tool().execute({ prompt: "quiet" }, context({ progress }));
  expect(progress.length).toBeGreaterThan(1);
  expect(progress.every(entry => entry.title === "oc-dex")).toBe(true);
  expect(progress.every(entry => !entry.status.includes("thread"))).toBe(true);
  expect(progress.at(-1).elapsedSeconds).toBeGreaterThanOrEqual(0);
});

test("detailed mode names the model and the resumed thread", async () => {
  const h = harness(async (_input, report) => {
    report({ type: "thread", threadId: "thread-1" });
    await new Promise(done => setTimeout(done, 320));
    return { status: "completed", threadId: "thread-1", text: "done", deniedApprovals: 0 };
  }, loadOptions({ progress: "detailed" }));
  await h.plugin.setup(h.ctx);
  const progress = [];
  await h.tool().execute({ prompt: "detail" }, context({ progress }));
  expect(progress[0].title).toBe("oc-dex · deepseek-v4.1-flash");
  expect(progress.some(entry => entry.status.includes("thread thread-1"))).toBe(true);
});

test("detailed mode follows the model's own words", async () => {
  const h = harness(async (_input, report) => {
    report({ type: "text", text: "Reading the config" });
    await new Promise(done => setTimeout(done, 320));
    return { status: "completed", threadId: "thread-1", text: "done", deniedApprovals: 0 };
  }, loadOptions({ progress: "detailed" }));
  await h.plugin.setup(h.ctx);
  const progress = [];
  await h.tool().execute({ prompt: "detail" }, context({ progress }));
  expect(progress.some(entry => entry.status.includes("Reading the config"))).toBe(true);
});

test("takes its heartbeat cadence from configuration when the host did not pin one", async () => {
  // An empty timing object means nothing is pinned, so the cadence must come from
  // heartbeatSeconds. A 25 ms leftover would tick dozens of times in the same window.
  const h = harness(async () => {
    await new Promise(done => setTimeout(done, 1200));
    return { status: "completed", threadId: "t", text: "", deniedApprovals: 0 };
  }, loadOptions({ heartbeatSeconds: 1 }), {});
  await h.plugin.setup(h.ctx);
  const progress = [];
  await h.tool().execute({ prompt: "slow" }, context({ progress }));
  expect(progress.some(entry => entry.elapsedSeconds >= 1)).toBe(true);
  expect(progress.length).toBeGreaterThan(1);
  expect(progress.length).toBeLessThan(6);
});

test("reads a standalone config file and lets an explicit option override it", async () => {
  const build = options => {
    let tool;
    const ctx = {
      location: { directory: "C:\\workspace" },
      ...(options ? { options } : {}),
      integration: { connection: { active: async () => ({ id: "go" }), resolve: async () => ({ type: "key", key: "secret" }) } },
      permission: { assert: async () => {} },
      tool: { transform: async fn => fn({ add: value => { tool = value; } }) },
    };
    const plugin = createPlugin(async (_input, report) => {
      report({ type: "text", text: "Tail" });
      return { status: "completed", threadId: "t", text: "", deniedApprovals: 0 };
    }, undefined, { heartbeatMs: 25, settings: { progress: "detailed" } });
    return { plugin, ctx, tool: () => tool };
  };

  const fromFile = build();
  await fromFile.plugin.setup(fromFile.ctx);
  const detailed = [];
  await fromFile.tool().execute({ prompt: "x" }, context({ progress: detailed }));
  expect(detailed.some(entry => entry.status.includes("Tail"))).toBe(true);

  const explicit = build({ progress: "concise" });
  await explicit.plugin.setup(explicit.ctx);
  const concise = [];
  await explicit.tool().execute({ prompt: "x" }, context({ progress: concise }));
  expect(concise.some(entry => entry.status.includes("Tail"))).toBe(false);
});

test("a standalone config with an unusable value fails at setup", async () => {
  const ctx = {
    location: { directory: "C:\\workspace" },
    integration: { connection: {} },
    tool: { transform: async fn => fn({ add: () => {} }) },
  };
  const plugin = createPlugin(async () => ({}), undefined, { settings: { progress: "loud" } });
  await expect(plugin.setup(ctx)).rejects.toThrow(/progress/);
});

test("advertises an optional reasoning effort and forwards it to the runner, the gate and the output", async () => {
  let request;
  let gate;
  const h = harness(async input => {
    request = input;
    return { status: "completed", threadId: "t", text: "", deniedApprovals: 0 };
  });
  h.ctx.permission.assert = async value => { gate = value; };
  await h.plugin.setup(h.ctx);
  expect(h.tool().input.properties.reasoningEffort.enum).toContain("xhigh");
  expect(h.tool().input.required).not.toContain("reasoningEffort");
  const result = await h.tool().execute({ prompt: "x", reasoningEffort: "xhigh" }, context({ progress: [] }));
  expect(request.reasoningEffort).toBe("xhigh");
  expect(gate.metadata.reasoningEffort).toBe("xhigh");
  expect(result.content).toContain("xhigh");
});

test("leaves reasoning effort out of the run, the permission gate and the output by default", async () => {
  let request;
  let gate;
  const h = harness(async input => {
    request = input;
    return { status: "completed", threadId: "t", text: "", deniedApprovals: 0 };
  });
  h.ctx.permission.assert = async value => { gate = value; };
  await h.plugin.setup(h.ctx);
  const result = await h.tool().execute({ prompt: "x" }, context({ progress: [] }));
  expect(request.reasoningEffort).toBeUndefined();
  expect("reasoningEffort" in gate.metadata).toBe(false);
  expect(result.content).not.toContain("xhigh");
  expect(result.content).toContain("Model: deepseek-v4.1-flash");
});

test("rejects an unknown reasoning effort before doing any work", async () => {
  let ran = false;
  const h = harness(async () => { ran = true; return { status: "completed", threadId: "t", text: "", deniedApprovals: 0 }; });
  await h.plugin.setup(h.ctx);
  await expect(h.tool().execute({ prompt: "x", reasoningEffort: "turbo" }, context({ progress: [] }))).rejects.toThrow(/reasoning/i);
  expect(ran).toBe(false);
});
