/**
 * Boxes, banners and the status bar (spec §16.2).
 *
 * Pure: data in, rendered lines out. Nothing here touches stdout, so the
 * layout can be asserted character by character without a terminal — which
 * is the only practical way to catch an off-by-one in a box that is drawn
 * by arithmetic on display widths.
 */
import { displayWidth } from "./width.js";
import type { Palette } from "./theme.js";

/** Rounded, because square corners read as an older generation of terminal
 * program. This is the shared visual language of the current one. */
const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

/** Past this a line of prose is harder to read, not easier. */
export const MAX_BOX_WIDTH = 100;
/** Below this a box costs more columns than it earns; the caller drops to
 * a bare prompt instead (spec §16.2). */
export const MIN_BOX_WIDTH = 40;

export function boxWidth(columns: number): number {
  const usable = columns > 0 ? columns : 80;
  return Math.min(MAX_BOX_WIDTH, Math.max(MIN_BOX_WIDTH, usable - 1));
}

/** A terminal that has not reported its width yet says 0; treat that as
 * "assume a normal terminal" rather than as an absurdly narrow one, or the
 * first frame renders unboxed and every later erase is off by the rows the
 * box would have added. */
export function boxFits(columns: number): boolean {
  const usable = columns > 0 ? columns : 80;
  return usable - 1 >= MIN_BOX_WIDTH;
}

/** Pads to `width` display columns — never `String.padEnd`, which counts
 * characters and so breaks on the first CJK character. */
export function padTo(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

/**
 * A left label and a right value on one line: the action on the left, its
 * result on the right, so the eye can scan one column instead of reading
 * each line to the end (spec §16.2).
 */
export function alignRight(left: string, right: string, width: number): string {
  const gap = width - displayWidth(left) - displayWidth(right);
  return gap > 0 ? `${left}${" ".repeat(gap)}${right}` : `${left} ${right}`;
}

/** Box rows for `lines`, already styled by the caller. `width` is the total
 * outer width including both borders. */
export function box(lines: string[], width: number, palette: Palette): string[] {
  const inner = width - 2;
  const rule = HORIZONTAL.repeat(inner);
  const rendered = [palette.faint(`${TOP_LEFT}${rule}${TOP_RIGHT}`)];
  for (const line of lines) {
    rendered.push(`${palette.faint(VERTICAL)}${padTo(line, inner)}${palette.faint(VERTICAL)}`);
  }
  rendered.push(palette.faint(`${BOTTOM_LEFT}${rule}${BOTTOM_RIGHT}`));
  return rendered;
}

export function rule(width: number, palette: Palette): string {
  return palette.faint(HORIZONTAL.repeat(width));
}

export interface BannerInfo {
  model: string;
  root: string;
  session: string;
  fullAuto: boolean;
}

export function banner(info: BannerInfo, width: number, palette: Palette): string[] {
  const mode = info.fullAuto ? " · full-auto" : "";
  return box(
    [
      `  ${palette.accent("tcode")}`,
      `  ${palette.meta(`${info.model} · ${shortenPath(info.root)}${mode}`)}`,
    ],
    width,
    palette,
  );
}

/** `~` for home, and keep only the last few segments: the full path of a
 * deeply nested project pushes everything else off the line. */
export function shortenPath(target: string, home = process.env.HOME ?? ""): string {
  const withTilde = home && target.startsWith(home) ? `~${target.slice(home.length)}` : target;
  const parts = withTilde.split("/");
  return parts.length <= 4 ? withTilde : `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

export interface StatusInfo {
  model: string;
  tokens: number;
  contextWindowTokens: number;
  /** Right-hand key hints; they change with what is happening. */
  hints: string[];
}

/**
 * The always-present bottom line. It replaces the per-turn `[context …]`
 * report: something shown permanently does not need re-announcing.
 */
export function statusBar(
  info: StatusInfo,
  width: number,
  palette: Palette,
  formatTokens: (value: number) => string,
): string {
  const left = `${info.model} · ${formatTokens(info.tokens)}/${formatTokens(info.contextWindowTokens)}`;
  const right = info.hints.join(" · ");
  return palette.meta(alignRight(`  ${left}`, `${right}  `, width));
}
