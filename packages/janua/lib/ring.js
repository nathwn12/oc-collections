// Per-session output ring buffer.
//
// Offsets ("cursors") are monotonic byte offsets into the session's whole
// output stream, not indexes into the retained window: offset 0 is the first
// byte the child ever wrote, and it stays comparable forever. When the cap is
// exceeded the oldest bytes are dropped and the window's base offset advances,
// so a caller holding an old cursor is told exactly how many bytes it missed.

export class OutputRing {
  #chunks = [];
  #cap;

  constructor(capBytes) {
    this.#cap = capBytes;
    this.base = 0; // absolute offset of the first retained byte
    this.total = 0; // absolute offset one past the last byte written
  }

  get cap() {
    return this.#cap;
  }

  /** Bytes currently retained (<= cap). */
  get available() {
    return this.total - this.base;
  }

  append(text) {
    if (!text || (typeof text === 'string' && text.length === 0)) return;
    // A string can only encode whole characters, but a Buffer is raw bytes and
    // may end inside one (a caller holding a partial write); both append into
    // the same byte stream so the tail checks below stay meaningful.
    const chunk = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.total += chunk.length;

    let over = this.total - this.base - this.#cap;
    while (over > 0 && this.#chunks.length > 0) {
      const head = this.#chunks[0];
      if (head.length <= over) {
        this.#chunks.shift();
        this.base += head.length;
        over -= head.length;
        continue;
      }
      this.#chunks[0] = head.subarray(over);
      this.base += over;
      over = 0;
    }
  }

  /**
   * Read up to `maxBytes` starting at absolute offset `cursor`.
   * Returns the bytes clamped into the retained window, the absolute offset
   * they end at, and how many bytes between the requested cursor and the
   * retained window were dropped before the caller could read them.
   *
   * `atEnd` says the child has exited, so no byte can arrive after `total`:
   * a character cut by the end of the stream is flushed then instead of being
   * held. On a live stream the tail cut is held back, because ending the slice
   * inside a character decodes it as U+FFFD and moves the cursor into that
   * character, so the remainder decodes as garbage too.
   *
   * `incomplete` (live) means `end` stops before a character whose remaining
   * bytes have not arrived; a repeat from `end` must wait for them. `truncated`
   * (exited) means the stream itself ended inside a character, whose bytes are
   * returned decoded (U+FFFD).
   */
  read(cursor, maxBytes, options = {}) {
    const wanted = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : this.base;
    const clamped = Math.min(wanted, this.total);
    const from = Math.max(clamped, this.base);
    const dropped = from - clamped;
    const limit = Math.min(this.total, from + Math.max(0, Math.floor(maxBytes)));
    const boundary = this.#characterBoundary(from, limit, options.atEnd === true);
    return {
      data: this.#slice(from, boundary.end),
      dropped,
      start: from,
      end: boundary.end,
      incomplete: boundary.incomplete,
      truncated: boundary.truncated,
    };
  }

  /**
   * End of the last whole UTF-8 character in [from, limit), widened to one
   * whole character, with whether the tail was held or flushed.
   */
  #characterBoundary(from, limit, atEnd) {
    if (limit <= from) return { end: limit, incomplete: false, truncated: false };
    // Walk back over continuation bytes (0x80..0xBF) to the lead byte of the
    // character that `limit` lands inside.
    let stop = limit - 1;
    while (stop > this.base && (this.#byteAt(stop) & 0xc0) === 0x80) stop -= 1;
    const lead = this.#byteAt(stop);
    if ((lead & 0xc0) === 0x80) {
      // The window base itself cuts a character, so its start is not retained.
      return { end: limit, incomplete: false, truncated: false };
    }
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1;
    const characterEnd = stop + width;
    if (characterEnd <= limit) {
      return { end: limit, incomplete: false, truncated: false }; // already on a boundary
    }
    if (characterEnd <= this.total) {
      // The rest of the character is already buffered: widen to it rather than
      // nothing, so maxBytes: 1 still makes progress.
      return { end: characterEnd, incomplete: false, truncated: false };
    }
    // The stream itself ends inside this character. A live stream holds the
    // cursor before it and returns only the complete prefix; after exit the
    // fragment is flushed (decoding as U+FFFD) and marked truncated.
    if (atEnd) return { end: this.total, incomplete: false, truncated: true };
    return { end: Math.max(from, stop), incomplete: true, truncated: false };
  }

  #byteAt(offset) {
    let at = this.base;
    for (const chunk of this.#chunks) {
      if (offset < at + chunk.length) return chunk[offset - at];
      at += chunk.length;
    }
    return 0;
  }

  #slice(start, end) {
    if (end <= start) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(end - start);
    let offset = this.base;
    let written = 0;
    for (const chunk of this.#chunks) {
      const chunkStart = offset;
      const chunkEnd = offset + chunk.length;
      offset = chunkEnd;
      if (chunkEnd <= start) continue;
      if (chunkStart >= end) break;
      const from = Math.max(start, chunkStart) - chunkStart;
      const to = Math.min(end, chunkEnd) - chunkStart;
      chunk.copy(out, written, from, to);
      written += to - from;
    }
    return out.subarray(0, written);
  }
}
