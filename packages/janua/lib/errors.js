// Typed errors and their MCP tool-result shapes.
//
// Nothing in this package throws across the MCP boundary. A handler either
// returns a success payload or one of these typed failures, and the server
// wrapper turns every throw into one as well.

export const ERROR_CODES = Object.freeze({
  INVALID_ARGS: 'invalid_args',
  SESSION_NOT_FOUND: 'session_not_found',
  SPAWN_FAILED: 'spawn_failed',
  PTY_WRITE_FAILED: 'pty_write_failed',
  PTY_RESIZE_FAILED: 'pty_resize_failed',
  TOO_MANY_SESSIONS: 'too_many_sessions',
  PTY_KILL_FAILED: 'pty_kill_failed',
  // Anything unexpected. Never used for a condition the codes above cover.
  INTERNAL: 'internal_error',
});

export class JanuaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JanuaError';
    this.code = code;
  }
}

export function invalidArgs(message) {
  return new JanuaError(ERROR_CODES.INVALID_ARGS, message);
}

export function sessionNotFound(sessionId) {
  return new JanuaError(ERROR_CODES.SESSION_NOT_FOUND, `no session with id "${sessionId}"`);
}

export function describeCause(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

/** Success result: the payload as JSON text for the model, and structured for clients. */
export function toolSuccess(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** Failure result: a typed code, a readable message, and isError so clients surface it.
 *
 * Deliberately no structuredContent: a tool that declares an outputSchema has
 * its structuredContent validated against it even when isError is set, so an
 * {error} envelope there would turn a typed tool failure into a thrown
 * protocol error. The code stays in the text payload, which is never validated.
 */
export function toolFailure(err) {
  const code = err instanceof JanuaError ? err.code : ERROR_CODES.INTERNAL;
  const message = err instanceof JanuaError
    ? err.message
    : `unexpected failure: ${describeCause(err)}`;
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
  };
}
