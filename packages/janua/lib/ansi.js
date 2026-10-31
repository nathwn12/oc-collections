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
