/**
 * oc-graphify - OpenCode plugin: put the Atlas graph in front of every request,
 * automatically.
 *
 * What it replaces: `graphify install --platform opencode` writes a
 * `tool.execute.before` hook that rewrites the first shell command of a session
 * into `echo "<hint>" ; <cmd>`. That mutates the string a permission wrapper
 * matches on, to deliver a hint the skill already carries. This plugin delivers
 * the same orientation as injected context instead, with the real numbers and
 * the freshness verdict the echo never had, and it never touches a command.
 *
 * What it deliberately does not do: no tools, no CLI wrapper, no rebuild. The
 * MCP owns the read verbs, the CLI owns the writes; a second surface for either
 * would drift from them.
 *
 * Failure policy: every path returns null or swallows. A missing graph, a
 * broken config, an unreadable HEAD, or a host that does not offer the hook all
 * degrade to "inject nothing". Setup never throws, so one bad file can never
 * take down the host's plugin generation.
 */
import { MARKER, configPath, headCommit, readConfig, readGraph, render } from './lib.js';

/** HEAD is re-read at most this often; a rebuild is a minute-scale act. */
const HEAD_TTL_MS = 60_000;

export default {
  id: 'oc-graphify',

  setup(ctx) {
    try {
      if (typeof ctx?.session?.hook !== 'function') return;
      const config = readConfig(configPath());
      if (!config) return;

      let cache = null; // { at, graph, head }
      const snapshot = () => {
        const now = Date.now();
        if (!cache || now - cache.at > HEAD_TTL_MS) {
          cache = { at: now, graph: readGraph(config.atlas), head: headCommit(config.atlas) };
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

          const { graph, head } = snapshot();
          const text = render({ graph, head, atlas: config.atlas });
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

      // The three request shapes oc-stacked already proves on this host; a host
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
