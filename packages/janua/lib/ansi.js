// ANSI escape stripping.
//
// Two passes, because a Windows ConPTY emits both kinds and the naive
// ansi-regex pattern cuts an OSC title short at the first backslash (a path
// like C:\Users\...), leaving the rest of the title in the output:
//   1. OSC: ESC ] ... BEL | ESC \ | 0x9C  (window titles, hyperlinks)
//   2. every other escape: CSI, and single-character two-byte sequences.
// Stripping happens per read, so a sequence split across two reads is left in
// place until the rest of it arrives.
const OSC_PATTERN = /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const ESCAPE_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

export function stripAnsi(text) {
  return text.replace(OSC_PATTERN, '').replace(ESCAPE_PATTERN, '');
}

/**
 * Index one past the escape sequence that starts at `start`, or -1 when the
 * sequence has not finished inside `text`.
 *
 * The reader needs the end, not just the fact of an unfinished tail: it widens
 * a read window only as far as the one straddling sequence needs, and cuts the
 * reply exactly there.
 */
export function escapeSequenceEnd(text, start) {
  if (text[start] !== '\u001B') return -1;
  const kind = text[start + 1];
  if (kind === undefined) return -1; // a lone ESC at the end
  if (kind === ']') {
    // OSC runs to BEL, ESC \, or 0x9C; anything else is still part of it.
    let at = start + 2;
    for (;;) {
      if (at >= text.length) return -1;
      const inner = text[at];
      if (inner === '\u0007' || inner === '\u009C') return at + 1;
      if (inner === '\u001B' && text[at + 1] === '\\') return at + 2;
      at += 1;
    }
  }
  if (kind === '[') {
    let at = start + 2;
    while (at < text.length && text[at] >= '0' && text[at] <= '?') at += 1;
    while (at < text.length && text[at] >= ' ' && text[at] <= '/') at += 1;
    if (at >= text.length) return -1; // parameters landed, final byte did not
    // A final byte ends the CSI; anything else means this was not a CSI, and
    // the scan treats it as a lone escape, exactly as before.
    return at + 1;
  }
  return start + 2;
}

/**
 * Index where a trailing escape sequence that has not finished yet begins, or
 * -1 when the text ends on a clean boundary.
 *
 * Stripping happens per read, and a read can end in the middle of a sequence
 * (`ESC [` with the `31m` still in flight). Returning that head as data leaks a
 * raw fragment into the text and, worse, makes the rest of the sequence arrive
 * as literal characters on the next read. A caller that holds the cursor at
 * this index re-reads the sequence whole once its tail lands.
 */
export function incompleteEscapeStart(text) {
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '\u001B') {
      index += 1;
      continue;
    }
    const end = escapeSequenceEnd(text, index);
    if (end === -1) return index;
    index = end;
  }
  return -1;
}
