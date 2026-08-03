import { describe, expect, it } from "vitest";
import { COLOR_PALETTE, NO_COLOR_PALETTE, colorEnabled, createPalette } from "../../src/ui/style.js";

const ESCAPE = /\[/;

describe("colorEnabled (spec §14.3)", () => {
  it("follows the terminal when nothing says otherwise", () => {
    expect(colorEnabled({ isTTY: true, env: {} })).toBe(true);
    expect(colorEnabled({ isTTY: false, env: {} })).toBe(false);
  });

  it("honours NO_COLOR whatever its value, but not when empty", () => {
    // The convention: presence is the signal, not the value.
    expect(colorEnabled({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(colorEnabled({ isTTY: true, env: { NO_COLOR: "0" } })).toBe(false);
    expect(colorEnabled({ isTTY: true, env: { NO_COLOR: "anything" } })).toBe(false);
    expect(colorEnabled({ isTTY: true, env: { NO_COLOR: "" } })).toBe(true);
  });

  it("treats TERM=dumb as no colour", () => {
    expect(colorEnabled({ isTTY: true, env: { TERM: "dumb" } })).toBe(false);
  });

  it("lets FORCE_COLOR turn colour on without a terminal", () => {
    // The only reason anyone sets it: a log viewer that renders ANSI.
    expect(colorEnabled({ isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(true);
    expect(colorEnabled({ isTTY: false, env: { FORCE_COLOR: "0" } })).toBe(false);
    // Explicit beats conventional: asking for colour outranks NO_COLOR.
    expect(colorEnabled({ isTTY: false, env: { FORCE_COLOR: "1", NO_COLOR: "1" } })).toBe(true);
  });
});

describe("palette", () => {
  it("emits no escape sequence at all when colour is off", () => {
    // The regression this guards: a forgotten `if (color)` at one call site
    // leaks escapes into a pipe. Identity functions make that impossible.
    for (const [role, style] of Object.entries(NO_COLOR_PALETTE)) {
      expect(style("text"), role).toBe("text");
    }
  });

  it("wraps text when colour is on, and closes the attribute it opened", () => {
    for (const [role, style] of Object.entries(COLOR_PALETTE)) {
      const output = style("text");
      expect(output, role).toMatch(ESCAPE);
      expect(output, role).toContain("text");
      // A blanket reset would cancel an enclosing style too.
      expect(output, role).not.toContain("[0m");
    }
  });

  it("nests without the inner style cancelling the outer one", () => {
    const nested = COLOR_PALETTE.meta(`a ${COLOR_PALETTE.strong("b")} c`);
    // Reopening dim after the inner close would be the alternative; what
    // matters is that the outer close is still the last thing emitted.
    expect(nested.endsWith("[22m")).toBe(true);
  });

  it("createPalette picks the right one", () => {
    expect(createPalette({ isTTY: false, env: {} }).error("x")).toBe("x");
    expect(createPalette({ isTTY: true, env: {} }).error("x")).toMatch(ESCAPE);
  });
});
