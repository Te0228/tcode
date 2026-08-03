/**
 * The line editor (spec §16.4).
 *
 * `readline.Interface` is replaced here — buffer, cursor, history,
 * completion and the prompt loop are all ours now. Drawing a box around
 * the input is impossible otherwise: readline owns its row and will not
 * share it.
 *
 * Key *parsing* still comes from `readline.emitKeypressEvents`, which is a
 * pure byte-stream-to-`{name, ctrl, meta}` decoder and not an owner of
 * anything. Rewriting that would only mean stepping on the same escape
 * sequence traps again (see `keys.ts`).
 *
 * Nothing here writes to the terminal. `render()` returns the lines the
 * input region should contain plus where the cursor belongs inside them;
 * `live-input.ts` does the erasing and drawing. That keeps the whole editor
 * testable without a terminal, which matters because every bug this file
 * can have is invisible except to a human staring at one.
 */
import { displayWidth, sliceByWidth } from "./width.js";
import {
  GUTTER_WIDTH,
  MAX_BOX_WIDTH,
  alignRight,
  padTo,
  rail,
  tintedRow,
} from "./chrome.js";
import { NO_COLOR_PALETTE, type Palette } from "./theme.js";

export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export type EditorAction =
  | { type: "none" }
  /** A complete message; `text` already includes any continuation lines. */
  | { type: "submit"; text: string }
  /** Esc — stop what is running; at the prompt, clear the line. */
  | { type: "interrupt" }
  /** Ctrl+C — stop, then clear, then quit. Never quits in one press while
   * there is something typed that would be lost. */
  | { type: "cancel" }
  /** Ctrl+D on an empty buffer, or Ctrl+C twice. */
  | { type: "eof" }
  /** Tab produced several candidates; the caller prints them. */
  | { type: "candidates"; items: string[] };

export interface EditorOptions {
  palette: Palette;
  /** Read lazily — the terminal can be resized mid-session. */
  columns(): number;
  /** Tab completion (spec §15.4). */
  complete?(line: string): [string[], string];
  /** Slash commands, for the menu that opens on `/` (spec §17.5b). Same
   * data as `/help`; two copies would drift. */
  commands?: { name: string; summary: string }[];
  /** Seed from disk, newest first (spec §15.5). */
  history?: string[];
  /** Right-hand hints in the status bar; recomputed on every render so
   * they can follow what the agent is doing. */
  status?(): { left: string; hints: string[] };
}

export interface RenderedInput {
  lines: string[];
  /** Cursor position within `lines`. */
  cursorRow: number;
  cursorCol: number;
}

const WORD_BOUNDARY = /\s/;

export function createEditor(options: EditorOptions) {
  const { palette } = options;

  let buffer = "";
  let cursor = 0;
  /** Lines already committed to this message by `\` or a paste. */
  let draft: string[] = [];

  const history: string[] = [...(options.history ?? [])];
  /** -1 means "editing a fresh line"; otherwise an index into `history`. */
  let historyIndex = -1;
  /** What was being typed before the user started walking history, so
   * pressing ↓ back past the end restores it instead of clearing. */
  let historyStash = "";

  const clampCursor = () => {
    cursor = Math.max(0, Math.min(cursor, buffer.length));
  };

  /** Which position in the command menu is highlighted; the menu is open
   * whenever `matchingCommands()` is non-empty. */
  let menuIndex = 0;

  /**
   * Commands matching what has been typed so far. Open only while the line
   * is a bare `/word` — once there is a space the user is writing
   * arguments, and a menu on top of that is in the way.
   */
  const matchingCommands = () => {
    if (!options.commands) return [];
    const match = /^\/([a-zA-Z-]*)$/.exec(buffer);
    if (!match) return [];
    const typed = match[1].toLowerCase();
    return options.commands.filter((command) => command.name.startsWith(typed));
  };

  const wordLeft = (): number => {
    let index = cursor;
    while (index > 0 && WORD_BOUNDARY.test(buffer[index - 1])) index--;
    while (index > 0 && !WORD_BOUNDARY.test(buffer[index - 1])) index--;
    return index;
  };

  const wordRight = (): number => {
    let index = cursor;
    while (index < buffer.length && WORD_BOUNDARY.test(buffer[index])) index++;
    while (index < buffer.length && !WORD_BOUNDARY.test(buffer[index])) index++;
    return index;
  };

  const setLine = (text: string) => {
    buffer = text;
    cursor = text.length;
  };

  const insert = (text: string) => {
    // Control characters in pasted or typed input would corrupt the render
    // arithmetic; a tab is a legitimate character but not one a single-line
    // editor can place, so it becomes a space.
    const clean = text.replace(/\t/g, " ").replace(/[\u0000-\u001f\u007f]/g, "");
    buffer = buffer.slice(0, cursor) + clean + buffer.slice(cursor);
    cursor += clean.length;
    historyIndex = -1;
  };

  const takeMessage = (): string => {
    const text = [...draft, buffer].join("\n").trim();
    draft = [];
    buffer = "";
    cursor = 0;
    historyIndex = -1;
    return text;
  };

  const remember = (text: string) => {
    if (!text.trim()) return;
    if (history[0] === text) return;
    history.unshift(text);
  };

  const walkHistory = (delta: number) => {
    if (history.length === 0) return;
    if (historyIndex === -1) historyStash = buffer;
    const next = historyIndex + delta;
    if (next < -1) return;
    if (next >= history.length) return;
    historyIndex = next;
    setLine(next === -1 ? historyStash : history[next]);
  };

  const applyCompletion = (): EditorAction => {
    if (!options.complete) return { type: "none" };
    const [candidates, token] = options.complete(buffer.slice(0, cursor));
    if (candidates.length === 0) return { type: "none" };

    if (candidates.length === 1) {
      const replaced = buffer.slice(0, cursor - token.length) + candidates[0];
      const tail = buffer.slice(cursor);
      buffer = replaced + tail;
      cursor = replaced.length;
      return { type: "none" };
    }

    // Several matches: extend as far as they agree, then show the list.
    // Extending first means Tab is never a no-op when it could have made
    // progress.
    const shared = commonPrefix(candidates);
    if (shared.length > token.length) {
      const replaced = buffer.slice(0, cursor - token.length) + shared;
      const tail = buffer.slice(cursor);
      buffer = replaced + tail;
      cursor = replaced.length;
    }
    return { type: "candidates", items: candidates };
  };

  return {
    get line() {
      return buffer;
    },
    get cursor() {
      return cursor;
    },
    get draftLines() {
      return [...draft];
    },
    get historyEntries() {
      return [...history];
    },

    setLine,
    insert,
    reset() {
      buffer = "";
      cursor = 0;
      draft = [];
      historyIndex = -1;
    },

    /** A paste (spec §15.1). Every line but the last joins the message;
     * the last stays editable, because it has no newline after it and so
     * was not finished by the user. */
    paste(text: string) {
      const lines = text.replace(/\r\n?/g, "\n").split("\n");
      const last = lines.pop() ?? "";
      if (lines.length > 0) {
        lines[0] = buffer.slice(0, cursor) + lines[0];
        const tail = buffer.slice(cursor);
        draft.push(...lines);
        buffer = tail;
        cursor = 0;
      }
      insert(last);
    },

    handleKey(char: string | undefined, key: Key): EditorAction {
      const name = key.name ?? "";

      if (key.ctrl) {
        switch (name) {
          case "c":
            return { type: "cancel" };
          case "d":
            return buffer.length === 0 && draft.length === 0
              ? { type: "eof" }
              : deleteRight();
          case "a":
            cursor = 0;
            return { type: "none" };
          case "e":
            cursor = buffer.length;
            return { type: "none" };
          case "u":
            buffer = buffer.slice(cursor);
            cursor = 0;
            return { type: "none" };
          case "k":
            buffer = buffer.slice(0, cursor);
            return { type: "none" };
          case "w": {
            const start = wordLeft();
            buffer = buffer.slice(0, start) + buffer.slice(cursor);
            cursor = start;
            return { type: "none" };
          }
          case "l":
            return { type: "none" };
          default:
            return { type: "none" };
        }
      }

      if (key.meta && (name === "left" || name === "b")) {
        cursor = wordLeft();
        return { type: "none" };
      }
      if (key.meta && (name === "right" || name === "f")) {
        cursor = wordRight();
        return { type: "none" };
      }

      switch (name) {
        case "escape":
          return { type: "interrupt" };
        case "return":
        case "enter": {
          // Backslash continuation (spec §15.2): shell muscle memory, and
          // unlike Alt+Enter it survives terminals that never forward the
          // modifier.
          if (buffer.endsWith("\\")) {
            draft.push(buffer.slice(0, -1));
            buffer = "";
            cursor = 0;
            return { type: "none" };
          }
          // Enter on an open menu runs the highlighted command rather than
          // whatever prefix happens to be typed.
          const open = matchingCommands();
          if (open.length > 0) {
            const picked = `/${open[Math.min(menuIndex, open.length - 1)].name}`;
            setLine(picked);
            menuIndex = 0;
          }
          const text = [...draft, buffer].join("\n").trim();
          remember(text);
          takeMessage();
          return { type: "submit", text };
        }
        case "tab": {
          const open = matchingCommands();
          if (open.length > 0) {
            setLine(`/${open[Math.min(menuIndex, open.length - 1)].name} `);
            menuIndex = 0;
            return { type: "none" };
          }
          return applyCompletion();
        }
        case "backspace":
          if (cursor > 0) {
            buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
            cursor--;
          } else if (draft.length > 0) {
            // Backspacing off the start of a continuation line pulls the
            // previous one back for editing, instead of doing nothing.
            buffer = draft.pop() ?? "";
            cursor = buffer.length;
          }
          return { type: "none" };
        case "delete":
          return deleteRight();
        case "left":
          cursor = Math.max(0, cursor - 1);
          return { type: "none" };
        case "right":
          cursor = Math.min(buffer.length, cursor + 1);
          return { type: "none" };
        case "home":
          cursor = 0;
          return { type: "none" };
        case "end":
          cursor = buffer.length;
          return { type: "none" };
        case "up": {
          // The menu takes the arrows while it is open; history gets them
          // back the moment it closes.
          const open = matchingCommands();
          if (open.length > 0) {
            menuIndex = (menuIndex - 1 + open.length) % open.length;
            return { type: "none" };
          }
          walkHistory(1);
          return { type: "none" };
        }
        case "down": {
          const open = matchingCommands();
          if (open.length > 0) {
            menuIndex = (menuIndex + 1) % open.length;
            return { type: "none" };
          }
          walkHistory(-1);
          return { type: "none" };
        }
        default:
          if (char && !key.ctrl && !key.meta) insert(char);
          return { type: "none" };
      }

      function deleteRight(): EditorAction {
        if (cursor < buffer.length) {
          buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
        }
        return { type: "none" };
      }
    },

    /**
     * The input region: the box, its contents, and the status bar. Returns
     * the cursor's position inside it rather than moving anything — the
     * caller owns the screen.
     */
    render(): RenderedInput {
      clampCursor();
      const columns = options.columns();
      const width = Math.min(MAX_BOX_WIDTH, Math.max(20, columns - 1));
      const status = options.status?.();
      const colored = palette !== NO_COLOR_PALETTE;

      // A rail, not a box (spec §17.1): a box would collide with the modal
      // dialogs, where a box means "deal with this now". The rail says
      // instead that this belongs to the same conversation above it.
      const marker =
        draft.length > 0
          ? palette.meta(`[+${draft.length} line${draft.length === 1 ? "" : "s"}] `)
          : "";
      const markerWidth = displayWidth(marker);
      const prefix = `${rail("head", palette, colored)}${palette.accent("›")} `;
      const before = GUTTER_WIDTH + 2 + markerWidth;

      const available = Math.max(1, width - before);
      const typed = displayWidth(buffer.slice(0, cursor));
      const scroll = Math.max(0, typed - available + 1);
      const visible = sliceByWidth(buffer, scroll, available);

      const lines: string[] = [];

      // The menu floats above the input line: typing `/` has to produce
      // something visible, or the commands may as well not exist (§17.5b).
      const open = matchingCommands();
      if (open.length > 0) {
        menuIndex = Math.min(menuIndex, open.length - 1);
        const nameWidth = Math.max(...open.map((command) => command.name.length)) + 1;
        for (const [at, command] of open.entries()) {
          const label = `  /${command.name}`.padEnd(nameWidth + 3);
          const row = `${label}  ${command.summary}`;
          lines.push(
            at === menuIndex
              ? tintedRow(palette.accent2(row), width, palette.selectedRow)
              : palette.meta(row),
          );
        }
      }

      lines.push(`${prefix}${marker}${visible}`);
      const inputRow = lines.length - 1;
      if (status) {
        lines.push(
          tintedRow(
            alignRight(`  ${status.left}`, `${status.hints.join("  ")}  `, width),
            width,
            palette.statusRow,
          ),
        );
      }

      return {
        lines,
        cursorRow: inputRow,
        cursorCol: before + typed - scroll,
      };
    },

    /** Everything typed this session plus what was loaded, newest first —
     * what gets written back to disk (spec §15.5). */
    snapshotHistory(): string[] {
      return [...history];
    },
  };
}

export type Editor = ReturnType<typeof createEditor>;

function commonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index++;
    prefix = prefix.slice(0, index);
  }
  return prefix;
}

/** Re-exported so callers do not need `chrome.ts` just to pad a line. */
export { padTo };
