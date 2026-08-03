import { describe, expect, it } from "vitest";
import { createTranscript, wrapToWidth } from "../../src/ui/transcript.js";
import { NO_COLOR_PALETTE, TRUE_COLOR_PALETTE } from "../../src/ui/theme.js";
import { displayWidth } from "../../src/ui/width.js";
import type { ToolUseBlock } from "../../src/llm/types.js";

function harness(width = 40, palette = NO_COLOR_PALETTE) {
  const out: string[] = [];
  let pending = "";
  const view = createTranscript({
    palette,
    colored: false,
    width: () => width,
    write: (text) => out.push(text),
    rewritePending: (text) => {
      pending = text;
    },
    renderMarkdown: false,
  });
  return { view, lines: () => out.join("").split("\n").slice(0, -1), pending: () => pending };
}

const use = (name: string, input: unknown = {}): ToolUseBlock => ({
  type: "tool_use",
  id: "t1",
  name,
  input,
});

describe("transcript: the rail (spec §17.3)", () => {
  it("puts every line of a turn on the rail", () => {
    const { view, lines } = harness();
    view.note("first");
    view.note("second");
    expect(lines()).toEqual(["| first", "| second"]);
  });

  it("repeats the rail on wrapped rows", () => {
    // The terminal wrapping instead loses the rail on continuation rows and
    // the block stops reading as one turn.
    const { view, lines } = harness(20);
    view.note("one two three four five six");
    for (const row of lines()) {
      expect(row.startsWith("| ")).toBe(true);
      expect(displayWidth(row)).toBeLessThanOrEqual(20);
    }
    expect(lines().length).toBeGreaterThan(1);
  });

  it("keeps a heading off the rail so it reads as a divider", () => {
    const { view, lines } = harness();
    view.heading("== turn 1 ==");
    expect(lines()).toEqual(["== turn 1 =="]);
  });
});

describe("transcript: streaming text (spec §14.4/§17.3)", () => {
  it("shows a partial line immediately, on the rail", () => {
    const { view, pending } = harness();
    view.event({ type: "text", chunk: "thinking" });
    expect(pending()).toBe("| thinking");
  });

  it("commits complete lines and clears the pending copy", () => {
    const { view, lines, pending } = harness();
    view.event({ type: "text", chunk: "one\ntwo" });
    expect(lines()).toEqual(["| one"]);
    expect(pending()).toBe("| two");
  });

  it("closes an open line before anything else prints on it", () => {
    // Without this the streamed half-line and the next tool line share a row.
    const { view, lines } = harness();
    view.event({ type: "text", chunk: "half a thought" });
    view.event({ type: "tool_end", toolUse: use("bash", { command: "ls" }), meta: "exit 0", display: [], failed: false });
    expect(lines()[0]).toBe("| half a thought");
    expect(lines()[1]).toContain("$ ls");
  });
});

describe("transcript: tool calls (spec §16.9)", () => {
  it("puts the outcome on the right edge of the call line", () => {
    const { view, lines } = harness(40);
    view.event({
      type: "tool_end",
      toolUse: use("read_file", { path: "a.ts" }),
      meta: "128 lines",
      display: [],
      failed: false,
    });
    const row = lines()[0];
    expect(row.endsWith("128 lines")).toBe(true);
    expect(displayWidth(row)).toBe(40);
  });

  it("caps the result block and says what it hid", () => {
    const { view, lines } = harness();
    view.event({
      type: "tool_end",
      toolUse: use("bash", { command: "ls" }),
      meta: "exit 0",
      display: Array.from({ length: 10 }, (_, i) => ({ text: `line ${i}` })),
      failed: false,
    });
    expect(lines().at(-1)).toContain("+4 more lines");
  });

  it("says nothing for finish — the closing line already carries it", () => {
    const { view, lines } = harness();
    view.event({
      type: "tool_end",
      toolUse: use("finish", { summary: "all done" }),
      meta: "",
      display: [],
      failed: false,
    });
    expect(lines()).toEqual([]);
  });
});

describe("transcript: row tints (spec §17.1)", () => {
  it("fills an added row edge to edge, and never past it", () => {
    // A tinted row that wraps paints its background across two rows and the
    // whole block shifts.
    const { view, lines } = harness(40, TRUE_COLOR_PALETTE);
    view.event({
      type: "tool_end",
      toolUse: use("edit_file", { path: "a.ts" }),
      meta: "+1 -0",
      display: [{ text: "1 + const a = 1;", tone: "added", code: "c-like" }],
      failed: false,
    });
    for (const row of lines()) expect(displayWidth(row)).toBeLessThanOrEqual(40);
    expect(lines()[1]).toContain("48;2;"); // a background was actually set
  });

  it("leaves rows untinted when the palette cannot tint", () => {
    const { view, lines } = harness(40, NO_COLOR_PALETTE);
    view.event({
      type: "tool_end",
      toolUse: use("edit_file", { path: "a.ts" }),
      meta: "+1 -0",
      display: [{ text: "1 + const a = 1;", tone: "added" }],
      failed: false,
    });
    expect(lines()[1]).toBe("|   1 + const a = 1;");
  });
});

describe("transcript: the closing line", () => {
  it("puts the detail on the right of the last row", () => {
    const { view, lines } = harness(40);
    view.outcome("done", "13:11 · 3s");
    expect(displayWidth(lines()[0])).toBe(40);
    expect(lines()[0].endsWith("13:11 · 3s")).toBe(true);
  });

  it("wraps a long summary rather than overflowing the row", () => {
    const { view, lines } = harness(40);
    view.outcome("a rather long summary that will not fit on one row", "3s");
    expect(lines().length).toBeGreaterThan(1);
    for (const row of lines()) expect(displayWidth(row)).toBeLessThanOrEqual(40);
    expect(lines().at(-1)!.endsWith("3s")).toBe(true);
  });
});

describe("wrapToWidth", () => {
  it("breaks at spaces when it can", () => {
    expect(wrapToWidth("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
  });

  it("breaks inside a token that cannot fit", () => {
    expect(wrapToWidth("aaaaaaaa", 3)).toEqual(["aaa", "aaa", "aa"]);
  });

  it("measures by display width, so CJK wraps at the right place", () => {
    for (const row of wrapToWidth("中文".repeat(20), 10)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(10);
    }
  });

  it("leaves a short line alone", () => {
    expect(wrapToWidth("short", 40)).toEqual(["short"]);
  });
});
