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
  /** Brand elements only — box rules, the prompt glyph, the logo. */
  accent(text: string): string;
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

/** The one brand colour: a violet that stays legible on both light and
 * dark backgrounds, which a saturated blue or yellow does not. */
const ACCENT: [number, number, number] = [147, 112, 245];

export const TRUE_COLOR_PALETTE: Palette = {
  accent: rgb(...ACCENT),
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
