// oc-dispatch — OpenCode plugin: route each request to the cheapest adequate
// model in the live catalog, and ship dormant.
//
// The shipped routing.json has mode: off. On load the plugin reads it, builds a
// catalog snapshot from ctx.model.list(), registers the resolve hook, four
// commands and a routing.json watcher, and writes one line. It changes no model
// until an owner switches to shadow or enforce. Every host surface is optional:
// a missing catalog, a bad policy, absent storage, hook or command domain all
// degrade to "less plugin", never to a failed session. Setup apply is reachable
// only through the exported `applySetup` seam, never from load.
import { readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Plugin } from '@opencode/plugin';
import { DEFAULTS, loadPolicy, validate } from './policy.mjs';
import { normalize } from './catalog.mjs';
import { createGradeStore } from './grade.mjs';
import { createResolver } from './resolve.mjs';
import { snapshot } from './config.mjs';
import { appendLine } from './receipt.mjs';
import { apply as applySetup, preview as previewSetup } from './setup.mjs';

const ROUTING_FILE = fileURLToPath(new URL('../routing.json', import.meta.url));
const DEFAULT_LOG = join(homedir(), '.local', 'share', 'opencode', 'log', 'oc-dispatch.log');

export async function setupDispatch(ctx, deps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const read = deps.read ?? ((p) => readFileSync(p, 'utf8'));
  const append = deps.append ?? ((p, line) => appendLine(p, line));
  const watchFn = deps.watchFn ?? ((p, cb) => watch(p, cb));
  const routingPath = env.OC_DISPATCH_ROUTING ?? ROUTING_FILE;
  const logPath = env.OC_DISPATCH_LOG ?? DEFAULT_LOG;
  const log = deps.log ?? ((line) => appendLine(logPath, line));

  let policy = structuredClone(DEFAULTS);
  let problem = null;
  try {
    const loaded = loadPolicy(read(routingPath));
    policy = loaded.policy;
    problem = loaded.errors[0] ?? null;
  } catch {
    problem = 'routing-unreadable';
  }

  async function readModels() {
    try {
      return normalize(await ctx?.model?.list?.());
    } catch {
      return [];
    }
  }

  let models = await readModels();
  const grades = createGradeStore(ctx?.storage, { now });
  let config = { sources: [], effectiveDepth: null, winner: null };
  try {
    config = snapshot({ env, ctxConfig: ctx?.config });
  } catch {
    /* the config view is read-only and optional */
  }
  const resolver = createResolver({ policy, models, grades, log, append, logPath, now });

  const ctrl = {
    policy,
    get models() {
      return models;
    },
    grades,
    config,
    resolver,
    status: () => ({
      mode: resolver.status().mode,
      cacheAgeMs: resolver.cacheAgeMs(),
      models: models.length,
      banked: grades.bankedKeys(),
      effectiveDepth: config.effectiveDepth,
      winner: config.winner,
      sources: config.sources,
    }),
    doctor: () => {
      const verdict = validate(policy);
      return {
        ok: verdict.ok,
        errors: verdict.errors,
        sources: config.sources,
        effectiveDepth: config.effectiveDepth,
        winner: config.winner,
        models: models.length,
        mode: resolver.status().mode,
      };
    },
    off: () => {
      resolver.setMode('off');
      try {
        log('[oc-dispatch] mode=off');
      } catch {
        /* best-effort */
      }
      return { mode: 'off' };
    },
    refresh: async () => {
      try {
        const loaded = loadPolicy(read(routingPath));
        policy = loaded.policy;
        ctrl.policy = policy;
        resolver.setPolicy(policy);
      } catch {
        /* keep the last good policy */
      }
      models = await readModels();
      resolver.setModels(models);
      return ctrl.status();
    },
    close: () => {},
  };

  log(`[oc-dispatch] loaded mode=${policy.mode} models=${models.length}${problem ? ` problem=${problem}` : ''}`);

  try {
    if (typeof ctx?.session?.hook === 'function') {
      Promise.resolve(ctx.session.hook('experimental.model.resolve', (event) => resolver.resolve(event))).catch(() => {});
    }
  } catch {
    /* a host without this hook keeps the plugin's other surfaces */
  }

  const commands = [
    { name: 'dispatch-status', description: 'Report dispatch mode, cache age, banked models and the winning config source.', execute: async () => ctrl.status() },
    { name: 'dispatch-doctor', description: 'Report policy validity and the merged subagent depth with its winning source.', execute: async () => ctrl.doctor() },
    { name: 'dispatch-off', description: 'Stop model substitution for this running session.', execute: async () => ctrl.off() },
    { name: 'dispatch-refresh', description: 'Reload routing.json and the live model catalog now.', execute: async () => ctrl.refresh() },
  ];
  try {
    if (typeof ctx?.command?.transform === 'function') {
      Promise.resolve(ctx.command.transform((editor) => {
        for (const definition of commands) {
          try {
            editor.add(definition);
          } catch {
            /* one rejected command never costs the others */
          }
        }
      })).catch(() => {});
    }
  } catch {
    /* a host without commands still runs the hook */
  }

  let watcher = null;
  try {
    watcher = watchFn(routingPath, () => {
      void ctrl.refresh();
    });
    if (watcher && typeof watcher.unref === 'function') watcher.unref();
  } catch {
    watcher = null;
  }
  ctrl.close = () => {
    try {
      watcher?.close?.();
    } catch {
      /* an already-closed watcher is fine */
    }
  };

  return ctrl;
}

export { applySetup, previewSetup };

export default Plugin.define({
  id: 'oc-dispatch',
  async setup(ctx) {
    try {
      const ctrl = await setupDispatch(ctx);
      return () => ctrl.close();
    } catch {
      return () => {}; // setup never fails a session
    }
  },
});
