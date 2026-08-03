import { describe, expect, it } from "vitest";
import { SPINNER_FRAMES, createSpinner } from "../../src/ui/spinner.js";
import { NO_COLOR_PALETTE } from "../../src/ui/style.js";
import { charWidth } from "../../src/ui/width.js";

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("spinner (spec §14.4 P2)", () => {
  it("says nothing when nothing is happening", () => {
    const spinner = createSpinner({ palette: NO_COLOR_PALETTE });
    expect(spinner.tick()).toBe("");
    spinner.set({ kind: "model" });
    spinner.set(null);
    expect(spinner.tick()).toBe("");
  });

  it("distinguishes waiting on the model from running a tool", () => {
    // The whole point: the two differ by an order of magnitude in normal
    // duration, so collapsing them removes the user's only cue for whether
    // something is stuck.
    const spinner = createSpinner({ palette: NO_COLOR_PALETTE });
    spinner.set({ kind: "model" });
    expect(spinner.tick()).toContain("thinking");
    spinner.set({ kind: "tool", label: "$ npm test" });
    expect(spinner.tick()).toContain("$ npm test");
  });

  it("advances one frame per tick and wraps around", () => {
    const spinner = createSpinner({ palette: NO_COLOR_PALETTE });
    spinner.set({ kind: "model" });
    const frames = Array.from({ length: SPINNER_FRAMES.length + 1 }, () =>
      spinner.tick().charAt(0),
    );
    expect(frames.slice(0, SPINNER_FRAMES.length)).toEqual(SPINNER_FRAMES);
    expect(frames.at(-1)).toBe(SPINNER_FRAMES[0]);
  });

  it("shows elapsed time only once it means something", () => {
    const time = clock();
    const spinner = createSpinner({ palette: NO_COLOR_PALETTE, now: time.now });
    spinner.set({ kind: "model" });
    // A counter flickering "0s" on every fast tool is noise.
    expect(spinner.tick()).not.toMatch(/\ds/);
    time.advance(2_400);
    expect(spinner.tick()).toContain("2s");
  });

  it("restarts the clock on a new activity, not on every frame", () => {
    const time = clock();
    const spinner = createSpinner({ palette: NO_COLOR_PALETTE, now: time.now });
    spinner.set({ kind: "model" });
    time.advance(5_000);
    expect(spinner.tick()).toContain("5s");

    spinner.set({ kind: "tool", label: "$ ls" });
    expect(spinner.tick()).not.toMatch(/\ds/);

    time.advance(3_000);
    spinner.set({ kind: "tool", label: "$ ls" }); // same activity: keeps counting
    expect(spinner.tick()).toContain("3s");
  });

  it("uses single-column glyphs, so the status line never wraps unexpectedly", () => {
    for (const frame of SPINNER_FRAMES) expect(charWidth(frame)).toBe(1);
  });
});
