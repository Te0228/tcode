import { describe, expect, it } from "vitest";
import {
  createMarkdownRenderer,
  diffLines,
  diffStat,
  formatToolCall,
  formatToolResult,
  outputLines,
} from "../../src/ui/format.js";
import { BASIC_PALETTE, NO_COLOR_PALETTE } from "../../src/ui/theme.js";
import { displayWidth } from "../../src/ui/width.js";

const plain = NO_COLOR_PALETTE;

describe("formatToolResult (spec §14.4 P0)", () => {
  it("indents result lines under the call they belong to", () => {
    expect(formatToolResult(outputLines("a\nb"), plain)).toEqual(["  a", "  b"]);
  });

  it("caps the block and says how much it hid", () => {
    // The model still gets everything; this is only what fits on screen.
    const lines = outputLines(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
    const rendered = formatToolResult(lines, plain, 3);
    expect(rendered).toHaveLength(4);
    expect(rendered.at(-1)).toBe("  … +7 more lines");
  });

  it("says 'line' for exactly one hidden", () => {
    expect(formatToolResult(outputLines("a\nb"), plain, 1).at(-1)).toBe("  … +1 more line");
  });

  it("prints nothing when a tool has nothing to show", () => {
    expect(formatToolResult([], plain)).toEqual([]);
    expect(outputLines("")).toEqual([]);
    // A command's final newline must not become a blank line on screen.
    expect(outputLines("only\n")).toEqual([{ text: "only", tone: "plain" }]);
  });
});

describe("formatToolCall", () => {
  it("colours the glyph but leaves the command alone", () => {
    const rendered = formatToolCall("$ npm test", BASIC_PALETTE);
    expect(rendered).toContain("npm test");
    // Everything after the glyph is content, and tinting content is how a
    // palette turns into decoration.
    expect(rendered.split("npm test")[1]).toBe("");
    expect(displayWidth(rendered)).toBe("$ npm test".length);
  });
});

describe("diffLines (spec §14.4 P0)", () => {
  it("shows only the changed region, with line numbers and context", () => {
    const before = "a\nb\nc\nd\ne";
    const after = "a\nb\nCHANGED\nd\ne";
    expect(diffLines(before, after, 1)).toEqual([
      { text: "2   b", tone: "muted", code: "none" },
      { text: "3 - c", tone: "removed", code: "none" },
      { text: "3 + CHANGED", tone: "added", code: "none" },
      { text: "4   d", tone: "muted", code: "none" },
    ]);
  });

  it("widens the gutter so markers stay aligned in a long file", () => {
    const before = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 100", "CHANGED");
    const rows = diffLines(before, after, 0);
    // Three digits of line number, then the marker column.
    expect(rows[0].text).toBe("101 - line 100");
    expect(rows[1].text).toBe("101 + CHANGED");
  });

  it("renders a brand new file as all additions", () => {
    expect(diffLines("", "x\ny", 0)).toEqual([
      { text: "1 - ", tone: "removed", code: "none" },
      { text: "1 + x", tone: "added", code: "none" },
      { text: "2 + y", tone: "added", code: "none" },
    ]);
  });

  it("returns nothing when the content is identical", () => {
    expect(diffLines("same\ntext", "same\ntext")).toEqual([]);
    expect(diffStat("same", "same")).toBe("+0 -0");
  });

  it("counts additions and removals for the model-facing result", () => {
    expect(diffStat("a\nb\nc", "a\nB1\nB2\nc")).toBe("+2 -1");
  });

  it("handles a change touching the very first and last line", () => {
    expect(diffLines("old", "new", 0)).toEqual([
      { text: "1 - old", tone: "removed", code: "none" },
      { text: "1 + new", tone: "added", code: "none" },
    ]);
  });
});

describe("markdown (spec §14.4 P3)", () => {
  it("renders headings, bullets, quotes and inline marks", () => {
    const md = createMarkdownRenderer(plain);
    expect(md.render("# Title")).toBe("Title");
    expect(md.render("- item")).toBe("• item");
    expect(md.render("> quoted")).toBe("│ quoted");
    expect(md.render("a **bold** and `code`")).toBe("a bold and code");
  });

  it("tracks fences across lines, since state cannot live in one call", () => {
    const md = createMarkdownRenderer(plain);
    expect(md.inCodeBlock).toBe(false);
    md.render("```ts");
    expect(md.inCodeBlock).toBe(true);
    // Inside a fence, `**this**` is code, not emphasis.
    expect(md.render("const a = **b**;")).toBe("const a = **b**;");
    md.render("```");
    expect(md.inCodeBlock).toBe(false);
  });

  it("leaves an unmatched marker alone rather than eating it", () => {
    const md = createMarkdownRenderer(plain);
    expect(md.render("2 ** 3 is eight")).toBe("2 ** 3 is eight");
    expect(md.render("a lone ` backtick")).toBe("a lone ` backtick");
  });

  it("does not change the printed width when colour is on", () => {
    // The live frame erases by row count; a styled line that measures wider
    // than it prints would corrupt the redraw (spec §14.3).
    const md = createMarkdownRenderer(BASIC_PALETTE);
    expect(displayWidth(md.render("a **bold** word"))).toBe("a bold word".length);
  });
});
