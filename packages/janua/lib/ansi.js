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
  let start = -1;
  while (index < text.length) {
    const char = text[index];
    if (char !== '\u001B') {
      index += 1;
      continue;
    }
    start = index;
    const kind = text[index + 1];
    if (kind === undefined) return start; // a lone ESC at the end
    if (kind === ']') {
      // OSC runs to BEL, ESC \, or 0x9C; anything else is still part of it.
      let at = index + 2;
      for (;;) {
        if (at >= text.length) return start;
        const inner = text[at];
        if (inner === '\u0007' || inner === '\u009C') {
          index = at + 1;
          break;
        }
        if (inner === '\u001B' && text[at + 1] === '\\') {
          index = at + 2;
          break;
        }
        at += 1;
      }
      start = -1;
      continue;
    }
    if (kind === '[') {
      let at = index + 2;
      while (at < text.length && text[at] >= '0' && text[at] <= '?') at += 1;
      while (at < text.length && text[at] >= ' ' && text[at] <= '/') at += 1;
      if (at >= text.length) return start; // parameters landed, final byte did not
      if (text[at] >= '@' && text[at] <= '~') {
        index = at + 1;
        start = -1;
        continue;
      }
      index = at + 1; // not a CSI after all: treat as a lone escape
      start = -1;
      continue;
    }
    index += 2;
    start = -1;
  }
  return start;
}
