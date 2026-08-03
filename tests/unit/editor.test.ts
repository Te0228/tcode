import { describe, expect, it } from "vitest";
import { createEditor } from "../../src/ui/editor.js";
import { NO_COLOR_PALETTE } from "../../src/ui/theme.js";
import { displayWidth } from "../../src/ui/width.js";

const key = (name: string, extra: Record<string, boolean> = {}) => ({ name, ...extra });

function editor(options: Partial<Parameters<typeof createEditor>[0]> = {}) {
  return createEditor({
    palette: NO_COLOR_PALETTE,
    columns: () => 80,
    ...options,
  });
}

function type(ed: ReturnType<typeof editor>, text: string) {
  for (const char of text) ed.handleKey(char, { name: char });
}

describe("editor: text entry (spec §16.4)", () => {
  it("inserts, moves and deletes", () => {
    const ed = editor();
    type(ed, "hello");
    expect(ed.line).toBe("hello");
    ed.handleKey(undefined, key("left"));
    ed.handleKey(undefined, key("backspace"));
    expect(ed.line).toBe("helo");
    ed.handleKey(undefined, key("delete"));
    expect(ed.line).toBe("hel");
  });

  it("supports the line-editing keys a shell user already knows", () => {
    const ed = editor();
    type(ed, "one two three");
    ed.handleKey(undefined, key("w", { ctrl: true }));
    expect(ed.line).toBe("one two ");
    ed.handleKey(undefined, key("a", { ctrl: true }));
    expect(ed.cursor).toBe(0);
    ed.handleKey(undefined, key("k", { ctrl: true }));
    expect(ed.line).toBe("");
  });

  it("moves by word", () => {
    const ed = editor();
    type(ed, "alpha beta");
    ed.handleKey(undefined, key("left", { meta: true }));
    expect(ed.cursor).toBe(6);
    ed.handleKey(undefined, key("right", { meta: true }));
    expect(ed.cursor).toBe(10);
  });

  it("drops control characters instead of letting them corrupt the render", () => {
    const ed = editor();
    ed.insert(`a${String.fromCharCode(7)}b${String.fromCharCode(27)}c`);
    expect(ed.line).toBe("abc");
  });
});

describe("editor: submitting (spec §15.2)", () => {
  it("returns the text and clears the buffer", () => {
    const ed = editor();
    type(ed, "do the thing");
    expect(ed.handleKey(undefined, key("return"))).toEqual({
      type: "submit",
      text: "do the thing",
    });
    expect(ed.line).toBe("");
  });

  it("continues on a trailing backslash instead of sending", () => {
    const ed = editor();
    type(ed, "first \\");
    expect(ed.handleKey(undefined, key("return"))).toEqual({ type: "none" });
    expect(ed.draftLines).toEqual(["first "]);
    type(ed, "second");
    expect(ed.handleKey(undefined, key("return"))).toEqual({
      type: "submit",
      text: "first \nsecond",
    });
  });

  it("backspacing off an empty continuation pulls the previous line back", () => {
    // Otherwise the key does nothing and that line is unreachable.
    const ed = editor();
    type(ed, "first \\");
    ed.handleKey(undefined, key("return"));
    ed.handleKey(undefined, key("backspace"));
    expect(ed.draftLines).toEqual([]);
    expect(ed.line).toBe("first ");
  });
});

describe("editor: paste (spec §15.1)", () => {
  it("keeps every line and leaves the unfinished tail editable", () => {
    const ed = editor();
    ed.paste("one\ntwo\nthree");
    expect(ed.draftLines).toEqual(["one", "two"]);
    expect(ed.line).toBe("three");
    expect(ed.handleKey(undefined, key("return"))).toEqual({
      type: "submit",
      text: "one\ntwo\nthree",
    });
  });

  it("merges into whatever was already typed", () => {
    const ed = editor();
    type(ed, "look: ");
    ed.paste("a\nb");
    expect(ed.draftLines).toEqual(["look: a"]);
    expect(ed.line).toBe("b");
  });

  it("a paste without newlines is just typing", () => {
    const ed = editor();
    ed.paste("src/index.ts");
    expect(ed.draftLines).toEqual([]);
    expect(ed.line).toBe("src/index.ts");
  });
});

describe("editor: history (spec §15.5)", () => {
  it("walks back and forward, restoring what was being typed", () => {
    const ed = editor({ history: ["newest", "older"] });
    type(ed, "half typed");
    ed.handleKey(undefined, key("up"));
    expect(ed.line).toBe("newest");
    ed.handleKey(undefined, key("up"));
    expect(ed.line).toBe("older");
    ed.handleKey(undefined, key("down"));
    expect(ed.line).toBe("newest");
    ed.handleKey(undefined, key("down"));
    expect(ed.line).toBe("half typed");
  });

  it("records what was sent, without consecutive duplicates", () => {
    const ed = editor();
    type(ed, "same");
    ed.handleKey(undefined, key("return"));
    type(ed, "same");
    ed.handleKey(undefined, key("return"));
    expect(ed.snapshotHistory()).toEqual(["same"]);
  });

  it("stops at the ends instead of wrapping", () => {
    const ed = editor({ history: ["only"] });
    ed.handleKey(undefined, key("up"));
    ed.handleKey(undefined, key("up"));
    expect(ed.line).toBe("only");
  });
});

describe("editor: completion (spec §15.4)", () => {
  it("completes a single candidate outright", () => {
    const ed = editor({ complete: () => [["src/index.ts"], "src/in"] });
    type(ed, "read src/in");
    ed.handleKey(undefined, key("tab"));
    expect(ed.line).toBe("read src/index.ts");
  });

  it("extends to the shared prefix and lists the rest", () => {
    // Tab must never be a no-op when it could have made progress.
    const ed = editor({ complete: () => [["src/index.ts", "src/input.ts"], "src/i"] });
    type(ed, "read src/i");
    const action = ed.handleKey(undefined, key("tab"));
    expect(ed.line).toBe("read src/in");
    expect(action).toEqual({ type: "candidates", items: ["src/index.ts", "src/input.ts"] });
  });
});

describe("editor: control keys (spec §3.2)", () => {
  it("separates Esc from Ctrl+C so neither discards text and quits at once", () => {
    // Esc stops what is running or clears the line; Ctrl+C escalates to
    // quitting, but only once there is nothing typed left to lose.
    const ed = editor();
    expect(ed.handleKey(undefined, key("escape"))).toEqual({ type: "interrupt" });
    expect(ed.handleKey(undefined, key("c", { ctrl: true }))).toEqual({ type: "cancel" });
    expect(ed.handleKey(undefined, key("d", { ctrl: true }))).toEqual({ type: "eof" });
  });

  it("Ctrl+D with text deletes forward rather than quitting", () => {
    const ed = editor();
    type(ed, "ab");
    ed.handleKey(undefined, key("left"));
    expect(ed.handleKey(undefined, key("d", { ctrl: true }))).toEqual({ type: "none" });
    expect(ed.line).toBe("a");
  });
});

describe("editor: rendering (spec §16.2)", () => {
  it("draws a rail and a prompt, not a box (spec §17.1)", () => {
    // A box here would collide with the modal dialogs, where a box means
    // "deal with this now".
    const ed = editor();
    type(ed, "hi");
    const region = ed.render();
    expect(region.lines).toHaveLength(1);
    expect(region.lines[0]).toContain("›");
    expect(region.cursorRow).toBe(0);
    // rail (2) + prompt (2) + "hi"
    expect(region.cursorCol).toBe(2 + 2 + 2);
  });

  it("places the cursor by display width, not character count", () => {
    // A cursor that drifts on Chinese input is the most glaring possible
    // failure of taking over the input layer (spec §16.4).
    const ed = editor();
    type(ed, "中文");
    expect(ed.render().cursorCol).toBe(2 + 2 + 4);
  });

  it("shows how many lines are already committed", () => {
    const ed = editor();
    ed.paste("a\nb\nc");
    expect(ed.render().lines[0]).toContain("[+2 lines]");
  });

  it("adds a status bar when one is supplied", () => {
    const ed = editor({ status: () => ({ left: "model · 1k/65k", hints: ["send"] }) });
    const lines = ed.render().lines;
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("model · 1k/65k");
    expect(lines[1]).toContain("send");
  });
});

describe("editor: long input scrolls instead of overflowing (spec §16.2)", () => {
  it("never renders a row wider than the layout", () => {
    // A row wider than the layout wraps, silently becomes two screen rows,
    // and every erase afterwards is one row short.
    const ed = editor({ columns: () => 60 });
    type(ed, "x".repeat(300));
    for (const line of ed.render().lines) expect(displayWidth(line)).toBeLessThanOrEqual(59);
  });

  it("keeps the cursor inside the layout while typing past its width", () => {
    const ed = editor({ columns: () => 60 });
    type(ed, "y".repeat(300));
    const region = ed.render();
    expect(region.cursorCol).toBeLessThan(59);
    expect(region.cursorCol).toBeGreaterThan(0);
  });

  it("shows the end of the line, which is where the cursor is", () => {
    const ed = editor({ columns: () => 60 });
    type(ed, `${"a".repeat(200)}TAIL`);
    expect(ed.render().lines[0]).toContain("TAIL");
  });

  it("scrolls back when the cursor moves left", () => {
    const ed = editor({ columns: () => 60 });
    type(ed, `HEAD${"a".repeat(200)}`);
    for (let at = 0; at < 220; at++) ed.handleKey(undefined, key("left"));
    expect(ed.render().lines[0]).toContain("HEAD");
  });

  it("holds the layout width with CJK text past the edge", () => {
    const ed = editor({ columns: () => 60 });
    type(ed, "中".repeat(100));
    for (const line of ed.render().lines) expect(displayWidth(line)).toBeLessThanOrEqual(59);
  });

  it("stays inside a narrow window with no box either", () => {
    const ed = editor({ columns: () => 20 });
    type(ed, "z".repeat(80));
    const region = ed.render();
    expect(displayWidth(region.lines[0])).toBeLessThanOrEqual(20);
    expect(region.cursorCol).toBeLessThan(20);
  });
});

describe("editor: the command menu (spec §17.5b)", () => {
  const commands = [
    { name: "help", summary: "list these commands" },
    { name: "sessions", summary: "list sessions" },
    { name: "new", summary: "start an empty session" },
  ];
  const withMenu = () => editor({ commands, columns: () => 60 });

  it("opens the moment a slash is typed", () => {
    // Typing `/` and seeing nothing is why the commands read as missing:
    // they worked, but nothing said so.
    const ed = withMenu();
    type(ed, "/");
    const rendered = ed.render().lines.join("\n");
    for (const command of commands) expect(rendered).toContain(`/${command.name}`);
  });

  it("filters as more is typed", () => {
    const ed = withMenu();
    type(ed, "/se");
    const rendered = ed.render().lines.join("\n");
    expect(rendered).toContain("/sessions");
    expect(rendered).not.toContain("/help");
  });

  it("closes once there is an argument", () => {
    // A menu on top of the arguments is in the way.
    const ed = withMenu();
    type(ed, "/resume abc");
    expect(ed.render().lines).toHaveLength(1);
  });

  it("closes for something that is not a command", () => {
    const ed = withMenu();
    type(ed, "/zzz");
    expect(ed.render().lines).toHaveLength(1);
  });

  it("takes the arrows while open and gives them back after", () => {
    const ed = editor({ commands, history: ["earlier"], columns: () => 60 });
    type(ed, "/");
    ed.handleKey(undefined, key("down"));
    ed.handleKey(undefined, key("tab"));
    expect(ed.line).toBe("/sessions ");

    ed.setLine("");
    ed.handleKey(undefined, key("up"));
    expect(ed.line).toBe("earlier");
  });

  it("Enter runs the highlighted entry, not the prefix", () => {
    const ed = withMenu();
    type(ed, "/s");
    expect(ed.handleKey(undefined, key("return"))).toEqual({
      type: "submit",
      text: "/sessions",
    });
  });

  it("keeps the cursor on the input row, below the menu", () => {
    const ed = withMenu();
    type(ed, "/");
    const region = ed.render();
    expect(region.cursorRow).toBe(region.lines.length - 1);
  });
});
