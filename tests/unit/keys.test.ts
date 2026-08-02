import { describe, expect, it } from "vitest";
import { isInterruptKey } from "../../src/ui/keys.js";

describe("isInterruptKey (spec §3.2)", () => {
  it("accepts a bare Esc — which readline reports with meta set", () => {
    // Regression lock. The original condition rejected `meta` keys, which
    // reads as sensible hygiene and in fact rejected every Esc: Esc is the
    // meta prefix, so readline flags the key that produced it. The
    // interrupt silently did nothing for its entire life.
    expect(
      isInterruptKey({ name: "escape", sequence: "", ctrl: false, meta: true, shift: false }),
    ).toBe(true);
  });

  it("ignores arrow keys, which arrive as escape sequences too", () => {
    for (const name of ["up", "down", "left", "right"]) {
      expect(isInterruptKey({ name, meta: false, ctrl: false, shift: false })).toBe(false);
    }
  });

  it.each([
    ["ordinary characters", { name: "a" }],
    ["Ctrl+C, which has its own handler", { name: "c", ctrl: true }],
    ["nothing at all", undefined],
  ])("ignores %s", (_label, key) => {
    expect(isInterruptKey(key)).toBe(false);
  });
});
