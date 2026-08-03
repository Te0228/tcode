/**
 * Terminal display geometry (spec §3.2).
 *
 * The live input line has to erase exactly the rows it drew last time.
 * Counting those rows by string length is wrong the moment a CJK character
 * appears — it occupies two columns — and this tool's user types Chinese.
 * An undercount leaves stale rows on screen; an overcount erases real
 * output that had already scrolled into place.
 *
 * The algorithm deliberately mirrors readline's own internal
 * `kGetDisplayPos`, because readline draws the input block and we draw
 * everything above it: two different wrap models would desynchronize on
 * the first wide character.
 */
import { stripVTControlCharacters } from "node:util";

/** Code points that take two columns. Mirrors Node's
 * `isFullWidthCodePoint`. */
function isFullWidth(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f || // Hangul Jamo
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
      (code >= 0x3250 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4c6) || // CJK unified ideographs
      (code >= 0xa960 && code <= 0xa97c) ||
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6b) ||
      (code >= 0xff01 && code <= 0xff60) || // fullwidth forms
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1b000 && code <= 0x1b001) ||
      (code >= 0x1f200 && code <= 0x1f251) ||
      (code >= 0x1f300 && code <= 0x1f64f) || // emoji
      (code >= 0x20000 && code <= 0x3fffd))
  );
}

/** Code points that take no columns at all. Mirrors Node's
 * `isZeroWidthCodePoint`. */
function isZeroWidth(code: number): boolean {
  return (
    code <= 0x1f || // C0 control
    (code >= 0x7f && code <= 0x9f) || // C1 control
    (code >= 0x300 && code <= 0x36f) || // combining marks
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

/** Columns occupied by a single character (a full code point, so
 * astral-plane emoji count once, not twice). */
export function charWidth(char: string): number {
  const code = char.codePointAt(0);
  if (code === undefined || isZeroWidth(code)) return 0;
  return isFullWidth(code) ? 2 : 1;
}

/** Columns occupied by a string on one infinitely wide row. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) width += charWidth(char);
  return width;
}

export interface DisplayPos {
  /** Rows below the starting row where the cursor ends up. */
  rows: number;
  /** Column within that row. */
  cols: number;
}

/**
 * Where the cursor lands after writing `text` starting at column 0 of a
 * terminal `columns` wide.
 *
 * Note the wide-character rule: a two-column character never straddles
 * the right edge, so it skips the last column and wraps whole. Dropping
 * that detail shifts every subsequent row by one on lines of Chinese.
 */
export function displayPos(text: string, columns: number, tabSize = 8): DisplayPos {
  const width = columns > 0 ? columns : 80;
  let offset = 0;
  let rows = 0;

  for (const char of stripVTControlCharacters(text)) {
    if (char === "\n") {
      // A newline always consumes at least one row, even at column 0.
      rows += Math.ceil(offset / width) || 1;
      offset = 0;
      continue;
    }
    if (char === "\t") {
      offset += tabSize - (offset % tabSize);
      continue;
    }
    const charCols = charWidth(char);
    if (charCols === 2 && (offset + 1) % width === 0) offset++;
    offset += charCols;
  }

  const cols = offset % width;
  return { rows: rows + (offset - cols) / width, cols };
}

/**
 * The substring occupying display columns `[from, from + width)`.
 *
 * Needed because a single-line input has to scroll horizontally: text that
 * overflows its box wraps in the terminal, the row silently becomes two,
 * and every erase after that is short by one row (spec §16.2).
 */
export function sliceByWidth(text: string, from: number, width: number): string {
  let column = 0;
  let out = "";
  for (const char of text) {
    const size = charWidth(char);
    if (column >= from && column + size <= from + width) out += char;
    column += size;
    if (column >= from + width) break;
  }
  return out;
}
