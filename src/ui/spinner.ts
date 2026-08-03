/**
 * The "something is happening" indicator (spec §14.4 P2).
 *
 * The gap it fills: between `$ npm test` and the next line there was
 * nothing at all, for as long as the command took. Waiting on the network,
 * running a command, and hung look identical when all three render as an
 * empty screen — and they need different reactions from the user, so the
 * one that matters (`Esc`) never gets pressed at the right moment.
 *
 * Pure state plus a formatter; the caller owns the timer and the drawing.
 */
import type { Palette } from "./theme.js";

/** Braille dots: one cell wide everywhere, and the convention every tool in
 * this class already uses. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const SPINNER_INTERVAL_MS = 80;

/**
 * What the agent is doing. The distinction is the point: waiting on a model
 * and running a tool differ by an order of magnitude in normal duration, so
 * collapsing them into one "working" state throws away the only clue the
 * user has for judging whether something is stuck.
 */
export type Activity =
  | { kind: "model" }
  | { kind: "tool"; label: string }
  | { kind: "compacting" };

export interface Spinner {
  /** Sets what is happening; `null` clears the line. Resets the elapsed
   * clock on a change of activity, not on every frame. */
  set(activity: Activity | null): void;
  /** Advances one frame and returns the line to draw, or `""` when idle. */
  tick(): string;
}

export interface SpinnerOptions {
  palette: Palette;
  /** Injected so the elapsed counter is testable without real time. */
  now?: () => number;
}

function describe(activity: Activity): string {
  switch (activity.kind) {
    case "model":
      return "thinking";
    case "compacting":
      return "compacting context";
    default:
      return activity.label;
  }
}

export function createSpinner({ palette, now = Date.now }: SpinnerOptions): Spinner {
  let activity: Activity | null = null;
  let startedAt = 0;
  let frame = 0;

  return {
    set(next) {
      const changed =
        next === null ||
        activity === null ||
        next.kind !== activity.kind ||
        describe(next) !== describe(activity);
      if (changed) {
        startedAt = now();
        frame = 0;
      }
      activity = next;
    },

    tick() {
      if (!activity) return "";
      const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      frame++;
      const seconds = Math.floor((now() - startedAt) / 1000);
      // Only after a second: a counter that flickers 0s on every fast tool
      // is noise, and the elapsed time only starts meaning something once
      // the wait is long enough to notice.
      const elapsed = seconds >= 1 ? ` ${seconds}s` : "";
      return palette.meta(`${glyph} ${describe(activity)}${elapsed}`);
    },
  };
}
