/**
 * The input line that stays visible while a turn runs (spec §3.2).
 *
 * The first version merely *accepted* input during a turn: keystrokes were
 * queued and replayed correctly, but the prompt vanished the moment the
 * turn started and typed characters landed in the middle of the streamed
 * output. The feature worked and looked broken, which is the same thing as
 * not having it — the user's report was "there's no input box, I can't
 * type".
 *
 * So the screen is treated as two stacked regions:
 *
 *     …completed output, scrolled up and never touched again…
 *     <pending>    ← the current output line, still waiting for its "\n"
 *     › <input>    ← drawn by readline, always the last thing on screen
 *
 * Writing output erases the bottom two regions, appends to the output, and
 * redraws them. Partial lines are rendered rather than buffered: a model
 * paragraph often runs hundreds of characters without a newline, and
 * holding it back would stall the stream for seconds.
 *
 * The input region belongs to readline — it redraws that block on every
 * keystroke, and reimplementing line editing to avoid it would be far
 * worse. This module only guarantees that readline's block is always the
 * last block, and matches readline's own wrap arithmetic (see `width.ts`)
 * so the two agree on how many rows to erase.
 */
import { displayPos } from "./width.js";

/** The slice of `readline.Interface` this needs — narrow enough to fake in
 * tests, since none of this can be exercised without a terminal. */
export interface InputLineState {
  readonly line: string;
  setPrompt(prompt: string): void;
  /** Cursor position relative to the start of the prompt. Public readline
   * API, and it uses readline's internal wrap math — so it is the
   * authority on where inside its block the cursor sits. */
  getCursorPos(): { rows: number; cols: number };
}

export interface LiveInputOptions {
  write(text: string): void;
  /** Read lazily: the terminal can be resized mid-turn. */
  columns(): number;
  input: InputLineState;
  prompt: string;
  /** Piped stdin/stdout has no screen to manage; everything degrades to a
   * plain write (spec §3.2). */
  isTTY: boolean;
}

export interface LiveInput {
  /** Turn begins: draw the input line. Idempotent. */
  start(): void;
  /** Hand the terminal back before prompting the user. */
  stop(): void;
  /** Agent output, complete lines or not. */
  write(text: string): void;
  /** Enter was pressed mid-turn: readline committed its block and moved
   * below it, so the frame we were tracking no longer exists. */
  commitLine(): void;
  /** Transient line between output and input — the spinner (spec §14.4 P2).
   * Empty string removes it. Redraws immediately, so a timer can drive it. */
  setStatus(text: string): void;
  /** Replaces the not-yet-committed output line. Markdown needs this: the
   * raw fragment is shown as it streams, then swapped for the rendered
   * line once its newline arrives (spec §14.4 P3). */
  rewritePending(text: string): void;
  isActive(): boolean;
}

const cursorToColumn = (column: number) => `[${column + 1}G`;
const cursorUp = (rows: number) => (rows > 0 ? `[${rows}A` : "");
const CLEAR_BELOW = "[0J";

export function createLiveInput(options: LiveInputOptions): LiveInput {
  const { write: out, columns, input, prompt, isTTY } = options;

  let active = false;
  /** Output since the last newline — redrawn every frame, never committed
   * until its newline arrives. */
  let pending = "";
  /** Rows the pending region occupied last time it was drawn. */
  let pendingRows = 0;
  /** Spinner line, redrawn every frame and never committed to scrollback —
   * a turn would otherwise leave hundreds of dead spinner rows behind. */
  let statusText = "";
  let statusRows = 0;

  /** Move to the top-left of the frame and wipe everything below it. */
  const eraseFrame = () => {
    const up = input.getCursorPos().rows + pendingRows + statusRows;
    out(`${cursorUp(up)}${cursorToColumn(0)}${CLEAR_BELOW}`);
  };

  const drawFrame = () => {
    const width = columns();

    if (pending) {
      out(`${pending}\n`);
      // Count the trailing newline as part of the measurement: a line that
      // exactly fills the terminal wraps *and* takes the newline, and
      // measuring the two separately gets that case off by one.
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

    const full = prompt + input.line;
    out(full);
    // readline's own quirk, mirrored: a line ending exactly on the right
    // edge leaves the terminal in deferred-wrap limbo, so a space forces
    // it onto the next row before the cursor is positioned.
    const end = displayPos(full, width);
    if (end.cols === 0) out(" ");

    const cursor = input.getCursorPos();
    out(cursorToColumn(cursor.cols));
    out(cursorUp(end.rows - cursor.rows));
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
      input.setPrompt(prompt);
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
      // The spinner is transient by definition: it must not survive into
      // the scrollback the user scrolls back through.
      statusText = "";
      statusRows = 0;
      // Redraw the input block before letting go. readline erases its own
      // block by moving up from where it believes the cursor is; leaving
      // that block missing would make its next redraw eat a row of real
      // output instead.
      const full = prompt + input.line;
      out(full);
      const cursor = input.getCursorPos();
      out(cursorToColumn(cursor.cols));
      active = false;
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

    commitLine() {
      if (!active) return;
      // readline echoed the input block and moved below it, stranding the
      // pending region above. Its text is already on screen and correct,
      // so adopt it as a finished line rather than redrawing it lower down
      // and showing the user the same words twice. The only visible cost
      // is a line break where they pressed Enter.
      pending = "";
      pendingRows = 0;
      statusRows = 0;
    },
  };
}
