/**
 * Bracketed paste (spec §15.1).
 *
 * This exists because of a data-loss bug, not for convenience. Pasting five
 * lines delivered only the first to the model; readline split the single
 * data event into five `line` events, the first started a turn, and the
 * other four arrived while the turn was still starting up and were dropped
 * on the floor with no message. Silently discarding what the user typed is
 * the worst failure mode a REPL has.
 *
 * The fix has to come from the terminal, because only the terminal knows
 * the difference between "the user pressed Enter" and "the user pasted text
 * that happens to contain a newline". With bracketed paste enabled it wraps
 * pasted content in markers, and those newlines can be kept as content
 * instead of being read as five separate submissions.
 */

/** Sent on startup; the terminal starts wrapping pastes in markers. */
export const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
/** Sent on exit. Leaving it on would make every later paste in that shell
 * dump raw `[200~` markers into whatever runs next. */
export const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";

const START = "\u001b[200~";
const END = "\u001b[201~";

export interface PasteFilterHandlers {
  /** Ordinary keystrokes, forwarded to readline unchanged. */
  onData(chunk: string): void;
  /** One complete paste, markers stripped, newlines intact. */
  onPaste(text: string): void;
}

/**
 * Splits a raw stdin stream into keystrokes and pastes.
 *
 * Stateful across calls: the markers are six bytes and a paste of any size
 * can be delivered in arbitrary chunks, so both the markers themselves and
 * the content between them may be split anywhere.
 */
export function createPasteFilter(handlers: PasteFilterHandlers): (chunk: string) => void {
  let buffer = "";
  let pasting = false;

  /** Longest proper prefix of `marker` that `text` ends with — the part
   * that must be held back in case the rest arrives next chunk. */
  const danglingPrefix = (text: string, marker: string): number => {
    const max = Math.min(text.length, marker.length - 1);
    for (let length = max; length > 0; length--) {
      if (text.endsWith(marker.slice(0, length))) return length;
    }
    return 0;
  };

  return (chunk: string) => {
    buffer += chunk;

    for (;;) {
      if (!pasting) {
        const start = buffer.indexOf(START);
        if (start === -1) {
          // Hold back anything that might be the beginning of a marker.
          const held = danglingPrefix(buffer, START);
          const emit = buffer.slice(0, buffer.length - held);
          buffer = buffer.slice(buffer.length - held);
          if (emit) handlers.onData(emit);
          return;
        }
        if (start > 0) handlers.onData(buffer.slice(0, start));
        buffer = buffer.slice(start + START.length);
        pasting = true;
        continue;
      }

      const end = buffer.indexOf(END);
      if (end === -1) return; // Mid-paste: keep buffering, emit nothing.
      handlers.onPaste(buffer.slice(0, end));
      buffer = buffer.slice(end + END.length);
      pasting = false;
    }
  };
}
