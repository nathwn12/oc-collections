/**
 * oc-terminal - preload.
 *
 * Node:  node --import file:///.../preload.mjs <script>
 * Bun:   bun --preload .../preload.mjs <script>
 *
 * The preload runs before the entrypoint's own imports, so the entrypoint's
 * `spawn` binding is already the hidden wrapper. That is what covers an MCP
 * server or a launcher that was not edited to pass `windowsHide` itself.
 *
 * A preload must never stop the process it guards: install() is written not to
 * throw, and this catch is the second line.
 */
import { install } from './lib.js';

try {
  install();
} catch {
  /* a guard that fails is reported by terminal_status, never fatal */
}
