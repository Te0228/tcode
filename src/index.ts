#!/usr/bin/env node
/**
 * CLI entry point (spec §2). Presentation layer only: argument parsing,
 * the readline REPL, and session load/save. All agent behavior lives in
 * `agent.ts`, so swapping this for a TUI later touches nothing else.
 */
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { compactNow, runTurn, type AgentDeps } from "./agent.js";
import { createApprovalPolicy } from "./approval.js";
import { loadConfig, loadEnvFiles, userConfigDir } from "./config.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { budgetWarning, buildSendView, computeBudget } from "./context.js";
import { alignRight } from "./ui/chrome.js";
import { createSend, MissingApiKeyError, resolveProviderConfig } from "./llm/index.js";
import { loadMemory } from "./memory.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  createSession,
  findLatestSession,
  listSessions,
  loadSession,
  saveSession,
  type Session,
} from "./session.js";
import { createToolRegistry } from "./tools/spawn_agent.js";
import { COMMANDS, parseCommand, renderHelp, unknownCommand } from "./commands.js";
import { HISTORY_MAX_ENTRIES, loadHistory, saveHistory } from "./history.js";
import { expandMentions } from "./mentions.js";
import { createCompleter } from "./ui/completer.js";
import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  createPasteFilter,
} from "./ui/paste.js";
import { createMarkdownRenderer } from "./ui/format.js";
import { isInterruptKey } from "./ui/keys.js";
import { createLiveScreen, type InputRegion } from "./ui/live-screen.js";
import { createEditor, type Key } from "./ui/editor.js";
import { createSelect } from "./ui/select.js";
import { GUTTER_WIDTH, header, rail, turnHeading } from "./ui/chrome.js";
import { createSpinner, SPINNER_INTERVAL_MS, type Activity } from "./ui/spinner.js";
import { colorEnabled, createPalette, type Palette } from "./ui/theme.js";
import { NOOP_TRACER, createFileTracer, tracingEnabled } from "./trace.js";
import { startViewer } from "./viewer/server.js";

interface CliArgs {
  continueLatest: boolean;
  resumeId?: string;
  fullAuto: boolean;
  /** `--view [id]`: open the read-only trace viewer (spec §13.4). */
  view?: { sessionId?: string };
  /** `tcode sessions`: print the list and exit (spec §4). */
  listSessions: boolean;
  /** `--resume` with no id: pick from a list instead (spec §15.6). */
  pickSession: boolean;
  /** `-p <task>`: run one turn and exit (spec §15.6). */
  print?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    continueLatest: false,
    fullAuto: false,
    listSessions: false,
    pickSession: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "sessions") {
      // A subcommand, not a flag: it doesn't modify how this run behaves,
      // it replaces the run entirely — print and exit, never reach the REPL.
      args.listSessions = true;
    } else if (arg === "--continue" || arg === "-c") {
      args.continueLatest = true;
    } else if (arg === "--resume") {
      // No id means "show me what there is" — the id is a timestamp plus a
      // random suffix, so requiring it up front made the flag unusable
      // without a separate lookup first (spec §15.6).
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) args.resumeId = argv[++i];
      else args.pickSession = true;
    } else if (arg === "-p" || arg === "--print") {
      const task = argv[++i];
      if (!task) throw new Error("-p requires a task");
      args.print = task;
    } else if (arg === "--full-auto") {
      args.fullAuto = true;
    } else if (arg === "--view") {
      // Optional positional id; a following flag is not consumed as one.
      const next = argv[i + 1];
      const sessionId = next && !next.startsWith("-") ? argv[++i] : undefined;
      args.view = { sessionId };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function resolveSession(root: string, args: CliArgs, provider: string, model: string): Session {
  if (args.resumeId) {
    // Explicit id that doesn't exist is an error, never a silent new
    // session — the user would lose track of which history they're in.
    return loadSession(root, args.resumeId);
  }

  if (args.continueLatest) {
    const latest = findLatestSession(root);
    if (latest) return latest;
    console.log("no previous session in this directory; starting a new one");
  }

  return createSession(root, provider, model);
}

/** Local time, minute precision — a session list is read at a glance, and
 * an ISO string with milliseconds is not glanceable. */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/** `tcode sessions` (spec §4): newest first, then exit. */
function runSessionList(root: string, palette: Palette): void {
  for (const line of sessionListLines(root, palette)) console.log(line);
}

/** Shared by `tcode sessions` and `/sessions` so the two can never drift. */
function sessionListLines(root: string, palette: Palette, currentId?: string): string[] {
  const sessions = listSessions(root);
  if (sessions.length === 0) return [`no sessions yet in ${root}`];

  const lines = [`${sessions.length} session${sessions.length === 1 ? "" : "s"} in ${root}`, ""];
  for (const [index, { session, firstInput, exchanges }] of sessions.entries()) {
    const marker =
      session.id === currentId
        ? palette.success(" ← current")
        : index === 0
          ? palette.meta(" ← --continue")
          : "";
    lines.push(`${formatWhen(session.updatedAt)}  ${session.id}${marker}`);
    lines.push(
      palette.meta(
        `  ${exchanges} message${exchanges === 1 ? "" : "s"} · ${session.provider}/${session.model}`,
      ),
    );
    if (firstInput) lines.push(`  ${truncateForList(firstInput)}`);
    lines.push("");
  }
  lines.push(palette.meta(`resume one with:  tcode --resume <id>   or   /resume`));
  return lines;
}

/** Completion candidates across the width of the terminal, so twenty
 * matches cost two rows instead of twenty. */
function chunkCandidates(items: string[], columns: number): string[] {
  const width = Math.max(...items.map((item) => item.length)) + 2;
  const perRow = Math.max(1, Math.floor((columns - 2) / width));
  const rows: string[] = [];
  for (let at = 0; at < items.length; at += perRow) {
    rows.push(`  ${items.slice(at, at + perRow).map((item) => item.padEnd(width)).join("")}`);
  }
  return rows;
}

/** First line only, and short: the list is an index, not a transcript. */
function truncateForList(text: string): string {
  const line = text.split("\n")[0];
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

/** `--view` path (spec §13.4): serve the trace and exit only on Ctrl+C.
 * Deliberately does not resolve a provider — viewing needs no API key. */
async function runViewer(root: string, sessionId?: string): Promise<void> {
  const session = sessionId ? loadSession(root, sessionId) : findLatestSession(root);
  if (!session) {
    console.error(`tcode: no session found in ${path.join(root, ".tcode", "sessions")}`);
    process.exit(1);
  }

  const url = await startViewer({ cwd: root, sessionId: session.id });
  console.log(`tcode viewer · session ${session.id}`);
  console.log(`${url}\n`);
  console.log(`live-updates while tcode runs in this directory; Ctrl+C to stop`);
}

async function main(): Promise<void> {
  const root = path.resolve(process.cwd());
  loadEnvFiles(root);
  const colorOptions = { isTTY: process.stdout.isTTY === true, env: process.env };
  const palette = createPalette(colorOptions);

  let args: CliArgs;
  let providerConfig: ReturnType<typeof resolveProviderConfig>;
  let session: Session;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.listSessions) {
      runSessionList(root, palette);
      return;
    }
    // A missing API key for the active provider fails here, before the
    // REPL opens (spec §8.2). A bad --resume id fails here too, rather
    // than silently starting a fresh session (spec §4).
    if (args.view) {
      await runViewer(root, args.view.sessionId);
      return;
    }
    providerConfig = resolveProviderConfig();
    session = resolveSession(root, args, providerConfig.provider, providerConfig.model);
  } catch (error) {
    console.error(`tcode: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof MissingApiKeyError) {
      // Point at the user-level config rather than leaving them to guess
      // where a globally installed CLI reads its key from (spec §8.2).
      console.error(
        `\nSet it in ${path.join(userConfigDir(), ".env")} (applies everywhere), ` +
          `or in ${path.join(root, ".env")} for this project only:\n\n` +
          `  ${error.envVar}=your-key-here\n`,
      );
    }
    process.exit(1);
  }

  const config = loadConfig();

  // A session created under another provider still replays fine — the
  // history is normalized — so this is a notice, not an error (spec §4).
  if (session.provider && session.provider !== providerConfig.provider) {
    console.log(
      `note: this session was created with ${session.provider}; continuing with ${providerConfig.provider}`,
    );
  }

  const memory = loadMemory(root, config.memoryMaxTokens);
  for (const layer of memory.layers) {
    console.log(`loaded ${layer.scope} memory from ${layer.file}`);
  }
  if (memory.truncated) {
    // Name what was dropped: "it was truncated" alone gives the user no
    // way to know what to prune (spec §9.4).
    console.log(
      `warning: memory exceeded MEMORY_MAX_TOKENS; dropped ${memory.dropped.length} oldest entr${
        memory.dropped.length === 1 ? "y" : "ies"
      }:`,
    );
    for (const entry of memory.dropped) {
      console.log(`  - (${entry.scope}) ${entry.preview}`);
    }
  }

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

  // Bracketed paste needs to see raw stdin before readline splits it into
  // lines (spec §15.1), so readline reads from a stream we feed instead of
  // from stdin directly. Piped input keeps the old wiring untouched: there
  // is no terminal to negotiate with, and the simpler path is the one that
  // has to keep working in CI.
  const readlineInput = interactive ? new PassThrough() : process.stdin;
  let onPaste: (text: string) => void = () => {};
  if (interactive) {
    const passthrough = readlineInput as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    passthrough.isTTY = true;
    passthrough.setRawMode = (mode: boolean) => process.stdin.setRawMode(mode);

    const filter = createPasteFilter({
      onData: (chunk) => passthrough.write(chunk),
      onPaste: (text) => onPaste(text),
    });
    // Raw mode used to come free with `readline.createInterface`. Owning
    // input means owning this too: without it the terminal echoes every
    // keystroke itself and buffers until Enter, so the editor's rendering
    // and the terminal's echo both write to the same rows.
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", filter);
    process.stdout.write(ENABLE_BRACKETED_PASTE);
    // Restore the terminal no matter how we leave, or every later paste in
    // that shell spills raw `[200~` markers into whatever runs next.
    process.on("exit", () => {
      process.stdout.write(DISABLE_BRACKETED_PASTE);
      // Leaving the terminal in raw mode makes the user's shell unusable
      // afterwards — no echo, no line editing, no Ctrl+C.
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    });
  }

  // `|| 80`, not `?? 80`: a terminal that has not reported its size yet
  // gives 0, and 0 would be taken as a real (absurdly narrow) width — the
  // first frame renders unboxed, the next one boxed, and the erase
  // arithmetic between them is off by the rows the box added.
  const columns = () => process.stdout.columns || 80;

  // Input is ours now (spec §16.1): buffer, cursor, history, completion and
  // the prompt loop. readline's key *parser* stays — it turns bytes into
  // `{name, ctrl, meta}` and owns nothing — but its Interface is gone, and
  // with it the cursor handoff, the `prevRows` bookkeeping and the need to
  // route paste around it.
  const editor = createEditor({
    palette,
    columns,
    complete: interactive ? createCompleter(root) : undefined,
    history: interactive ? loadHistory(root) : undefined,
    status: () => ({
      left: `${providerConfig.model} · ${formatTokens(contextTokens)}/${formatTokens(providerConfig.contextWindowTokens)}`,
      hints: turnRunning ? ["esc stop", "⏎ queue"] : ["⏎ send", "/help"],
    }),
  });

  /** Whatever currently owns the keyboard: the editor, or an overlay such
   * as the approval dialog. One key entry point, never two — two parallel
   * input paths is what produced the paste data loss in §15.1. */
  let overlay: { handleKey(char: string | undefined, key: Key): unknown; render(): InputRegion } | null =
    null;

  let contextTokens = 0;
  let turnRunning = false;

  const live = createLiveScreen({
    write: (text) => process.stdout.write(text),
    columns,
    renderInput: () => (overlay ? overlay.render() : editor.render()),
    isTTY: interactive,
  });

  const spinner = createSpinner({ palette });
  let spinnerTimer: NodeJS.Timeout | undefined;
  const setActivity = (activity: Activity | null) => {
    spinner.set(activity);
    if (activity === null) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
      live.setStatus("");
      return;
    }
    live.setStatus(spinner.tick());
    if (spinnerTimer) return;
    // `unref` so a stray timer can never hold the process open at exit.
    spinnerTimer = setInterval(() => live.setStatus(spinner.tick()), SPINNER_INTERVAL_MS);
    spinnerTimer.unref();
  };

  const write = (text: string) => live.write(text);
  /** Every line inside a turn hangs off the rail (spec §17.3), so nothing
   * indents on its own and a turn reads as one block. */
  const bodyRail = () => rail("body", palette, colored);
  const log = (line: string) => write(`${bodyRail()}${line}\n`);
  /** Outside a turn — headings and the blank lines between turns. */
  const logBare = (line: string) => write(`${line}\n`);

  let turnIndex = (session.messages ?? []).filter((message) =>
    message.content.some((block) => block.type === "text" && message.role === "user"),
  ).length;

  const clock = () => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  };

  const heading = (role: "you" | "tcode", detail: string) =>
    logBare(turnHeading({ index: turnIndex, role, detail }, layoutWidth(), palette, colored));

  // Assistant text, rendered a line at a time (spec §14.4 P3). Half a line
  // still streams out immediately — §3.2 wins on that — and is swapped for
  // the rendered version once its newline arrives.
  //
  // Only when colour is on. With it off, rendering would strip the `**` and
  // backticks and put nothing in their place, quietly editing the model's
  // words on the way into a pipe.
  const markdown = createMarkdownRenderer(palette);
  let textBuffer = "";
  const writeText = colorEnabled(colorOptions)
    ? (chunk: string) => {
        textBuffer += chunk;
        let breakAt = textBuffer.indexOf("\n");
        while (breakAt >= 0) {
          const line = textBuffer.slice(0, breakAt);
          textBuffer = textBuffer.slice(breakAt + 1);
          live.rewritePending("");
          log(markdown.render(line));
          breakAt = textBuffer.indexOf("\n");
        }
        // Pending always mirrors the buffer, so the two can never disagree
        // about what is already on screen — and it hangs off the rail like
        // every other line inside a turn (spec §17.3).
        live.rewritePending(textBuffer ? `${bodyRail()}${textBuffer}` : "");
      }
    : write;

  let closed = false;

  /** Resolves the pending `readMessage()`; null while a turn is running,
   * in which case a submitted line is queued for steering instead. */
  let awaitingMessage: ((text: string | null) => void) | null = null;

  const quit = () => {
    if (closed) return;
    closed = true;
    awaitingMessage?.(null);
    awaitingMessage = null;
  };

  const deliver = (text: string) => {
    if (!text) {
      // An empty submit at the prompt is how you leave (spec §2).
      if (awaitingMessage) quit();
      return;
    }
    if (awaitingMessage) {
      const resolve = awaitingMessage;
      awaitingMessage = null;
      turnIndex += 1;
      heading("you", clock());
      for (const line of text.split("\n")) log(palette.userInput(line));
      resolve(text);
      return;
    }
    queued.push(text);
    for (const line of text.split("\n")) log(palette.userInput(line));
    log(palette.meta(`queued (${queued.length}) — joins this turn at the next step`));
  };

  const readMessage = (): Promise<string | null> =>
    new Promise((resolve) => {
      if (closed) {
        resolve(null);
        return;
      }
      awaitingMessage = resolve;
      live.refresh();
    });

  /** One keyboard entry point, dispatched by whoever currently owns input
   * (spec §16.7). Two parallel paths is what produced the §15.1 data loss. */
  const onKey = (char: string | undefined, key: Key) => {
    if (overlay) {
      overlay.handleKey(char, key);
      live.refresh();
      return;
    }

    const action = editor.handleKey(char, key);
    switch (action.type) {
      case "submit":
        deliver(action.text);
        break;
      case "interrupt":
        onInterrupt(false);
        break;
      case "cancel":
        onInterrupt(true);
        break;
      case "eof":
        quit();
        break;
      case "candidates":
        for (const group of chunkCandidates(action.items, columns())) log(palette.meta(group));
        break;
    }
    live.refresh();
  };

  /**
   * A choice overlay (spec §16.6). Resolves on a single keypress — no
   * letter to type, no Enter to confirm unless the user wants the
   * highlighted option.
   */
  const choose = <T,>(config: {
    title: string;
    subject?: string;
    detail?: string;
    options: { label: string; value: T; shortcut?: string }[];
    cancelValue: T;
  }): Promise<T> =>
    new Promise((resolve) => {
      if (!interactive) {
        resolve(config.cancelValue);
        return;
      }
      const select = createSelect({ ...config, palette, columns });
      overlay = {
        handleKey: (char, key) => {
          const action = select.handleKey(char, key);
          if (action.type === "chosen") {
            overlay = null;
            resolve(action.value);
          }
          return action;
        },
        render: () => select.render(),
      };
      live.refresh();
    });

  /** `/resume` with no id, and `--resume` with no id (spec §15.6). Same
   * overlay as the approval dialog: picking from a list should not require
   * typing a number either. */
  const pickSession = async (target: string) => {
    const sessions = listSessions(target);
    if (sessions.length === 0) {
      log("no sessions in this directory yet");
      return undefined;
    }
    const chosen = await choose<number>({
      title: "resume which session?",
      options: [
        ...sessions.slice(0, 9).map((entry, at) => ({
          label: `${formatWhen(entry.session.updatedAt)}  ${entry.exchanges} msgs  ${truncateForList(
            entry.firstInput || entry.session.id,
          )}`,
          value: at,
        })),
        { label: "cancel", value: -1 },
      ],
      cancelValue: -1,
    });
    return chosen >= 0 ? sessions[chosen] : undefined;
  };

  const deps: AgentDeps = {
    send: createSend(providerConfig),
    approval: createApprovalPolicy({
      root,
      fullAuto: args.fullAuto,
      // Reuse the REPL's interface: a second readline on the same stdin
      // swallows the answer and hangs. EOF counts as a decline — never
      // run an unconfirmed command because input ran out.
      // A single keypress, not a typed letter plus Enter (spec §16.6).
      ask: async ({ command, reason }: { command: string; reason: string }) =>
        choose<"yes" | "always" | "no">({
          title: "run this command?",
          subject: `$ ${command}`,
          detail: reason,
          options: [
            { label: "yes", value: "yes", shortcut: "y" },
            { label: "yes, and don't ask again this session", value: "always", shortcut: "a" },
            { label: "no", value: "no", shortcut: "n" },
          ],
          cancelValue: "no",
        }),
    }),
    config,
    root,
    systemPrompt: buildSystemPrompt({ root, memory, fullAuto: args.fullAuto }),
    contextWindowTokens: providerConfig.contextWindowTokens,
  };
  const tools = createToolRegistry(deps);

  // Trace is the data source for `tcode --view` (spec §13). It appends to
  // one file per session, so --continue keeps everything in one place.
  const tracer = tracingEnabled()
    ? createFileTracer({ cwd: root, sessionId: session.id })
    : NOOP_TRACER;
  tracer.emit("session_start", {
    provider: providerConfig.provider,
    model: providerConfig.model,
    root,
    fullAuto: args.fullAuto,
    contextWindowTokens: providerConfig.contextWindowTokens,
    sessionId: session.id,
  });

  // Validate the budget once, at startup, before the user has typed
  // anything — a silently-zero budget looks like a dumb model (spec §3.1).
  const budgetInputs = {
    contextWindowTokens: providerConfig.contextWindowTokens,
    compactThreshold: config.compactThreshold,
    reservedOutputTokens: config.reservedOutputTokens,
    compactKeepRecent: config.compactKeepRecent,
    systemPromptTokens: estimateTokens(deps.systemPrompt),
  };
  for (const line of budgetWarning(
    computeBudget(budgetInputs),
    budgetInputs,
    config.minUsableHistoryTokens,
    memory.tokens,
  )) {
    console.log(line);
  }

  if (args.pickSession) {
    const chosen = await pickSession(root);
    if (chosen) session = chosen.session;
    else console.log("keeping the new session");
  }

  // `-p` is a scripted, non-interactive run (spec §15.6): one turn, then
  // exit. It prints the transcript plainly — no live frame, no spinner —
  // because its output is meant to be piped somewhere.
  if (args.print !== undefined) {
    const expanded = expandMentions(args.print, root, config.maxOutputChars);
    const result = await runTurn(session, expanded.text, deps, {
      tools,
      log: (line) => process.stdout.write(`${line}\n`),
      writeText: (chunk) => process.stdout.write(chunk),
      persist: saveSession,
      tracer,
    });
    if (result.finish) process.stdout.write(`\n${result.finish.summary}\n`);
      process.exit(result.outcome === "finished" || result.outcome === "no_tool_use" ? 0 : 1);
  }

  const layoutWidth = () => Math.min(100, Math.max(20, columns() - 1));
  const colored = colorEnabled(colorOptions);
  console.log(
    header(
      {
        model: `${providerConfig.provider}/${providerConfig.model}`,
        root,
        session: session.id,
        fullAuto: args.fullAuto,
      },
      layoutWidth(),
      palette,
      colored,
    ),
  );
  console.log("");

  // Starting fresh on top of existing history is the one case worth a nudge
  // (spec §4). Resuming works fine; nobody could tell it was there, so every
  // restart quietly began from zero.
  if (!args.continueLatest && !args.resumeId) {
    const previous = listSessions(root).find((entry) => entry.session.id !== session.id);
    if (previous) {
      console.log(
        palette.meta(
          `\n${previous.exchanges} message${previous.exchanges === 1 ? "" : "s"} of history here ` +
            `from ${formatWhen(previous.session.updatedAt)} — this session starts empty.\n` +
            `  tcode --continue   resume it        tcode sessions   list all`,
        ),
      );
    }
  }
  // Hints live in the status bar now; repeating them here would be noise.
  // The input box is drawn for the whole session, not just during a turn:
  // it is the thing the user looks at, and a prompt that appears and
  // disappears is what made the old REPL read as unfinished (spec §16.2).
  live.start();

  // The empty state is the one hint that belongs in the scrollback: a fresh
  // session has no conversation above the input at all, so a blank wall
  // gives the user no idea what this tool even is (spec §17.4). The phrase
  // mirrors the status bar's `/help`, and hangs off the body rail so it
  // reads as a suggestion to act rather than a stray line.
  if (interactive && turnIndex === 0) {
    log(palette.meta(`try \`fix the failing test\` — or type \`/help\` to see commands`));
    logBare("");
  }

  // Input typed while a turn is running is queued for the next one, and
  // Ctrl+C interrupts that turn rather than killing the process (spec §3.2).
  const queued: string[] = [];
  let controller: AbortController | null = null;

  /**
   * Esc and Ctrl+C both stop a running turn. At the prompt they differ:
   * Esc clears what is typed, Ctrl+C clears it and then — on a second
   * press, with nothing left to lose — quits. Neither may throw away typed
   * text and exit in the same keystroke.
   */
  const onInterrupt = (hard: boolean) => {
    if (controller && !controller.signal.aborted) {
      controller.abort();
      log(palette.warn(`⎋ interrupted — stopping the running command`));
      return;
    }
    if (editor.line.length > 0 || editor.draftLines.length > 0) {
      editor.reset();
      live.refresh();
      return;
    }
    if (hard) quit();
  };

  // readline only emits SIGINT when stdin is a TTY. Without the process
  // handler, a piped stdin falls through to the default action — the
  // process dies mid-turn and the whole turn is lost, which is the exact
  // data loss this feature exists to prevent (spec §3.2).
  process.on("SIGINT", () => onInterrupt(true));

  // Esc is the de-facto interrupt key for this class of tool (spec §3.2).
  // Ctrl+C stays as the fallback: some terminals swallow Esc, and Esc is
  // also the prefix of ANSI escape sequences, so arrow keys travel the
  // same path.
  if (interactive) {
    // The parser only — it turns bytes into named keys and owns nothing.
    readline.emitKeypressEvents(readlineInput);
    readlineInput.on("keypress", onKey);
  }


  /**
   * Slash commands (spec §15.3). They talk to the CLI, so none of them ever
   * enters `session.messages` — the model is not part of this exchange.
   */
  const runCommand = async (command: { name: string; args: string }): Promise<"ok" | "exit"> => {
    switch (command.name) {
      case "help":
        for (const line of renderHelp(palette)) log(line);
        return "ok";

      case "exit":
        return "exit";

      case "model":
        log(`${providerConfig.provider}/${providerConfig.model}`);
        log(
          palette.meta(
            `  switch with PROVIDER=<name> when starting tcode; see ${path.join(userConfigDir(), ".env")}`,
          ),
        );
        return "ok";

      case "sessions": {
        for (const line of sessionListLines(root, palette, session.id)) log(line);
        return "ok";
      }

      case "new": {
        session = createSession(root, providerConfig.provider, providerConfig.model);
        log(palette.success(`✓ new session ${session.id}`));
        return "ok";
      }

      case "resume": {
        const target = command.args
          ? listSessions(root).find((entry) => entry.session.id === command.args)
          : await pickSession(root);
        if (!target) {
          if (command.args) log(palette.error(`no session with id ${command.args}`));
          return "ok";
        }
        session = target.session;
        log(
          palette.success(`✓ resumed ${session.id}`) +
            palette.meta(` · ${target.exchanges} messages`),
        );
        return "ok";
      }

      case "compact": {
        setActivity({ kind: "compacting" });
        try {
          if (await compactNow(session, deps, log, tracer)) saveSession(session);
        } finally {
          setActivity(null);
        }
        return "ok";
      }

      case "context": {
        const systemPromptTokens = estimateTokens(deps.systemPrompt);
        const inputs = {
          contextWindowTokens: providerConfig.contextWindowTokens,
          compactThreshold: config.compactThreshold,
          reservedOutputTokens: config.reservedOutputTokens,
          compactKeepRecent: config.compactKeepRecent,
          systemPromptTokens,
        };
        const view = buildSendView(session, computeBudget(inputs));
        log(palette.strong("context"));
        for (const [label, value] of [
          ["window", formatTokens(providerConfig.contextWindowTokens)],
          ["system prompt", formatTokens(systemPromptTokens)],
          ["  of which memory", formatTokens(memory.tokens)],
          ["history (as sent)", formatTokens(view.tokens)],
          ["reserved for reply", formatTokens(config.reservedOutputTokens)],
          ["messages", `${session.messages.length}`],
          ["detail level", view.level],
          ["compactions", `${(session.compactions ?? []).length}`],
        ] as [string, string][]) {
          log(`  ${label.padEnd(18)} ${palette.meta(value)}`);
        }
        log("");
        return "ok";
      }

      default:
        for (const line of unknownCommand(command.name, palette)) log(line);
        return "ok";
    }
  };

  // A message can span several lines: `\` continues, and a bracketed paste
  // arrives whole (spec §15.1/§15.2). `draft` holds the lines already
  // committed to the current message.
  let draft: string[] = [];

  onPaste = (text) => {
    editor.paste(text);
    live.refresh();
  };

  while (true) {
    // A queued message runs without re-prompting; otherwise wait for input.
    let input = queued.shift();
    if (input === undefined) {
      const answer = await readMessage();
      if (answer === null) break;
      input = answer;
    } else {
      // Still inside the previous turn's frame, so this echo renders above
      // the input line like any other output.
      log(`${palette.accent("›")} ${palette.userInput(input)}`);
    }
    if (!input) break;

    const command = parseCommand(input);
    if (command) {
      const outcome = await runCommand(command);
      if (outcome === "exit") break;
      continue;
    }

    // `@path` attaches files to the message the model receives; the
    // terminal only shows one folded line each (spec §15.4).
    const expanded = expandMentions(input, root, config.maxOutputChars);
    for (const attachment of expanded.attachments) {
      log(
        palette.meta(
          `  @${attachment.path} (${attachment.lines} lines${attachment.truncated ? ", truncated" : ""})`,
        ),
      );
    }
    for (const failure of expanded.failures) {
      log(palette.error(`  @${failure.path} — ${failure.reason}`));
    }

    controller = new AbortController();
    turnRunning = true;
    const startedAt = Date.now();
    logBare("");
    heading("tcode", clock());
    try {
      const result = await runTurn(session, expanded.text, deps, {
        tools,
        log,
        writeText,
        palette,
        contentWidth: () => layoutWidth() - GUTTER_WIDTH,
        onActivity: setActivity,
        persist: saveSession,
        tracer,
        signal: controller.signal,
        // Steering (spec §3.2). Whatever is left over — queued during the
        // batch that called `finish` — falls through to the next turn via
        // the loop above.
        drainInput: () => queued.splice(0),
      });
      const elapsed = `${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s`;
      if (result.finish) {
        const blocked = result.finish.status === "blocked";
        const mark = blocked ? palette.warn("⚠") : palette.success("✓");
        log("");
        log(
          alignRight(
            `${mark} ${result.finish.summary}`,
            palette.meta(`${clock()} · ${elapsed}`),
            layoutWidth() - GUTTER_WIDTH,
          ),
        );
      } else if (result.outcome === "interrupted") {
        log(palette.warn("⎋ interrupted"));
      }
      // What the user almost always does next is `git diff` or `git add`,
      // and reconstructing the list from the scrollback is busywork (§15.6).
      if (result.changedFiles.length > 0) {
        log(
          palette.meta(
            `${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"} changed: ` +
              result.changedFiles.join(", "),
          ),
        );
      }
      // The status bar carries context usage permanently now (spec §16.2);
      // announcing it again every turn would be repeating what is on screen.
      contextTokens = result.usage.tokens;
      logBare("");
    } catch (error) {
      // Keep the REPL alive on an API/network failure — the session is
      // still on disk and the user can retry.
      const message = error instanceof Error ? error.message : String(error);
      tracer.emit("error", { message });
      // Through `log`, not console.error: the input line is still drawn,
      // and a raw write would land inside it.
      log(palette.error(`turn failed: ${message}`));
      logBare("");
      saveSession(session);
    } finally {
      controller = null;
      turnRunning = false;
      live.refresh();
    }
  }

  live.stop();
  if (interactive) saveHistory(root, editor.snapshotHistory(), HISTORY_MAX_ENTRIES);

  // Owning stdin means owning its shutdown: a resumed raw-mode stdin with a
  // `data` listener keeps the event loop alive forever, so the process
  // would sit there after the REPL had already finished. `rl.close()` used
  // to do this.
  if (interactive) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
