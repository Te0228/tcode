/**
 * The transcript renderer (spec §17.6).
 *
 * Everything about how a turn *looks* lives here: the rail, the gutter
 * width, markdown, syntax highlighting, the right-hand outcome column, the
 * row tints. `agent.ts` reports what happened and knows none of it.
 *
 * The split matters beyond tidiness. While layout was spread across the
 * loop, every new rule had to be threaded through each call site, and one
 * path always got missed — the streamed half-line kept escaping the rail
 * and colliding with tool output. With one renderer there is nowhere for a
 * line to come from that has not been through it.
 */
import type { TurnEvent } from "../agent.js";
import { summaryLineOf } from "../agent.js";
import type { DisplayLine } from "../tools/types.js";
import { GUTTER_WIDTH, alignRight, rail, tintedRow } from "./chrome.js";
import {
  DEFAULT_MAX_RESULT_LINES,
  createMarkdownRenderer,
  formatToolCall,
} from "./format.js";
import { highlight } from "./highlight.js";
import type { Palette } from "./theme.js";
import { displayWidth, sliceByWidth } from "./width.js";

export interface TranscriptOptions {
  palette: Palette;
  colored: boolean;
  /** Full layout width, including the gutter. */
  width(): number;
  /** Emits finished lines above the input region. */
  write(text: string): void;
  /** Replaces the not-yet-finished line, for streaming text (spec §14.4). */
  rewritePending(text: string): void;
  /** Off for a pipe: markdown rendering would strip `**` and backticks and
   * put nothing in their place, quietly editing the model's words. */
  renderMarkdown: boolean;
}

/** Splits a diff row into gutter and code so the line number does not pick
 * up keyword colours. */
const DIFF_ROW = /^(\s*\d*\s[-+ ]\s)([\s\S]*)$/;

export function createTranscript(options: TranscriptOptions) {
  const { palette, colored } = options;
  const markdown = createMarkdownRenderer(palette);
  /** Streamed text since the last newline. */
  let buffer = "";

  const body = () => rail("body", palette, colored);
  const contentWidth = () => Math.max(10, options.width() - GUTTER_WIDTH);

  /**
   * One logical line, wrapped to the content width with the rail repeated
   * on every row. Letting the terminal wrap instead loses the rail on the
   * continuation rows, and the block stops reading as one turn.
   */
  const line = (text: string) => {
    const rows = wrapToWidth(text, contentWidth());
    for (const row of rows) options.write(`${body()}${row}\n`);
  };
  const bare = (text: string) => options.write(`${text}\n`);

  /** Streamed text has no newline of its own; anything else printed while
   * it is open has to close it first, or the two share a row. */
  const closeText = () => {
    if (!buffer) return;
    options.rewritePending("");
    line(options.renderMarkdown ? markdown.render(buffer) : buffer);
    buffer = "";
  };

  const toneStyle = (tone: DisplayLine["tone"]) => {
    switch (tone) {
      case "added":
        return palette.success;
      case "removed":
        return palette.removed;
      case "error":
        return palette.error;
      case "muted":
        return palette.meta;
      default:
        return palette.toolResult;
    }
  };

  const resultLine = (entry: DisplayLine): string => {
    const style = toneStyle(entry.tone);
    const code = entry.code && entry.code !== "none" ? entry.code : undefined;
    const split = code ? DIFF_ROW.exec(entry.text) : null;
    const rendered = split
      ? `${style(split[1])}${highlight(split[2], code!, palette)}`
      : style(code ? highlight(entry.text, code, palette) : entry.text);

    // A full-row tint is what makes a diff read like an editor instead of a
    // log (spec §17.1); it needs the row padded to the exact content width,
    // or the fill wraps and the whole block shifts.
    const indented = `  ${rendered}`;
    if (!palette.tinted) return indented;
    if (entry.tone === "added") return tintedRow(indented, contentWidth(), palette.addedRow);
    if (entry.tone === "removed") return tintedRow(indented, contentWidth(), palette.removedRow);
    return indented;
  };

  return {
    /** A turn heading, drawn outside the rail. */
    heading(text: string) {
      closeText();
      bare(text);
    },

    blank() {
      closeText();
      options.write("\n");
    },

    /** A line the REPL itself wants inside the current turn. */
    note(text: string) {
      closeText();
      line(text);
    },

    /**
     * The closing line of a turn. The detail rides on the last row when it
     * fits; a summary long enough to fill the row gets it on its own,
     * rather than pushing the row past the width and wrapping it.
     */
    outcome(text: string, detail: string) {
      closeText();
      const width = contentWidth();
      const rows = wrapToWidth(text, width - displayWidth(detail) - 2);
      const last = rows.pop() ?? "";
      for (const row of rows) options.write(`${body()}${row}\n`);
      options.write(`${body()}${alignRight(last, palette.meta(detail), width)}\n`);
    },

    event(event: TurnEvent) {
      switch (event.type) {
        case "text": {
          buffer += event.chunk;
          let at = buffer.indexOf("\n");
          while (at >= 0) {
            const finished = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            options.rewritePending("");
            line(options.renderMarkdown ? markdown.render(finished) : finished);
            at = buffer.indexOf("\n");
          }
          // The partial line streams immediately (spec §3.2 wins over
          // §14.4 P3) and hangs off the rail like everything else.
          options.rewritePending(buffer ? `${body()}${buffer}` : "");
          return;
        }

        case "tool_start":
          closeText();
          line(formatToolCall(summaryLineOf(event.toolUse), palette, "", contentWidth()));
          return;

        case "tool_end": {
          closeText();
          // `finish` gets no line of its own: the turn's closing line
          // already carries its summary, and printing both says it twice.
          if (event.toolUse.name === "finish") return;
          const meta = event.failed ? palette.error(event.meta) : event.meta;
          line(formatToolCall(summaryLineOf(event.toolUse), palette, meta, contentWidth()));
          const shown = event.display.slice(0, DEFAULT_MAX_RESULT_LINES);
          for (const entry of shown) line(resultLine(entry));
          const hidden = event.display.length - shown.length;
          if (hidden > 0) {
            line(palette.meta(`  … +${hidden} more line${hidden === 1 ? "" : "s"}`));
          }
          return;
        }

        case "steering":
          closeText();
          line(palette.accent2(`↳ ${event.message}`));
          return;

        case "notice": {
          closeText();
          const style =
            event.level === "error"
              ? palette.error
              : event.level === "warn"
                ? palette.warn
                : palette.meta;
          line(style(event.text));
          return;
        }
      }
    },
  };
}

export type Transcript = ReturnType<typeof createTranscript>;

/** Re-exported so the REPL does not need `width.ts` just to measure a
 * heading it is about to right-align. */
export { displayWidth };

/**
 * Wraps to `width` display columns, breaking at spaces when there is one
 * and mid-word when there is not. Styling is measured at zero width, so a
 * coloured line wraps by what it prints rather than by how many bytes it
 * carries.
 */
export function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0 || displayWidth(text) <= width) return [text];

  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;
  // Split on spaces but keep them, so the break point is a real word edge.
  for (const token of text.split(/(\s+)/)) {
    const tokenWidth = displayWidth(token);
    if (rowWidth + tokenWidth <= width) {
      row += token;
      rowWidth += tokenWidth;
      continue;
    }
    if (row.trim()) {
      // Trailing space would show as a gap before the wrap, and inside a
      // tinted row it paints.
      rows.push(row.replace(/\s+$/, ""));
      row = "";
      rowWidth = 0;
      if (/^\s+$/.test(token)) continue;
    }
    // A single token wider than the row has to be cut somewhere.
    let rest = token;
    while (displayWidth(rest) > width) {
      rows.push(sliceByWidth(rest, 0, width));
      rest = sliceByWidth(rest, width, displayWidth(rest));
    }
    row = rest;
    rowWidth = displayWidth(rest);
  }
  if (row) rows.push(row.replace(/\s+$/, ""));
  return rows;
}
