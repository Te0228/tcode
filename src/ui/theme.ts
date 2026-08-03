/**
 * Colour capability and the palette (spec §16.3).
 *
 * §14.3 chose 16 colours so output would follow the user's terminal theme.
 * For a demo the requirement inverts: the screen has to look the same on
 * someone else's machine, and with 16 colours their theme decides what
 * "cyan" is. So there is one fixed accent, full colour where the terminal
 * supports it, and a 16-colour fallback for SSH and CI.
 *
 * Semantic colours (error red, added green) are not part of the brand and
 * do not change with it. One accent only: more of them reads as cheap, not
 * modern.
 */

export type ColorLevel = "none" | "basic" | "true";

export interface ColorOptions {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * `FORCE_COLOR` wins — it is the only way to ask for colour without a
 * terminal, which is the reason anyone sets it. `NO_COLOR` follows its
 * convention: present and non-empty disables, whatever the value.
 */
export function colorLevel({ isTTY, env }: ColorOptions): ColorLevel {
  const force = env.FORCE_COLOR;
  const forced = force !== undefined && force !== "" && force !== "0" && force !== "false";

  if (!forced) {
    if (force !== undefined && force !== "") return "none";
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
    if (env.TERM === "dumb") return "none";
    if (!isTTY) return "none";
  }

  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "true";
  if ((env.TERM ?? "").includes("256color")) return "true";
  return "basic";
}

export function colorEnabled(options: ColorOptions): boolean {
  return colorLevel(options) !== "none";
}

/** Named roles, not colours: the same kind of information always gets the
 * same treatment. */
export interface Palette {
  /** Brand: the rail, the prompt glyph, the logo, turn headings. */
  accent(text: string): string;
  /** Interaction: the selected item, actionable elements, code. A single
   * accent is the main reason a screen reads as flat — one colour gives no
   * contrast. Two with fixed jobs give contrast without noise (spec §17.2). */
  accent2(text: string): string;
  /** Full-row tints (spec §17.3). Only meaningful in truecolor: a 16-colour
   * background is a flat block that collides with the user's own theme, so
   * it degrades to the foreground-only treatment. */
  addedRow(text: string): string;
  removedRow(text: string): string;
  statusRow(text: string): string;
  selectedRow(text: string): string;
  /** True when row tints are real, so callers know whether padding a row to
   * full width buys anything. */
  readonly tinted: boolean;
  userInput(text: string): string;
  toolCall(text: string): string;
  toolResult(text: string): string;
  error(text: string): string;
  success(text: string): string;
  warn(text: string): string;
  /** Secondary information: counters, hints, right-hand metadata. */
  meta(text: string): string;
  /** The faintest tier — box rules, separators. Three tiers is the limit;
   * past that the eye cannot tell them apart and it is just noise. */
  faint(text: string): string;
  removed(text: string): string;
  strong(text: string): string;
  code(text: string): string;
}

const identity = (text: string): string => text;

export const NO_COLOR_PALETTE: Palette = {
  accent: identity,
  accent2: identity,
  addedRow: identity,
  removedRow: identity,
  statusRow: identity,
  selectedRow: identity,
  tinted: false,
  userInput: identity,
  toolCall: identity,
  toolResult: identity,
  error: identity,
  success: identity,
  warn: identity,
  meta: identity,
  faint: identity,
  removed: identity,
  strong: identity,
  code: identity,
};

/** Closing with the attribute's own reset (39 for foreground, 22 for
 * bold/dim) rather than a blanket 0, so nesting does not cancel the
 * enclosing style. */
function sgr(open: string, close: number): (text: string) => string {
  return (text: string) => `\u001b[${open}m${text}\u001b[${close}m`;
}

const rgb = (r: number, g: number, b: number) => sgr(`38;2;${r};${g};${b}`, 39);
const onRgb = (r: number, g: number, b: number) => sgr(`48;2;${r};${g};${b}`, 49);

/** Brand violet: legible on both light and dark backgrounds, which a
 * saturated blue or yellow is not. */
const ACCENT: [number, number, number] = [147, 112, 245];
/** Interaction cyan. Far enough from the violet in hue to read as a
 * different role rather than a shade of the same one. */
const ACCENT2: [number, number, number] = [86, 191, 214];

export const TRUE_COLOR_PALETTE: Palette = {
  accent: rgb(...ACCENT),
  accent2: rgb(...ACCENT2),
  // Dark, desaturated tints: a full row of saturated colour is unreadable
  // and shouts. These read as "this row is different", not as a highlight.
  addedRow: onRgb(22, 48, 30),
  removedRow: onRgb(58, 26, 30),
  statusRow: onRgb(38, 36, 48),
  selectedRow: onRgb(48, 40, 72),
  tinted: true,
  userInput: sgr("1", 22),
  toolCall: rgb(...ACCENT),
  toolResult: rgb(150, 150, 158),
  error: rgb(240, 100, 100),
  success: rgb(110, 200, 130),
  warn: rgb(230, 180, 90),
  meta: rgb(130, 130, 140),
  faint: rgb(90, 90, 100),
  removed: rgb(240, 100, 100),
  strong: sgr("1", 22),
  code: rgb(120, 200, 220),
};

export const BASIC_PALETTE: Palette = {
  accent: sgr("35", 39),
  accent2: sgr("36", 39),
  // No row tints at 16 colours (spec §17.1): a flat colour block collides
  // with whatever the user's theme made of it.
  addedRow: identity,
  removedRow: identity,
  statusRow: sgr("7", 27),
  selectedRow: sgr("7", 27),
  tinted: false,
  userInput: sgr("1", 22),
  toolCall: sgr("36", 39),
  toolResult: sgr("2", 22),
  error: sgr("31", 39),
  success: sgr("32", 39),
  warn: sgr("33", 39),
  meta: sgr("2", 22),
  faint: sgr("2", 22),
  removed: sgr("31", 39),
  strong: sgr("1", 22),
  code: sgr("36", 39),
};

export function createPalette(options: ColorOptions): Palette {
  switch (colorLevel(options)) {
    case "true":
      return TRUE_COLOR_PALETTE;
    case "basic":
      return BASIC_PALETTE;
    default:
      return NO_COLOR_PALETTE;
  }
}
