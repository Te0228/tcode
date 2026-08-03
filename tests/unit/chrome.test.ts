import { describe, expect, it } from "vitest";
import {
  MAX_BOX_WIDTH,
  alignRight,
  banner,
  box,
  boxFits,
  boxWidth,
  padTo,
  shortenPath,
} from "../../src/ui/chrome.js";
import { createSelect } from "../../src/ui/select.js";
import { BASIC_PALETTE, NO_COLOR_PALETTE, colorLevel } from "../../src/ui/theme.js";
import { displayWidth } from "../../src/ui/width.js";

const plain = NO_COLOR_PALETTE;

describe("box (spec §16.2)", () => {
  it("is exactly the requested width on every row", () => {
    const rows = box(["  hello", "  world"], 30, plain);
    for (const row of rows) expect(displayWidth(row)).toBe(30);
  });

  it("stays the requested width with CJK content", () => {
    // `padEnd` counts characters; a box padded that way loses a column per
    // wide character and the right border walks left.
    const rows = box(["  中文内容"], 30, plain);
    for (const row of rows) expect(displayWidth(row)).toBe(30);
  });

  it("stays the requested width with colour applied", () => {
    const rows = box([`  ${BASIC_PALETTE.accent("tcode")}`], 30, BASIC_PALETTE);
    for (const row of rows) expect(displayWidth(row)).toBe(30);
  });

  it("uses rounded corners", () => {
    const rows = box(["x"], 10, plain);
    expect(rows[0][0]).toBe("╭");
    expect(rows.at(-1)![0]).toBe("╰");
  });
});

describe("box sizing", () => {
  it("caps the width so long lines stay readable", () => {
    expect(boxWidth(500)).toBe(MAX_BOX_WIDTH);
    expect(boxWidth(90)).toBe(89);
  });

  it("treats an unreported width as a normal terminal, not a tiny one", () => {
    // A terminal that has not answered yet reports 0. Taking that literally
    // renders the first frame unboxed and every later erase is off by the
    // rows the box would have added.
    expect(boxFits(0)).toBe(true);
    expect(boxWidth(0)).toBe(79);
  });

  it("gives up on a genuinely narrow window", () => {
    expect(boxFits(30)).toBe(false);
  });
});

describe("padding and alignment", () => {
  it("pads by display width", () => {
    expect(displayWidth(padTo("中文", 10))).toBe(10);
    expect(displayWidth(padTo("abc", 10))).toBe(10);
  });

  it("puts the metadata on the right edge", () => {
    const line = alignRight("read src/a.ts", "128 lines", 40);
    expect(displayWidth(line)).toBe(40);
    expect(line.endsWith("128 lines")).toBe(true);
  });

  it("degrades to a single space when the two do not fit", () => {
    expect(alignRight("aaaa", "bbbb", 4)).toBe("aaaa bbbb");
  });
});

describe("banner", () => {
  it("shortens a deep path instead of pushing the rest off the line", () => {
    expect(shortenPath("/Users/te/a/b/c/project", "/Users/te")).toBe("~/…/c/project");
    expect(shortenPath("/Users/te/project", "/Users/te")).toBe("~/project");
  });

  it("renders at the requested width", () => {
    const rows = banner(
      { model: "deepseek/deepseek-chat", root: "/tmp/x", session: "s1", fullAuto: true },
      60,
      plain,
    );
    for (const row of rows) expect(displayWidth(row)).toBe(60);
    expect(rows.join("\n")).toContain("full-auto");
  });
});

describe("select overlay (spec §16.6)", () => {
  const make = () =>
    createSelect<string>({
      title: "run this command?",
      subject: "$ rm -rf /tmp/x",
      detail: "writes outside the project",
      options: [
        { label: "yes", value: "yes", shortcut: "y" },
        { label: "always", value: "always", shortcut: "a" },
        { label: "no", value: "no", shortcut: "n" },
      ],
      palette: plain,
      columns: () => 60,
      cancelValue: "no",
    });

  it("confirms the highlighted option on Enter — no letter to type", () => {
    const select = make();
    expect(select.handleKey(undefined, { name: "return" })).toEqual({
      type: "chosen",
      value: "yes",
    });
  });

  it("moves with the arrows and wraps", () => {
    const select = make();
    select.handleKey(undefined, { name: "down" });
    expect(select.selectedIndex).toBe(1);
    select.handleKey(undefined, { name: "up" });
    select.handleKey(undefined, { name: "up" });
    expect(select.selectedIndex).toBe(2);
  });

  it("keeps the letter shortcuts, because that muscle memory exists", () => {
    expect(make().handleKey("n", { name: "n" })).toEqual({ type: "chosen", value: "no" });
    expect(make().handleKey("a", { name: "a" })).toEqual({ type: "chosen", value: "always" });
  });

  it("accepts number keys by position", () => {
    expect(make().handleKey("3", { name: "3" })).toEqual({ type: "chosen", value: "no" });
  });

  it("treats Esc and Ctrl+C as refusal — declining is always the safe default", () => {
    expect(make().handleKey(undefined, { name: "escape" })).toEqual({
      type: "chosen",
      value: "no",
    });
    expect(make().handleKey(undefined, { name: "c", ctrl: true })).toEqual({
      type: "chosen",
      value: "no",
    });
  });

  it("shows the command as its own line, not buried in a sentence", () => {
    const rendered = make().render().lines.join("\n");
    expect(rendered).toContain("$ rm -rf /tmp/x");
    expect(rendered).toContain("writes outside the project");
    expect(rendered).toContain("❯ yes");
  });

  it("keeps every row the same width, title and hints included", () => {
    const widths = new Set(make().render().lines.map((line) => displayWidth(line)));
    // boxWidth leaves one column, so the box never touches the right edge.
    expect(widths).toEqual(new Set([59]));
  });
});

describe("colour level (spec §16.3)", () => {
  it("uses full colour only when the terminal advertises it", () => {
    expect(colorLevel({ isTTY: true, env: { COLORTERM: "truecolor" } })).toBe("true");
    expect(colorLevel({ isTTY: true, env: { TERM: "xterm-256color" } })).toBe("true");
    expect(colorLevel({ isTTY: true, env: { TERM: "xterm" } })).toBe("basic");
  });

  it("still honours NO_COLOR and a pipe", () => {
    expect(colorLevel({ isTTY: true, env: { NO_COLOR: "1", COLORTERM: "truecolor" } })).toBe("none");
    expect(colorLevel({ isTTY: false, env: { COLORTERM: "truecolor" } })).toBe("none");
    expect(colorLevel({ isTTY: false, env: { FORCE_COLOR: "1" } })).not.toBe("none");
  });
});
