/**
 * The bottom region of the screen (spec §3.2, §16.2).
 *
 * The screen is three stacked bands:
 *
 *     …completed output, scrolled up and never touched again…
 *     <pending>    ← the current output line, still waiting for its "\n"
 *     <status>     ← spinner, present only while working
 *     <input>      ← the input box and status bar, or an overlay
 *
 * Writing output erases the bottom bands, appends to the output, and
 * redraws them. Partial lines are rendered rather than buffered: a model
 * paragraph often runs hundreds of characters without a newline, and
 * holding it back would stall the stream for seconds.
 *
 * The input band used to be readline's — one row, drawn by readline
 * itself. It is ours now (spec §16.1): several rows, supplied by whatever
 * currently owns input, with this module knowing only how many rows came
 * back and where the cursor goes inside them. That indirection is also
 * what lets an approval dialog and the input box share one erase/redraw
 * path instead of inventing a second way to draw.
 */
import { displayPos } from "./width.js";

/** What the editor or an overlay hands back to be drawn. */
export interface InputRegion {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

export interface LiveScreenOptions {
  write(text: string): void;
  /** Read lazily: the terminal can be resized mid-turn. */
  columns(): number;
  /** Called on every redraw, so the region always reflects current state. */
  renderInput(): InputRegion;
  /** Piped stdin/stdout has no screen to manage; everything degrades to a
   * plain write (spec §3.2). */
  isTTY: boolean;
}

export interface LiveScreen {
  /** Draw the input region. Idempotent. */
  start(): void;
  /** Erase it and leave the cursor on a clean row. */
  stop(): void;
  /** Agent output, complete lines or not. */
  write(text: string): void;
  /** Redraw after input state changed — a keystroke, a spinner frame. */
  refresh(): void;
  /** Transient line between output and input (spec §14.4 P2). */
  setStatus(text: string): void;
  /** Replaces the not-yet-committed output line, for markdown that can only
   * be rendered once its newline arrives (spec §14.4 P3). */
  rewritePending(text: string): void;
  isActive(): boolean;
}

const cursorToColumn = (column: number) => `\u001b[${column + 1}G`;
const cursorUp = (rows: number) => (rows > 0 ? `\u001b[${rows}A` : "");
const CLEAR_BELOW = "\u001b[0J";

export function createLiveScreen(options: LiveScreenOptions): LiveScreen {
  const { write: out, columns, renderInput, isTTY } = options;

  let active = false;
  /** Output since the last newline — redrawn every frame, never committed
   * until its newline arrives. */
  let pending = "";
  let pendingRows = 0;
  /** Spinner line, redrawn every frame and never committed to scrollback —
   * a turn would otherwise leave hundreds of dead spinner rows behind. */
  let statusText = "";
  let statusRows = 0;
  /** Where the cursor sits inside the input band, so the next erase knows
   * how far back up to travel. */
  let inputRow = 0;

  const eraseFrame = () => {
    out(`${cursorUp(inputRow + statusRows + pendingRows)}${cursorToColumn(0)}${CLEAR_BELOW}`);
  };

  const drawFrame = () => {
    const width = columns();

    if (pending) {
      out(`${pending}\n`);
      // Measure with the newline included: a line that exactly fills the
      // terminal wraps *and* takes the newline, and measuring the two
      // separately gets that case off by one.
      pendingRows = displayPos(`${pending}\n`, width).rows;
    } else {
      pendingRows = 0;
    }

    if (statusText) {
      out(`${statusText}\n`);
      statusRows = displayPos(`${statusText}\n`, width).rows;
    } else {
      statusRows = 0;
    }

    const region = renderInput();
    // Joined, not newline-terminated: the last row must not end with a
    // newline or the terminal scrolls and the cursor lands below the frame.
    out(region.lines.join("\n"));

    const lastRow = Math.max(0, region.lines.length - 1);
    const target = Math.max(0, Math.min(region.cursorRow, lastRow));
    out(cursorUp(lastRow - target));
    out(cursorToColumn(region.cursorCol));
    inputRow = target;
  };

  return {
    isActive: () => active,

    start() {
      if (!isTTY || active) return;
      active = true;
      pending = "";
      pendingRows = 0;
      statusText = "";
      statusRows = 0;
      inputRow = 0;
      drawFrame();
    },

    stop() {
      if (!active) return;
      eraseFrame();
      if (pending) {
        out(pending.endsWith("\n") ? pending : `${pending}\n`);
        pending = "";
      }
      pendingRows = 0;
      statusText = "";
      statusRows = 0;
      inputRow = 0;
      active = false;
    },

    refresh() {
      if (!isTTY || !active) return;
      eraseFrame();
      drawFrame();
    },

    write(text) {
      if (!text) return;
      if (!active) {
        out(text);
        return;
      }
      eraseFrame();
      pending += text;
      const lastBreak = pending.lastIndexOf("\n");
      if (lastBreak >= 0) {
        out(pending.slice(0, lastBreak + 1));
        pending = pending.slice(lastBreak + 1);
      }
      drawFrame();
    },

    setStatus(text) {
      if (!isTTY || !active || text === statusText) return;
      eraseFrame();
      statusText = text;
      drawFrame();
    },

    rewritePending(text) {
      if (!active) {
        out(text);
        return;
      }
      if (text === pending) return;
      eraseFrame();
      pending = text;
      drawFrame();
    },
  };
}
