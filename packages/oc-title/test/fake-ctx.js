// One controllable fake ctx, shared by every plugin test.
// No real timers longer than 50 ms; every poll uses 2 ms ticks.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFakeCtx(options = {}, settings = {}) {
  const {
    wrapGet = false,
    wrapList = false,
    updateDelayMs = 0,
    failUpdates = null, // Set<sessionID> | true | (args) => boolean
    getMisses = 0, // How many get calls return no record before one succeeds.
  } = settings;

  let missed = 0;

  const records = new Map();
  const updates = [];
  const getCalls = [];
  const listCalls = [];
  const subscribeArgs = [];
  const subscriptions = [];
  const tools = [];
  const messages = new Map();
  let activeStream = null;
  let attachedCleanup = null;
  let cleanupStarted = false;
  let inFlight = 0;
  const controller = new AbortController();

  function newStream() {
    const queue = [];
    const waiters = [];
    let terminal = null;
    const stream = {
      consumed: 0,
      push(event) {
        if (terminal) return;
        const waiter = waiters.shift();
        if (waiter) {
          stream.consumed++;
          waiter.resolve({ value: event, done: false });
        } else {
          queue.push(event);
        }
      },
      end(error) {
        if (terminal) return;
        terminal = error ? { kind: "error", error } : { kind: "end" };
        drain();
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (queue.length) {
          stream.consumed++;
          return Promise.resolve({ value: queue.shift(), done: false });
        }
        if (terminal) {
          if (terminal.kind === "error") return Promise.reject(terminal.error);
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
      },
      return() {
        terminal = { kind: "end" };
        const pending = waiters.splice(0);
        for (const waiter of pending) waiter.resolve({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };

    function drain() {
      while (waiters.length && (queue.length || terminal)) {
        const waiter = waiters.shift();
        if (queue.length) {
          stream.consumed++;
          waiter.resolve({ value: queue.shift(), done: false });
        } else if (terminal.kind === "error") {
          waiter.reject(terminal.error);
        } else {
          waiter.resolve({ value: undefined, done: true });
        }
      }
    }

    return stream;
  }

  function shouldFail(sessionID) {
    if (failUpdates === null) return false;
    if (failUpdates === true) return true;
    if (typeof failUpdates === "function") return failUpdates({ sessionID });
    return failUpdates.has(sessionID);
  }

  const ctx = {
    options,
    signal: controller.signal,
    subscribeArgs,
    subscriptions,
    updates,
    getCalls,
    listCalls,
    tools,
    messages,

    tool: {
      async transform(cb) {
        cb({ add: (tool) => tools.push(tool) });
        return { dispose() {} };
      },
    },

    event: {
      subscribe(args = {}) {
        subscribeArgs.push(args);
        const stream = newStream();
        if (args.signal) {
          args.signal.addEventListener("abort", () => stream.end());
        }
        subscriptions.push(stream);
        activeStream = stream;
        return stream;
      },
    },

    session: {
      async get({ sessionID } = {}) {
        getCalls.push(sessionID);
        if (missed < getMisses) { missed++; return wrapGet ? { data: undefined } : undefined; }
        const record = records.get(sessionID);
        return wrapGet ? { data: record } : record;
      },
      // Mirrors the documented V2 SessionContext.context: the full message
      // array for one session, with no invented message.list surface.
      async context({ sessionID } = {}) {
        return messages.get(sessionID) ?? [];
      },
      async list() {
        listCalls.push(true);
        const values = [...records.values()];
        return wrapList ? { data: values } : values;
      },
      async update(args = {}) {
        inFlight++;
        try {
          if (updateDelayMs > 0) await sleep(updateDelayMs);
          // Record exactly what the plugin sent; never merge or reshape it.
          updates.push({ ...args });
          const { sessionID, title, metadata } = args;
          const record = records.get(sessionID);
          if (record && typeof record === "object") {
            if (title !== undefined) record.title = title;
            if (metadata !== undefined) record.metadata = { ...metadata };
          }
          if (shouldFail(sessionID)) throw new Error(`update failed: ${sessionID}`);
        } finally {
          inFlight--;
        }
      },
    },

    // Test-facing helpers -------------------------------------------------
    seed(sessionID, record) {
      records.set(sessionID, { id: sessionID, ...record });
      return records.get(sessionID);
    },
    record(sessionID) {
      return records.get(sessionID);
    },
    seedContext(sessionID, rows) {
      messages.set(sessionID, rows);
    },
    push(event, index = subscriptions.length - 1) {
      const stream = subscriptions[index];
      if (!stream) throw new Error("no subscription to push into");
      activeStream = stream;
      stream.push(event);
    },
    end(error, index = subscriptions.length - 1) {
      const stream = subscriptions[index];
      if (!stream) throw new Error("no subscription to end");
      stream.end(error);
    },
    get consumed() {
      return subscriptions.reduce((sum, stream) => sum + stream.consumed, 0);
    },
    get inFlight() {
      return inFlight;
    },
    abort() {
      controller.abort();
    },
    attachCleanup(cleanup) {
      attachedCleanup = cleanup;
    },
    async flush() {
      // Settle writes only; subscriptions stay live so events can still be pushed.
      await settle();
    },
    async cleanup() {
      if (attachedCleanup && !cleanupStarted) {
        cleanupStarted = true;
        await attachedCleanup();
      }
      await settle();
    },
    async waitFor(predicate, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(2);
      }
      return false;
    },
    async settle() {
      await settle();
    },
  };

  async function settle() {
    const deadline = Date.now() + 1000;
    let stable = 0;
    let lastCount = updates.length;
    while (Date.now() < deadline) {
      if (inFlight === 0) {
        if (updates.length === lastCount) {
          stable++;
          if (stable >= 3) return;
        } else {
          lastCount = updates.length;
          stable = 0;
        }
      } else {
        stable = 0;
      }
      await sleep(2);
    }
  }

  return ctx;
}

export function event(type, { id, seq, title } = {}) {
  const data = {};
  if (id !== undefined) data.sessionID = id;
  if (title !== undefined) data.title = title;
  return { type, data, durable: { seq } };
}
