// Read-only projection of board rows: filter + limit/cursor pagination.
// Pure, so the tool and the tests judge exactly the same rule. The returned
// `rows` keep the five contract fields; lease metadata is never projected.
import { BOARD_STATES } from './board.mjs';

export const VIEW_MAX_LIMIT = 100;

export function viewBoard(rows, opts = {}) {
  const o = opts || {};
  let list = Array.isArray(rows) ? rows.slice() : [];
  if (o.state !== undefined) {
    if (!BOARD_STATES.includes(o.state)) {
      return { error: 'bad_request', reason: 'state must be one of ' + BOARD_STATES.join(', ') };
    }
    list = list.filter((row) => row.state === o.state);
  }
  if (o.seam !== undefined) list = list.filter((row) => row.seam === String(o.seam));
  if (o.session !== undefined) list = list.filter((row) => row.session === String(o.session));

  let offset = 0;
  if (o.cursor !== undefined && o.cursor !== null && o.cursor !== '') {
    offset = Number(o.cursor);
    if (!Number.isInteger(offset) || offset < 0) {
      return { error: 'bad_request', reason: 'cursor must be a non-negative integer offset' };
    }
  }
  let limit = null;
  if (o.limit !== undefined && o.limit !== null && o.limit !== '') {
    limit = Number(o.limit);
    if (!Number.isInteger(limit) || limit < 0) {
      return { error: 'bad_request', reason: 'limit must be a non-negative integer' };
    }
    limit = Math.min(limit, VIEW_MAX_LIMIT);
  }

  const page = limit === null ? list.slice(offset) : list.slice(offset, offset + limit);
  const cursor = {};
  if (offset > 0) cursor.previous = String(Math.max(0, offset - (limit === null ? Math.max(1, page.length) : limit)));
  if (limit !== null && offset + page.length < list.length) cursor.next = String(offset + page.length);
  return { rows: page, total: list.length, cursor };
}
