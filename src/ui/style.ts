/**
 * Colour capability detection and the semantic palette (spec §14).
 *
 * Two rules shape this file:
 *
 * 1. **When colour is off, every helper is the identity function.** Callers
 *    never write `if (color)`. That branch would eventually be forgotten
 *    somewhere, and a forgotten branch leaks escape sequences into a pipe —
 *    exactly what spec §14.3 forbids.
 * 2. **Only the 16 base ANSI colours.** They are whatever the user's
 *    terminal theme says they are, so the output matches their setup
 *    instead of fighting it, and nothing degrades over SSH, in tmux, or in
 *    a CI log the way truecolor does.
 */

/** Named roles, not colours. The same kind of information always gets the
 * same treatment; nothing is restyled because a line "looks plain". */
export interface Palette {
  /** Echo of what the user typed. */
  userInput(text: string): string;
  /** A tool about to run: the symbol, not its arguments. */
  toolCall(text: string): string;
  /** Output of a tool, shown indented under the call. */
  toolResult(text: string): string;
  /** Failures: thrown tools, non-zero exits, declined approvals. */
  error(text: string): string;
  /** Completion, and added lines in a diff. */
  success(text: string): string;
  /** Interruption and other "you should look at this" states. */
  warn(text: string): string;
  /** Context counters, hints, queue notices — present but never competing. */
  meta(text: string): string;
  /** Removed lines in a diff. */
  removed(text: string): string;
  /** Emphasis inside otherwise plain text (markdown bold, headings). */
  strong(text: string): string;
  /** Inline code and code blocks. */
  code(text: string): string;
}

const identity = (text: string): string => text;

/** All roles disabled — the exported shape stays identical so no caller
 * needs to know. */
export const NO_COLOR_PALETTE: Palette = {
  userInput: identity,
  toolCall: identity,
  toolResult: identity,
  error: identity,
  success: identity,
  warn: identity,
  meta: identity,
  removed: identity,
  strong: identity,
  code: identity,
};

/** `open`/`close` are SGR parameter numbers. Closing with the attribute's
 * own reset (39 for foreground, 22 for bold/dim) rather than a blanket 0
 * keeps nesting from cancelling the outer style. */
function sgr(open: number, close: number): (text: string) => string {
  const prefix = `[${open}m`;
  const suffix = `[${close}m`;
  return (text: string) => `${prefix}${text}${suffix}`;
}

const bold = sgr(1, 22);
const dim = sgr(2, 22);
const red = sgr(31, 39);
const green = sgr(32, 39);
const yellow = sgr(33, 39);
const cyan = sgr(36, 39);

export const COLOR_PALETTE: Palette = {
  userInput: bold,
  toolCall: cyan,
  toolResult: dim,
  error: red,
  success: green,
  warn: yellow,
  meta: dim,
  removed: red,
  strong: bold,
  code: cyan,
};

export interface ColorOptions {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * Whether to emit colour at all (spec §14.3).
 *
 * `FORCE_COLOR` is checked first and wins: it is the only way to ask for
 * colour when stdout is not a terminal, which is the whole reason someone
 * sets it (a CI log viewer that renders ANSI). `NO_COLOR` follows its
 * convention — present and non-empty disables, whatever the value.
 */
export function colorEnabled({ isTTY, env }: ColorOptions): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0" && force !== "false";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return isTTY;
}

export function createPalette(options: ColorOptions): Palette {
  return colorEnabled(options) ? COLOR_PALETTE : NO_COLOR_PALETTE;
}
