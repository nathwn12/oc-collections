/**
 * oc-graphify - OpenCode plugin: put the Atlas graph in front of every request,
 * automatically, and answer three reads over it.
 *
 * What it replaces: `graphify install --platform opencode` writes a
 * `tool.execute.before` hook that rewrites the first shell command of a session
 * into `echo "<hint>" ; <cmd>`. That mutates the string a permission wrapper
 * matches on, to deliver a hint the skill already carries. This plugin delivers
 * the same orientation as injected context instead, with the real numbers and
 * the freshness verdict the echo never had, and it never touches a command.
 *
 * What it does: the injection, plus `graph_node`, `graph_neighbors` and
 * `graph_path` - pure reads over the same graph.json, so the block can name
 * something that answers even when no graphify MCP is configured. Search stays
 * with `graphify query` in the CLI, and the hub list stays in GRAPH_REPORT.md;
 * the host owns only locating and relating nodes.
 *
 * What it still does not do: writes. Rebuild, cluster and label belong to the
 * CLI, because they need Python and a model.
 *
 * Failure policy: every path returns null or swallows. A missing graph, a
 * broken config, an unreadable HEAD, a host without the hook or without the
 * tool editor all degrade to "less plugin", never to a failed request. Setup
 * never throws, so one bad file can never take down the host's generation.
 */
import { MARKER, askFreshnessAsync, configPath, corpusFreshness, graphFile, headCommitAsync, readConfig, readGraph, render } from './lib.js';
import { readGraph as loadGraph } from './graph.js';
import { toolDefinitions } from './tools.js';

/** HEAD is re-read at most this often; a rebuild is a minute-scale act. */
const HEAD_TTL_MS = 60_000;

export default {
  id: 'oc-graphify',

  setup(ctx) {
    try {
      if (typeof ctx?.session?.hook !== 'function') return;
      const config = readConfig(configPath());
      if (!config) return;

      // The reads. Registered once per plugin load; a host without a tool
      // editor simply keeps the injection.
      let graphCache = null;
      const loadAtlas = (file) => {
        const now = Date.now();
        if (!graphCache || graphCache.file !== file || now - graphCache.at > HEAD_TTL_MS) {
          graphCache = { at: now, file, graph: loadGraph(file) };
        }
        return graphCache.graph;
      };
      try {
        const definitions = toolDefinitions({ graphFile: graphFile(config.atlas), load: loadAtlas });
        if (typeof ctx?.tool?.transform === 'function') {
          Promise.resolve(
            ctx.tool.transform((editor) => {
              try {
                if (typeof editor.namespace === 'function') {
                  editor.namespace({
                    name: 'graphify',
                    description: 'Reads over the Graphify Atlas: locate nodes, list neighbours, trace paths.',
                  });
                }
              } catch {
                /* the namespace is cosmetic; the tools still register */
              }
              for (const def of definitions) {
                try {
                  editor.add({
                    name: def.name,
                    description: def.description,
                    input: def.input,
                    options: { namespace: 'graphify', codemode: true },
                    execute: def.execute,
                  });
                } catch {
                  try {
                    editor.add({ name: def.name, description: def.description, input: def.input, execute: def.execute });
                  } catch {
                    /* one rejected tool never costs the others */
                  }
                }
              }
            }),
          ).catch(() => {});
        }
      } catch {
        /* the injection still works without tools */
      }

      let cache = { at: 0, graph: readGraph(config.atlas), head: null, fresh: { state: 'unknown' } };
      let refreshFlight = null;
      const snapshot = () => {
        const now = Date.now();
        if (!cache || now - cache.at > HEAD_TTL_MS) {
          if (!refreshFlight) {
            refreshFlight = Promise.resolve().then(() => {
              const before = readGraph(config.atlas);
              return Promise.all([headCommitAsync(config.atlas), askFreshnessAsync(config.atlas)])
                .then(([head, fresh]) => {
                  const graph = readGraph(config.atlas);
                  const changed = before?.fingerprint !== graph?.fingerprint;
                  // The hidden child is authoritative; the ledger is the cheap
                  // fallback when no child verdict exists. Both are read once
                  // per refresh, never on a tool call or a per-request render.
                  const source = fresh ?? corpusFreshness(config.atlas, graph);
                  return { graph, head, fresh: changed ? { state: 'unknown' } : source ?? { state: 'unknown' } };
                });
            }).then((next) => { cache = { ...next, at: Date.now() }; }).catch(() => {
              cache = { ...cache, at: Date.now(), fresh: { state: 'unknown' } };
            }).finally(() => { refreshFlight = null; });
          }
        }
        return cache;
      };

      const inject = (event) => {
        try {
          const messages = event?.messages;
          if (!Array.isArray(messages) || !messages.length) return;
          const first = messages.find((m) => m?.role === 'user');

          // One injection per request build: the marker travels in the text.
          const carried = first?.content?.some?.(
            (part) => part?.type === 'text' && typeof part.text === 'string' && part.text.startsWith(MARKER),
          );
          if (carried) return;

          const { graph, head, fresh } = snapshot();
          const text = render({ graph, head, atlas: config.atlas, fresh });
          if (first) {
            if (!Array.isArray(first.content)) first.content = [];
            first.content.unshift({ type: 'text', text });
          } else {
            messages.push({ role: 'user', content: [{ type: 'text', text }] });
          }
        } catch {
          /* a hint is never worth failing a request for */
        }
      };

      // The three request shapes this host already proves; a host
      // that rejects one keeps the others because the registration is per hook.
      for (const hook of ['context', 'compaction', 'generate']) {
        try {
          ctx.session.hook(hook, inject);
        } catch {
          /* older host: the next hook still carries the block */
        }
      }
    } catch {
      /* setup never throws */
    }
  },
};
