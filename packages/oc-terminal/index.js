/**
 * oc-terminal - the plugin half: install the spawn guard once per host
 * process, then report it through `terminal_status`.
 *
 * Setup never throws. A host that refuses the tool editor keeps the guard; a
 * host that refuses the guard keeps its own behaviour, and the status says so.
 */
import { install, resolveRuntime, visibleAllowed } from './lib.js';

export default {
  id: 'oc-terminal',

  setup(ctx) {
    let state;
    try {
      state = install();
    } catch (error) {
      state = { patched: false, reason: `install failed: ${error?.message || error}` };
    }

    try {
      if (typeof ctx?.tool?.transform !== 'function') return;
      Promise.resolve(
        ctx.tool.transform((editor) => {
          try {
            if (typeof editor.namespace === 'function') {
              editor.namespace({
                name: 'terminal',
                description: 'Windows spawn guard: hidden consoles, real JavaScript runtimes.',
              });
            }
          } catch {
            /* the namespace is cosmetic; the guard is installed */
          }
          try {
            editor.add({
              name: 'terminal_status',
              description:
                'Whether the Windows spawn guard is installed in this host process, and the real JavaScript runtime it would use. A false patched means only explicitly hidden spawns are safe.',
              input: { type: 'object', properties: {}, additionalProperties: false },
              options: { namespace: 'terminal', codemode: true },
              execute: async () => ({
                content: JSON.stringify({
                  ...state,
                  windows: process.platform === 'win32',
                  runtime: resolveRuntime(),
                  allowVisible: visibleAllowed(),
                }),
              }),
            });
          } catch {
            /* a host without the tool editor keeps the guard */
          }
        }),
      ).catch(() => {});
    } catch {
      /* the guard is what matters; the status tool is a nicety */
    }
  },
};
