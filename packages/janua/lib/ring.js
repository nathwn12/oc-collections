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
    if (!text) return;
    const chunk = Buffer.from(text, 'utf8');
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
   */
  read(cursor, maxBytes) {
    const wanted = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : this.base;
    const clamped = Math.min(wanted, this.total);
    const from = Math.max(clamped, this.base);
    const dropped = from - clamped;
    const end = Math.min(this.total, from + Math.max(0, Math.floor(maxBytes)));
    return { data: this.#slice(from, end), dropped, end };
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
