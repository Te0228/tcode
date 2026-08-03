/**
 * Line-level rendering (spec §14.5).
 *
 * Pure: structured data in, strings out. Nothing here touches stdout, so
 * all of it is testable without a terminal — which matters because the
 * problems this file exists to fix (invisible tool output, no visual
 * hierarchy) are exactly the kind only a human staring at a real terminal
 * would otherwise catch.
 */
import type { DisplayLine } from "../tools/types.js";
import type { Palette } from "./theme.js";

/** Indent under a tool call, so results read as belonging to it. */
export const RESULT_INDENT = "  ";

/** Default cap on result lines shown per tool call (spec §14.4 P0). The
 * model still receives everything. */
export const DEFAULT_MAX_RESULT_LINES = 6;

function toneStyle(palette: Palette, tone: DisplayLine["tone"]): (text: string) => string {
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
}

/**
 * The block printed under a tool call. Head-truncated only — the tail of a
 * long result is where errors live, but the head is where a diff's context
 * lives, and the model has the whole thing either way. Showing the start
 * and saying how much was hidden is honest and predictable.
 */
export function formatToolResult(
  lines: DisplayLine[],
  palette: Palette,
  maxLines = DEFAULT_MAX_RESULT_LINES,
): string[] {
  const shown = maxLines > 0 ? lines.slice(0, maxLines) : lines;
  const rendered = shown.map((line) => `${RESULT_INDENT}${toneStyle(palette, line.tone)(line.text)}`);

  const hidden = lines.length - shown.length;
  if (hidden > 0) {
    rendered.push(`${RESULT_INDENT}${palette.meta(`… +${hidden} more line${hidden === 1 ? "" : "s"}`)}`);
  }
  return rendered;
}

/**
 * The tool-call line. Only the leading glyph is coloured: the command or
 * path after it is the content, and tinting content is how a palette turns
 * into decoration (spec §14.3).
 */
export function formatToolCall(summary: string, palette: Palette): string {
  const split = summary.indexOf(" ");
  if (split <= 0) return palette.toolCall(summary);
  return `${palette.toolCall(summary.slice(0, split))}${summary.slice(split)}`;
}

/** Splits captured output into display lines, dropping the trailing blank
 * that every command's final newline produces. */
export function outputLines(text: string, tone: DisplayLine["tone"] = "plain"): DisplayLine[] {
  const trimmed = text.replace(/\n+$/, "");
  if (!trimmed) return [];
  return trimmed.split("\n").map((text) => ({ text, tone }));
}

/**
 * A line diff built by trimming the common prefix and suffix.
 *
 * Not an LCS: the changed region is contiguous in every edit a tool of
 * this kind produces (a replace, an overwrite), and prefix/suffix trimming
 * finds it in O(n) with no memory blowup on a large file. An LCS would
 * only differ on interleaved changes, which `edit_file` cannot create.
 */
export function diffLines(before: string, after: string, context = 2): DisplayLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start++;
  }

  let end = 0;
  while (
    end < beforeLines.length - start &&
    end < afterLines.length - start &&
    beforeLines[beforeLines.length - 1 - end] === afterLines[afterLines.length - 1 - end]
  ) {
    end++;
  }

  const removed = beforeLines.slice(start, beforeLines.length - end);
  const added = afterLines.slice(start, afterLines.length - end);
  if (removed.length === 0 && added.length === 0) return [];

  const lines: DisplayLine[] = [];
  const contextBefore = beforeLines.slice(Math.max(0, start - context), start);
  for (const text of contextBefore) lines.push({ text: `  ${text}`, tone: "muted" });
  for (const text of removed) lines.push({ text: `- ${text}`, tone: "removed" });
  for (const text of added) lines.push({ text: `+ ${text}`, tone: "added" });
  const contextAfter = beforeLines.slice(
    beforeLines.length - end,
    beforeLines.length - end + context,
  );
  for (const text of contextAfter) lines.push({ text: `  ${text}`, tone: "muted" });

  return lines;
}

/** `+3 −1` style counts, for the tool_result the model reads. */
export function diffStat(before: string, after: string): string {
  const lines = diffLines(before, after, 0);
  const added = lines.filter((line) => line.tone === "added").length;
  const removed = lines.filter((line) => line.tone === "removed").length;
  return `+${added} -${removed}`;
}

/**
 * Markdown, rendered a line at a time (spec §14.4 P3).
 *
 * Line-at-a-time is forced by streaming: `**bold**` can arrive split
 * across two deltas, so nothing inline can be decided until the line is
 * complete. Fence state has to persist across lines, hence a factory
 * rather than a bare function.
 */
export function createMarkdownRenderer(palette: Palette) {
  let inFence = false;

  return {
    /** True while inside a ``` block, so the caller can skip inline
     * rendering of code it is about to print verbatim. */
    get inCodeBlock() {
      return inFence;
    },

    render(line: string): string {
      const fence = /^\s*```/.test(line);
      if (fence) {
        inFence = !inFence;
        return palette.meta(line);
      }
      if (inFence) return palette.code(line);

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) return palette.strong(heading[2]);

      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) return palette.meta(`│ ${renderInline(quote[1], palette)}`);

      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bullet) return `${bullet[1]}• ${renderInline(bullet[2], palette)}`;

      return renderInline(line, palette);
    },
  };
}

/** Bold and inline code. Deliberately not a markdown parser — anything
 * more needs a real one, and the marginal value over these two is small. */
function renderInline(text: string, palette: Palette): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, (_all, inner: string) => palette.strong(inner))
    .replace(/`([^`]+)`/g, (_all, inner: string) => palette.code(inner));
}
