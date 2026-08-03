/**
 * Single-keypress choice overlay (spec §16.6).
 *
 * The approval prompt used to be one line ending in `[Y/n]`, answered by
 * typing a letter and pressing Enter. Four actions for a binary decision,
 * and the dangerous command itself was buried mid-sentence with no visual
 * weight of its own — the one thing that most needed reading.
 *
 * Same shape as the editor: it owns state and rendering, never the
 * terminal. `live-input.ts` draws whatever is returned, so an overlay and
 * the input box occupy the same region and share one erase/redraw path.
 */
import { alignRight, box, boxFits, boxWidth, padTo } from "./chrome.js";
import { displayWidth } from "./width.js";
import type { Key, RenderedInput } from "./editor.js";
import type { Palette } from "./theme.js";

export interface SelectOption<T> {
  label: string;
  value: T;
  /** Single-key shortcut, kept because the muscle memory already exists. */
  shortcut?: string;
}

export interface SelectOptions<T> {
  title: string;
  /** Shown above the choices, emphasised — the command, the path, the
   * thing the decision is actually about. */
  subject?: string;
  /** Why this is being asked. */
  detail?: string;
  options: SelectOption<T>[];
  palette: Palette;
  columns(): number;
  /** Returned by Esc, and by EOF. Refusing is always the safe default. */
  cancelValue: T;
}

export type SelectAction<T> = { type: "none" } | { type: "chosen"; value: T };

export function createSelect<T>(config: SelectOptions<T>) {
  const { palette } = config;
  let index = 0;

  return {
    get selectedIndex() {
      return index;
    },

    handleKey(char: string | undefined, key: Key): SelectAction<T> {
      const name = key.name ?? "";

      if (name === "escape" || (key.ctrl && name === "c")) {
        return { type: "chosen", value: config.cancelValue };
      }
      if (key.ctrl && name === "d") {
        return { type: "chosen", value: config.cancelValue };
      }
      if (name === "up" || (key.ctrl && name === "p")) {
        index = (index - 1 + config.options.length) % config.options.length;
        return { type: "none" };
      }
      if (name === "down" || (key.ctrl && name === "n")) {
        index = (index + 1) % config.options.length;
        return { type: "none" };
      }
      if (name === "return" || name === "enter") {
        return { type: "chosen", value: config.options[index].value };
      }

      const typed = (char ?? "").toLowerCase();
      if (typed) {
        // Number keys pick by position; letters match a declared shortcut.
        const byNumber = Number(typed);
        if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= config.options.length) {
          return { type: "chosen", value: config.options[byNumber - 1].value };
        }
        const match = config.options.find((option) => option.shortcut === typed);
        if (match) return { type: "chosen", value: match.value };
      }

      return { type: "none" };
    },

    render(): RenderedInput {
      const columns = config.columns();

      if (!boxFits(columns)) {
        const labels = config.options
          .map((option, at) => (at === index ? palette.accent(`❯ ${option.label}`) : `  ${option.label}`))
          .join("  ");
        return { lines: [config.title, labels], cursorRow: 1, cursorCol: 0 };
      }

      const width = boxWidth(columns);
      const inner = width - 2;
      const content: string[] = [""];

      if (config.subject) content.push(`  ${palette.strong(config.subject)}`);
      if (config.detail) content.push(`  ${palette.meta(config.detail)}`);
      if (config.subject || config.detail) content.push("");

      for (const [at, option] of config.options.entries()) {
        content.push(
          at === index
            ? `  ${palette.accent("❯")} ${palette.accent(option.label)}`
            : `    ${palette.meta(option.label)}`,
        );
      }
      content.push("");

      const lines = box(content, width, palette);
      // The title rides on the top border and the hints on the bottom one,
      // so neither costs a row of its own.
      lines[0] = inlineOnRule(lines[0], ` ${config.title} `, 2, palette);
      lines[lines.length - 1] = inlineOnRule(
        lines[lines.length - 1],
        " ↑↓ choose · ⏎ confirm · esc no ",
        Math.max(2, inner - displayWidth(" ↑↓ choose · ⏎ confirm · esc no ") - 1),
        palette,
      );

      // No text cursor in a menu; park it on the selected row so a screen
      // reader and the terminal's own focus agree with the highlight.
      return { lines, cursorRow: 0, cursorCol: 0 };
    },
  };
}

/** Overwrites part of a border row with a label, keeping the row's width. */
function inlineOnRule(row: string, label: string, at: number, palette: Palette): string {
  const plain = stripStyles(row);
  const before = plain.slice(0, at);
  const after = plain.slice(at + displayWidth(label));
  return `${palette.faint(before)}${palette.meta(label)}${palette.faint(after)}`;
}

const STYLE = /\u001b\[[0-9;]*m/g;
function stripStyles(text: string): string {
  return text.replace(STYLE, "");
}

export { padTo, alignRight };
