// Everything the host knows about the session on screen.
//
// One factory closes over the plugin `context` and returns the read-only
// lookups the rail needs: the session's messages, family tree, status,
// activity, shells, permissions, and derived figures (context occupancy,
// elapsed time, subagent totals, busy). Every lookup degrades to "no data"
// instead of throwing — the rail must never break because a read failed.
// Coercion of untrusted values happens through ./coerce.js.

import type { Plugin } from "@opencode/plugin/tui";
import { createActiveTime } from "./session-elapsed.js";
import { asCount, asRecord, asText, type SessionLike } from "./coerce.js";
import { turnKey, type ThroughputSpan } from "./stats.js";

/**
 * How strong a money figure's claim is: `exact` is a recorded figure the host
 * owns, `bounded` is recorded charges over the history the host still holds,
 * `estimated` needed the model catalog because a charge was not recorded.
 */
type UsageKind = "exact" | "bounded" | "estimated";

/** A money figure with the strength of its claim. */
interface UsageFigure {
  cost: number;
  kind: UsageKind;
}

/**
 * The location the rail reads shell records and VCS from: the host's current
 * location, or its default when no location is set. A host that cannot resolve
 * a default degrades to "no location" rather than taking the rail down.
 */
export function locationOf(context: Plugin.Context) {
  try {
    return context.location ?? context.data.location.default();
  } catch {
    return context.location;
  }
}

/** Token counts, in the shape the host publishes them. */
interface TokenCounts {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export function createSessionReads(context: Plugin.Context) {
  /** How many trailing messages are inspected for tool parts. */
  const RECENT_MESSAGES = 4;

  // The host owns these caches; a failure to read one must never break the
  // rail, so every lookup degrades to "no data" instead of throwing.
  const messagesOf = (sessionID: string): readonly unknown[] => {
    try {
      return context.data.session.message.list(sessionID) ?? [];
    } catch {
      return [];
    }
  };

  // Usage.
  //
  // The host publishes both figures and neither needs reconstructing:
  // `data.session.cost(id)` is the family roll-up (this session plus every
  // descendant) and `session.get().cost` the session's own persisted aggregate.
  // The aggregate spans every model the session ran, and there is no host API
  // for per-model spend, so only `cost` is derived - from the recorded per-step
  // costs of the model currently selected.
  //
  //   total - the host roll-up, exact. Zero with no tokens is a real $0.000;
  //           zero with tokens on a priced model is a catalog estimate, marked.
  //   cost  - recorded step costs for the current model over the history the
  //           host exposes, marked as a floor when that history is a window,
  //           and as an estimate when a step had to be catalog-priced.

  const emptyTokens = (): TokenCounts => ({
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  });

  const readTokens = (source: unknown): TokenCounts => {
    const record = asRecord(source);
    const tokens = emptyTokens();
    if (record === undefined) return tokens;
    tokens.input = asCount(record["input"]) ?? 0;
    tokens.output = asCount(record["output"]) ?? 0;
    tokens.reasoning = asCount(record["reasoning"]) ?? 0;
    const cache = asRecord(record["cache"]);
    tokens.cache.read = asCount(cache?.["read"]) ?? 0;
    tokens.cache.write = asCount(cache?.["write"]) ?? 0;
    return tokens;
  };

  // Model identity as the host keys it: provider and id. The variant is a
  // setting of the same model, not a different bill, so it is not part of it.
  const modelKeyOf = (model: unknown): string | undefined => {
    const ref = asRecord(model);
    const id = asText(ref?.["id"]) ?? asText(ref?.["modelID"]);
    if (id === undefined) return undefined;
    const provider = asText(ref?.["providerID"]);
    return provider === undefined ? id : `${provider}/${id}`;
  };

  // Catalog prices, per million tokens, indexed by provider and model id. The
  // catalog array is the cache key: when the host swaps it the index is rebuilt.
  const PRICE_PER_UNIT = 1_000_000;
  let pricedFrom: readonly unknown[] | undefined;
  let priceIndex = new Map<string, readonly { size: number; price: TokenCounts }[]>();

  const priceKey = (id: string, providerID: string | undefined): string =>
    providerID === undefined ? id : `${providerID}/${id}`;

  // One catalog row as the four rates it bills, reusing the token shape so a
  // step's tokens multiply rate-for-rate: input at the input rate, generation
  // (output plus reasoning) at the output rate, each cache rung at its own.
  const readPrice = (source: unknown): TokenCounts | undefined => {
    const record = asRecord(source);
    if (record === undefined) return undefined;
    const input = asCount(record["input"]);
    const output = asCount(record["output"]);
    if (input === undefined || output === undefined) return undefined;
    const cache = asRecord(record["cache"]);
    return {
      input,
      output,
      reasoning: output,
      cache: {
        read: asCount(cache?.["read"]) ?? input,
        write: asCount(cache?.["write"]) ?? input,
      },
    };
  };

  const prices = (): Map<string, readonly { size: number; price: TokenCounts }[]> => {
    let entries: readonly unknown[] = [];
    try {
      entries = context.data.location.model.list(locationOf(context)) ?? [];
    } catch {
      entries = [];
    }
    if (entries === pricedFrom) return priceIndex;
    pricedFrom = entries;
    priceIndex = new Map();
    for (const entry of entries) {
      const record = asRecord(entry);
      if (record === undefined) continue;
      const id = asText(record["id"]) ?? asText(record["modelID"]);
      if (id === undefined) continue;
      const tiers: { size: number; price: TokenCounts }[] = [];
      const cost = record["cost"];
      const rows = Array.isArray(cost) ? cost : [cost];
      for (const row of rows) {
        const price = readPrice(row);
        if (price === undefined) continue;
        const tier = asRecord(asRecord(row)?.["tier"]);
        tiers.push({ size: asCount(tier?.["size"]) ?? 0, price });
      }
      if (tiers.length === 0) continue;
      tiers.sort((left, right) => left.size - right.size);
      priceIndex.set(priceKey(id, asText(record["providerID"])), tiers);
    }
    return priceIndex;
  };

  // What one step costs at catalog prices: the prompt is billed at the input
  // rate, generation (output plus reasoning) at the output rate, and the two
  // cache rungs at their own. A tiered model is priced at the largest tier the
  // prompt reaches. Unknown model, unknown price, or zero rates answer zero - a
  // genuinely free model stays free.
  const catalogCost = (tokens: TokenCounts, model: unknown): number => {
    const ref = asRecord(model);
    const id = asText(ref?.["id"]) ?? asText(ref?.["modelID"]);
    if (id === undefined) return 0;
    const index = prices();
    const tiers = index.get(priceKey(id, asText(ref?.["providerID"]))) ?? index.get(id);
    if (tiers === undefined || tiers.length === 0) return 0;
    const prompt = tokens.input + tokens.cache.read + tokens.cache.write;
    let chosen = tiers[0];
    for (const tier of tiers) if (tier.size <= prompt) chosen = tier;
    const price = chosen?.price;
    if (price === undefined) return 0;
    const micro =
      tokens.input * price.input +
      tokens.output * price.output +
      tokens.reasoning * price.reasoning +
      tokens.cache.read * price.cache.read +
      tokens.cache.write * price.cache.write;
    return micro / PRICE_PER_UNIT;
  };

  // The `cost` figure: recorded step costs for the model the session currently
  // runs. The aggregate is deliberately NOT used - it spans every model the
  // session ever ran, so it cannot answer a per-model question.
  //
  // Two guards, both mirroring the host's own accounting:
  //   - a fork's copied parent history predates the fork's creation
  //     (`stats.ts`: `message.time_created >= session.time_created`), so it is
  //     not this session's spend;
  //   - the TUI surface exposes no paging (`message.list` only, no `more()`),
  //     so the history on hand is a window and the figure is a floor.
  const sessionCost = (
    sessionID: string,
    record: SessionLike | undefined,
  ): UsageFigure | undefined => {
    if (record === undefined) return undefined;
    const messages = messagesOf(sessionID);
    const model = modelKeyOf(record?.model);
    const created = asCount(asRecord(record?.time)?.["created"]) ?? 0;
    let cost = 0;
    let counted = 0;
    let estimated = false;
    for (const entry of messages) {
      const message = asRecord(entry);
      if (message?.["type"] !== "assistant") continue;
      const stamp = asCount(asRecord(message["time"])?.["created"]);
      if (stamp !== undefined && stamp < created) continue;
      if (model !== undefined && modelKeyOf(message["model"]) !== model) continue;
      const recorded = asCount(message["cost"]);
      const stepTokens = asRecord(message["tokens"]);
      if (recorded === undefined && stepTokens === undefined) continue;
      counted += 1;
      if (recorded !== undefined && recorded > 0) {
        cost += recorded;
      } else {
        cost += catalogCost(readTokens(stepTokens), message["model"]);
        estimated = true;
      }
    }
    if (counted === 0) return undefined;
    return { cost, kind: estimated ? "estimated" : "bounded" };
  };

  // `data.session.cost`, the host's persisted family roll-up. It answers a
  // family figure only for a ROOT id - handed a child it returns that child's
  // own cost - so the caller resolves the root first.
  const hostFamilyCost = (sessionID: string): number | undefined => {
    try {
      const accessor = context.data.session.cost;
      if (typeof accessor !== "function") return undefined;
      return asCount(accessor.call(context.data.session, sessionID));
    } catch {
      return undefined;
    }
  };

  // The `total` figure: the host's family roll-up, always resolved from the
  // family ROOT. Nothing is summed for a non-zero figure - the roll-up is the
  // persisted total of per-session aggregates, so it already survives
  // stop/resume, model switches and compaction, and it is exact.
  //
  // A zero roll-up is a real zero when the family spent nothing. Where the
  // family holds tokens on models the catalog prices, a provider-reported zero
  // is a missing charge: every member's messages are priced at the model each
  // message ran, and the figure is marked as an estimate - never exact.
  const treeTotals = (
    sessionID: string,
  ): { cost: number; count: number; tokens: TokenCounts; kind: UsageKind } | undefined => {
    let root = sessionID;
    try {
      root = context.data.session.root(sessionID) ?? sessionID;
    } catch {
      root = sessionID;
    }
    let ids: readonly string[];
    try {
      ids = context.data.session.family(root) ?? [root];
    } catch {
      ids = [root];
    }
    const members = ids.includes(root) ? ids : [root, ...ids];

    const recordOf = (id: string): SessionLike | undefined => {
      try {
        return context.data.session.get(id) as SessionLike | undefined;
      } catch {
        return undefined;
      }
    };

    const own = recordOf(root);
    // No session record is no figure: the row stays absent (the persist layer's
    // skeleton draws in its place), never a fabricated $0.000.
    if (own === undefined) return undefined;

    const tokens = emptyTokens();
    const addTokens = (record: SessionLike | undefined): void => {
      const read = readTokens(record?.tokens);
      tokens.input += read.input;
      tokens.output += read.output;
      tokens.reasoning += read.reasoning;
      tokens.cache.read += read.cache.read;
      tokens.cache.write += read.cache.write;
    };
    addTokens(own);

    let count = 0;
    for (const id of members) {
      if (id === root) continue;
      const child = recordOf(id);
      if (child === undefined) continue;
      count += 1;
      addTokens(child);
    }

    // Per member: its record, and the recorded assistant charges visible for it
    // with the host's fork guard applied. `visible` is the floor the family can
    // prove from what it holds; `complete` says whether every id the family
    // lists has a record at all.
    let visible = 0;
    let complete = true;
    for (const id of members) {
      const record = recordOf(id);
      if (record === undefined) {
        complete = false;
        continue;
      }
      const created = asCount(asRecord(record.time)?.["created"]) ?? 0;
      let charges = 0;
      for (const entry of messagesOf(id)) {
        const message = asRecord(entry);
        if (message?.["type"] !== "assistant") continue;
        const stamp = asCount(asRecord(message["time"])?.["created"]);
        if (stamp !== undefined && stamp < created) continue;
        charges += asCount(message["cost"]) ?? 0;
      }
      visible += Math.max(asCount(record.cost) ?? 0, charges);
    }

    let rolled = hostFamilyCost(root);
    if (rolled === undefined) {
      // A host without the accessor: the per-session aggregates are the same
      // persisted numbers, so their sum is still the family figure.
      let total = 0;
      for (const id of members) total += asCount(recordOf(id)?.cost) ?? 0;
      rolled = total;
    }
    // The table, in order. `rolled` is the host's persisted family figure and is
    // never exceeded: a floor above it would claim money the host says was not
    // spent. `exact` is claimed only when the family is complete and the roll-up
    // already covers the charges visible on the message lists.
    if (rolled > 0) {
      return {
        cost: rolled,
        count,
        tokens,
        kind: complete && rolled >= visible ? "exact" : "bounded",
      };
    }
    if (visible > 0) return { cost: visible, count, tokens, kind: "bounded" };
    if (!complete) return { cost: 0, count, tokens, kind: "bounded" };

    // Zero: price the whole family's messages, each at its own model; a member
    // with no message list on hand still contributes its recorded tokens.
    let priced = 0;
    for (const id of members) {
      const record = recordOf(id);
      if (record === undefined) continue;
      const created = asCount(asRecord(record.time)?.["created"]) ?? 0;
      const listed = messagesOf(id);
      let pricedHere = false;
      for (const entry of listed) {
        const message = asRecord(entry);
        if (message?.["type"] !== "assistant") continue;
        const stamp = asCount(asRecord(message["time"])?.["created"]);
        if (stamp !== undefined && stamp < created) continue;
        priced += catalogCost(readTokens(message["tokens"]), message["model"]);
        pricedHere = true;
      }
      if (!pricedHere) priced += catalogCost(readTokens(record.tokens), record.model);
    }
    if (priced > 0) return { cost: priced, count, tokens, kind: "estimated" };
    return { cost: 0, count, tokens, kind: "exact" };
  };

  // A message's own totals are per-request, so the last assistant message's
  // prompt size is an ESTIMATE of the current context occupancy - not a running
  // total, and not a host-reported figure (hence the `~` on the `context` row).
  // It sums input + cache read + cache WRITE: a written entry still occupies
  // the window, even though `write` is deliberately excluded from the `cache`
  // row's hit-rate denominator (creating an entry is not a lookup).
  const contextUsage = (sessionID: string, model: unknown) => {
    const messages = messagesOf(sessionID);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const tokens = asRecord(asRecord(messages[index])?.tokens);
      const input = asCount(tokens?.input);
      if (tokens === undefined || input === undefined) continue;
      const cache = asRecord(tokens.cache);
      const used = input + (asCount(cache?.read) ?? 0) + (asCount(cache?.write) ?? 0);
      if (used === 0) return undefined;
      return { used, limit: contextLimit(model) };
    }
    return undefined;
  };

  // The window lives at `limit.context` on the catalog entry, and two
  // providers can expose the same model id with different windows — so the
  // provider has to match too, or the gauge would read the wrong ceiling.
  const contextLimit = (model: unknown): number | undefined => {
    const ref = asRecord(model);
    const id = ref?.id;
    const providerID = ref?.providerID;
    if (typeof id !== "string") return undefined;
    try {
      const location = context.location ?? context.data.location.default();
      for (const entry of context.data.location.model.list(location) ?? []) {
        const record = asRecord(entry);
        if (record === undefined || record.id !== id) continue;
        if (typeof providerID === "string" && record.providerID !== providerID) continue;
        const limit = asRecord(record.limit);
        return asCount(limit?.context) ?? asCount(record.context) ?? asCount(record.contextWindow);
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const statusOf = (sessionID: string): string | undefined => {
    try {
      return context.data.session.status(sessionID);
    } catch {
      return undefined;
    }
  };

  // Recent tool parts, oldest first. Only the tail is inspected: a loop that is
  // not currently happening is history, and a hang is by definition now.
  const recentParts = (sessionID: string): readonly unknown[] => {
    const parts: unknown[] = [];
    for (const entry of messagesOf(sessionID).slice(-RECENT_MESSAGES)) {
      const content = asRecord(entry)?.["content"];
      if (Array.isArray(content)) parts.push(...content);
    }
    return parts;
  };

  // The host's own shell records, which outlive the tool call: a backgrounded
  // command returns its result immediately, so its part settles while the
  // process keeps running. This is the only signal that survives that.
  //
  // Shells are listed per LOCATION, not per session, so the session is matched
  // on the record's own `metadata.sessionID` — the documented shape, rather
  // than a session-scoped accessor the published API does not carry.
  const shellsOf = (sessionID: string): readonly unknown[] => {
    try {
      const shells = context.data.shell.list(locationOf(context)) ?? [];
      return shells.filter(
        (entry) => asText(asRecord(asRecord(entry)?.["metadata"])?.["sessionID"]) === sessionID,
      );
    } catch {
      return [];
    }
  };

  // The newest thing the host recorded for this session that is not a tool
  // part, so the quiet-turn rule is not blind to a model that is streaming.
  const lastActivity = (sessionID: string): number | undefined => {
    const messages = messagesOf(sessionID);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const time = asRecord(asRecord(messages[index])?.["time"]);
      const stamp =
        asCount(time?.["completed"]) ?? asCount(time?.["streamed"]) ?? asCount(time?.["created"]);
      if (stamp !== undefined) return stamp;
    }
    return undefined;
  };

  // What is waiting, not just how many. A bare count tells you to go and look;
  // naming the request tells you whether it is worth looking at.
  const permsOf = (
    sessionID: string,
  ): { count: number; action?: string; resource?: string } | undefined => {
    try {
      const requests = context.data.session.permission.list(sessionID);
      if (requests === undefined || requests.length === 0) return undefined;
      const first = asRecord(requests[0]);
      const action = typeof first?.["action"] === "string" ? first["action"] : undefined;
      const resources = Array.isArray(first?.["resources"]) ? first["resources"] : [];
      const resource = typeof resources[0] === "string" ? resources[0] : undefined;
      return { count: requests.length, action, resource };
    } catch {
      return undefined;
    }
  };

  // Anything genuinely working keeps the status glyph turning: this session
  // (thinking, streaming, running tools), any subagent in its tree, or a shell
  // command still running. Returns `undefined` when the host has not said
  // either way, so the rail can omit the row rather than invent "idle".
  const busy = (sessionID: string): boolean | undefined => {
    const status = statusOf(sessionID);
    if (status === "running") return true;

    try {
      for (const id of context.data.session.family(sessionID) ?? []) {
        if (id === sessionID) continue;
        try {
          if (context.data.session.status(id) === "running") return true;
        } catch {
          // One unreadable child must not hide a running sibling.
        }
      }
    } catch {
      // No subagent status on this host; the shell check below still applies.
    }

    try {
      if (shellsOf(sessionID).some((entry) => asRecord(entry)?.["status"] === "running")) return true;
    } catch {
      // Unreadable shells just mean no shell signal.
    }

    return status === undefined ? undefined : false;
  };

  // Active time over the session's whole lifetime, derived from the host's own
  // timestamps rather than accumulated in this process: the figure is the
  // merged union of the assistant turns' spans across exactly the scope
  // `busy()` consults — the displayed session plus every id `family()`
  // returns — with an uncompleted turn ending at `now` while the scope is
  // genuinely working, and collapsing to its last recorded stamp when nothing
  // is working. So a restart recomputes the same figure instead of resetting,
  // a climbing turn keeps climbing while it is in flight, a settled scope
  // freezes, and a stalled or abandoned turn bills no idle time. Tokens are
  // ignored: a zero-output turn still took wall time. One `now` for the whole
  // scan, so every in-flight turn ends at the same instant and the union
  // cannot be skewed by the reads drifting apart. Every read degrades to
  // empty rather than throwing, so an absent family or an unstamped host hides
  // the row instead of breaking the rail. Monotonicity, caching and the
  // per-session bound live in ./session-elapsed.js; this is only the host read.
  const spansOf = (sessionID: string, now: number): readonly ThroughputSpan[] => {
    try {
      // Whether the scope is genuinely working, read once for the whole scan:
      // every uncompleted turn in it shares the same end rule, and the scope
      // is exactly what `busy()` already consults. A read that throws counts
      // as not busy.
      let live = false;
      try {
        live = busy(sessionID) === true;
      } catch {
        live = false;
      }
      const ids = new Set<string>([sessionID]);
      try {
        for (const id of context.data.session.family(sessionID) ?? []) ids.add(id);
      } catch {
        // No family on this host: the session's own turns still stand.
      }
      const spans: ThroughputSpan[] = [];
      for (const id of ids) {
        for (const entry of messagesOf(id)) {
          const message = asRecord(entry);
          if (message?.["type"] !== "assistant") continue;
          const stamp = asRecord(message["time"]);
          const created = asCount(stamp?.["created"]);
          if (created === undefined) continue;
          const completed = asCount(stamp?.["completed"]);
          const streamed = asCount(stamp?.["streamed"]);
          // A completed turn ends at `completed`, covering its tool
          // settlement. An uncompleted one ends at `now` while the scope is
          // genuinely working, and collapses to its last recorded stamp
          // (`streamed`, else its own start) when nothing is working — so a
          // host that never writes `completed` cannot bill idle either.
          const end = completed ?? (live ? now : (streamed ?? created));
          if (!Number.isFinite(end)) continue;
          const output = asRecord(message["tokens"])?.["output"];
          spans.push({
            key: turnKey(message["id"], created, completed, output, streamed),
            start: created,
            end: Math.max(created, end),
          });
        }
      }
      return spans;
    } catch {
      // A throwing read never reaches the rail: it degrades to no spans.
      return [];
    }
  };

  // Whether the host still knows a session. The elapsed clock's sweep consults
  // this before dropping an entry, so only a forgotten session loses its
  // high-water mark; a throwing or absent record counts as forgotten.
  const knows = (sessionID: string): boolean => {
    try {
      return context.data.session.get(sessionID) !== undefined;
    } catch {
      return false;
    }
  };

  const activeTime = createActiveTime({ spansOf, knows });
  const sessionElapsed = (sessionID: string, now: number = Date.now()): number | undefined =>
    activeTime(sessionID, now);

  return {
    messagesOf,
    treeTotals,
    sessionCost,
    contextUsage,
    sessionElapsed,
    statusOf,
    recentParts,
    shellsOf,
    lastActivity,
    permsOf,
    busy,
  };
}