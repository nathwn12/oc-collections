/**
 * oc-fallback - OpenCode plugin: a seat steps down its own model ladder when its
 * model fails, and does it without being asked.
 *
 * Minimal on purpose. One tool (`switch_model`, in the `model` namespace) and one
 * automatic behaviour (a recorded failure moves the next request one rung down).
 * Everything else is configuration: the provider, the ladders, the rules a rung
 * must pass, the log path. `~/.config/opencode/oc-fallback.json` holds it, or the
 * file named by `OC_FALLBACK_CONFIG`; `OC_FALLBACK=off` disables the plugin
 * without touching the file.
 *
 * The ladders are not here. They are either inline in that config or, by pointer
 * (`{ "ladders": { "file": "...", "key": "fallbacks" } }`), read from the file
 * that owns them — on this machine `oc-superpowers/harness.json`, so the fleet
 * keeps one record of which model serves which seat and this package never copies
 * or writes it.
 *
 * Failure policy: setup never throws. A missing config, a bad JSON body, an
 * unreadable ladder file or a host without the surfaces this needs all degrade to
 * "less plugin", never to a failed session.
 */
import { readFileSync } from 'node:fs';

import { createCatalog } from './benchmarks.mjs';
import { loadConfig, readLadders } from './config.mjs';
import { createFallback } from './ladder.mjs';
import { formatLine, makeLog } from './log.mjs';

export default {
  id: 'oc-fallback',

  setup(ctx) {
    try {
      const env = process.env;
      const loaded = loadConfig({ env, read: (file) => readFileSync(file, 'utf8') });
      const config = loaded.config;
      const log = makeLog(config.logPath);
      const note = (reason) => {
        try {
          log(formatLine({ reason }));
        } catch {
          /* the record is best-effort */
        }
      };

      if (loaded.problem) note(`${loaded.problem}:using-defaults`);
      if (!config.enabled) {
        note('disabled:config');
        return;
      }

      const resolved = readLadders(config.ladders, { read: (file) => readFileSync(file, 'utf8') });
      if (resolved.problem && !loaded.problem) note(`${resolved.problem}:${resolved.source}`);

      createFallback({
        config,
        ladders: resolved.ladders,
        ctx,
        log,
        benchmark: createCatalog({
          sitemapUrl: config.sitemapUrl,
          ttlMs: config.benchmarkTtlMs,
        }).status,
        env,
      });
    } catch {
      /* fail open: a broken config never costs a session */
    }
  },
};
