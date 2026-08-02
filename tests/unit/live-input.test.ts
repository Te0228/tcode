import { describe, expect, it } from "vitest";
import { createLiveInput, type InputLineState } from "../../src/ui/live-input.js";
import { charWidth, displayPos, displayWidth } from "../../src/ui/width.js";

/** Minimal readline stand-in: the real one needs a terminal, and the whole
 * point of these tests is to check the geometry without one. */
function fakeInput(columns: number, prompt = "› "): InputLineState & {
  line: string;
  cursor: number;
} {
  return {
    line: "",
    cursor: 0,
    setPrompt(next: string) {
      prompt = next;
    },
    getCursorPos() {
      return displayPos(prompt + this.line.slice(0, this.cursor), columns);
    },
  };
}

function harness(options: { isTTY?: boolean; columns?: number } = {}) {
  const chunks: string[] = [];
  const input = fakeInput(options.columns ?? 80);
  const live = createLiveInput({
    write: (text) => chunks.push(text),
    columns: () => options.columns ?? 80,
    input,
    prompt: "› ",
    isTTY: options.isTTY ?? true,
  });
  return { live, input, chunks, output: () => chunks.join("") };
}

/** Replays the escape sequences we emit onto a grid, so assertions are
 * about what the user sees rather than about byte sequences. */
function render(text: string, columns = 80): string[] {
  const grid: string[][] = [[]];
  let row = 0;
  let col = 0;

  const put = (char: string) => {
    const width = charWidth(char);
    if (width === 0) return;
    // Auto-wrap, including the rule that a two-column character never
    // straddles the right edge.
    if (col + width > columns) {
      row += 1;
      col = 0;
    }
    while (grid.length <= row) grid.push([]);
    const line = grid[row];
    while (line.length < col) line.push(" ");
    line[col] = char;
    // A wide character owns the next column too, but contributes no text.
    if (width === 2) line[col + 1] = "";
    col += width;
  };

  for (let i = 0; i < text.length; i++) {
    const escape = /^\[(\d*)([A-Z])/.exec(text.slice(i));
    if (escape) {
      const value = escape[1] === "" ? 1 : Number(escape[1]);
      if (escape[2] === "A") row = Math.max(0, row - value);
      else if (escape[2] === "B") row += value;
      else if (escape[2] === "G") col = value - 1;
      else if (escape[2] === "J") {
        // clearScreenDown: rest of this row plus every row below.
        grid[row] = (grid[row] ?? []).slice(0, col);
        grid.length = row + 1;
      }
      i += escape[0].length - 1;
      continue;
    }

    const char = text[i];
    if (char === "\n") {
      row += 1;
      col = 0;
      while (grid.length <= row) grid.push([]);
    } else if (char === "\r") {
      col = 0;
    } else {
      put(char);
    }
  }

  return grid.map((line) => line.join("").replace(/\s+$/, ""));
}

describe("live input: the prompt is visible for the whole turn (spec §3.2)", () => {
  it("draws the input line as soon as the turn starts", () => {
    const { live, output } = harness();
    live.start();
    expect(render(output())).toEqual(["›"]);
  });

  it("keeps the input line below the output, never beside it", () => {
    const { live, output } = harness();
    live.start();
    live.write("first line\n");
    live.write("second line\n");
    expect(render(output())).toEqual(["first line", "second line", "›"]);
  });

  it("shows a half-finished line rather than waiting for its newline", () => {
    // A model paragraph can run for hundreds of characters without a
    // newline; buffering to line granularity would stall the stream.
    const { live, output } = harness();
    live.start();
    live.write("thinking");
    expect(render(output())).toEqual(["thinking", "›"]);

    live.write(" out loud");
    expect(render(output())).toEqual(["thinking out loud", "›"]);

    live.write(".\n");
    expect(render(output())).toEqual(["thinking out loud.", "›"]);
  });

  it("redraws whatever the user has typed underneath the output", () => {
    const { live, input, output } = harness();
    live.start();
    input.line = "wait, check X";
    input.cursor = input.line.length;
    live.write("running a command\n");
    expect(render(output())).toEqual(["running a command", "› wait, check X"]);
  });

  it("does not leave a stale copy of the pending line behind", () => {
    const { live, output } = harness();
    live.start();
    live.write("aaa");
    live.write("bbb");
    live.write("ccc\n");
    live.write("next");
    expect(render(output())).toEqual(["aaabbbccc", "next", "›"]);
  });
});

describe("live input: wide characters", () => {
  it("erases the right number of rows when the pending line is Chinese", () => {
    // 6 CJK characters = 12 columns, so this wraps at 10 and the frame is
    // two rows tall. Counting by string length would erase one row too few
    // and strand half of it on screen.
    const { live, output } = harness({ columns: 10 });
    live.start();
    live.write("中文中文中文");
    live.write("!\n");
    live.write("done\n");
    expect(render(output(), 10)).toEqual(["中文中文中", "文!", "done", "›"]);
  });

  it("measures a wrapped input line by display width, not length", () => {
    // Prompt (2) + six CJK characters (12) = 14 columns, so the input
    // block itself is two rows tall and the next write has to erase both.
    const { live, input, output } = harness({ columns: 10 });
    live.start();
    input.line = "中文中文中文";
    input.cursor = 6;
    live.write("output\n");
    expect(render(output(), 10)).toEqual(["output", "› 中文中文", "中文"]);

    live.write("more\n");
    expect(render(output(), 10)).toEqual(["output", "more", "› 中文中文", "中文"]);
  });
});

describe("live input: handing the terminal back", () => {
  it("flushes the pending line and leaves the input block drawn", () => {
    // readline erases its block by moving up from where it last left the
    // cursor, so the block has to still be there when we let go.
    const { live, output } = harness();
    live.start();
    live.write("half a line");
    live.stop();
    expect(render(output())).toEqual(["half a line", "›"]);
    expect(live.isActive()).toBe(false);
  });

  it("writes straight through once stopped", () => {
    const { live, chunks } = harness();
    live.start();
    live.stop();
    chunks.length = 0;
    live.write("plain\n");
    expect(chunks.join("")).toBe("plain\n");
  });

  it("start is idempotent — a queued message must not draw a second prompt", () => {
    const { live, output } = harness();
    live.start();
    live.start();
    expect(render(output())).toEqual(["›"]);
  });
});

describe("live input: Enter pressed mid-turn", () => {
  it("adopts the stranded pending line instead of drawing it twice", () => {
    const { live, chunks } = harness();
    live.start();
    live.write("partial text");
    // readline echoes the input block and moves below it; the pending row
    // above is now permanent screen content we no longer own.
    chunks.length = 0;
    live.commitLine();
    live.write("more\n");
    // "partial text" must not reappear.
    expect(chunks.join("")).not.toContain("partial text");
  });
});

describe("live input: no terminal", () => {
  it("emits no escape sequences at all when stdout is a pipe", () => {
    const { live, chunks } = harness({ isTTY: false });
    live.start();
    live.write("hello\n");
    live.write("world");
    live.stop();
    expect(chunks.join("")).toBe("hello\nworld");
    expect(live.isActive()).toBe(false);
  });
});

describe("displayWidth / displayPos", () => {
  it("counts CJK as two columns and ANSI as none", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("[31mred[0m")).toBe(3);
  });

  it("never lets a wide character straddle the right edge", () => {
    // At column 9 of a 10-column terminal a 2-wide character cannot fit,
    // so it skips the last column and wraps whole.
    expect(displayPos("abcdefghi中", 10)).toEqual({ rows: 1, cols: 2 });
  });

  it("counts a trailing newline as a row even at column 0", () => {
    expect(displayPos("\n", 10)).toEqual({ rows: 1, cols: 0 });
    expect(displayPos("0123456789\n", 10)).toEqual({ rows: 1, cols: 0 });
    expect(displayPos("0123456789a\n", 10)).toEqual({ rows: 2, cols: 0 });
  });
});
