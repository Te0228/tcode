#!/usr/bin/env node
/**
 * CLI entry point (spec §2). Presentation layer only: argument parsing,
 * the readline REPL, and session load/save. All agent behavior lives in
 * `agent.ts`, so swapping this for a TUI later touches nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { compactNow, runTurn, summaryLineOf, type AgentDeps } from "./agent.js";
import { createApprovalPolicy } from "./approval.js";
import { loadConfig, loadEnvFiles, userConfigDir } from "./config.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { budgetWarning, buildSendView, computeBudget } from "./context.js";
import { createSend, MissingApiKeyError, PROVIDERS, resolveProviderConfig } from "./llm/index.js";
import { executor } from "./executor.js";
import { resolveInRoot } from "./security.js";
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
import { header, shortenPath, turnHeading } from "./ui/chrome.js";
import { createTranscript } from "./ui/transcript.js";
import { createSpinner, SPINNER_INTERVAL_MS, type Activity } from "./ui/spinner.js";
import { colorEnabled, colorLevel, createPalette, type Palette } from "./ui/theme.js";
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
    commands: COMMANDS,
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
  const startedSession = Date.now();
  /** Files this session is known to have written, for `/diff` outside a git
   * repo where there is no baseline to compare against. */
  const changedThisSession = new Set<string>();
  /** Enough to put the last turn back (spec §17.5c). One turn only. */
  let lastUndo: { path: string; previous: string | null }[] = [];

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
  const layoutWidth = () => Math.min(100, Math.max(20, columns() - 1));
  const colored = colorEnabled(colorOptions);

  // One renderer owns the whole transcript (spec §17.6): the rail, the
  // gutter, markdown, tints. Nothing else formats a line.
  const view = createTranscript({
    palette,
    colored,
    width: layoutWidth,
    write,
    rewritePending: (text) => live.rewritePending(text),
    renderMarkdown: colored,
  });

  const log = (text: string) => view.note(text);

  // A turn is a message the *user* sent on their own. Steering folds a text
  // block into the tool_result message (spec §3.2) and an interrupt appends
  // a note, both with role "user" — counting those inflated the number by
  // half on a long session.
  let turnIndex = session.messages.filter(
    (message) =>
      message.role === "user" && message.content.every((block) => block.type === "text"),
  ).length;

  const clock = () => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  };

  const heading = (role: "you" | "tcode", detail: string) =>
    view.heading(turnHeading({ index: turnIndex, role, detail }, layoutWidth(), palette, colored));

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
      for (const part of text.split("\n")) log(palette.userInput(part));
      resolve(text);
      return;
    }
    queued.push(text);
    for (const part of text.split("\n")) log(palette.userInput(part));
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
      onEvent: (event) => {
        if (event.type === "text") process.stdout.write(event.chunk);
        else if (event.type === "tool_end") process.stdout.write(`${summaryLineOf(event.toolUse)}\n`);
        else if (event.type === "notice") process.stdout.write(`${event.text}\n`);
      },
      persist: saveSession,
      tracer,
    });
    if (result.finish) process.stdout.write(`\n${result.finish.summary}\n`);
      process.exit(result.outcome === "finished" || result.outcome === "no_tool_use" ? 0 : 1);
  }

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
    view.blank();
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
        for (const entry of renderHelp(palette)) log(entry);
        return "ok";

      case "exit":
      case "quit":
        return "exit";

      case "clear":
        // The screen, not the history: scrollback is the audit record
        // (spec §16.1), so this clears the view and nothing else.
        process.stdout.write("\u001b[2J\u001b[H");
        live.refresh();
        return "ok";

      case "status": {
        const uptime = Math.round((Date.now() - startedSession) / 1000);
        for (const [label, value] of [
          ["provider", `${providerConfig.provider}/${providerConfig.model}`],
          ["project", shortenPath(root)],
          ["session", `${session.id} · ${session.messages.length} messages`],
          ["running", `${Math.floor(uptime / 60)}m ${uptime % 60}s`],
          ["memory", memory.layers.length ? memory.layers.map((l) => l.scope).join(", ") : "none"],
          ["approvals", args.fullAuto ? "full-auto (never asks)" : "asks before writing outside the project"],
          ["colour", colorLevel(colorOptions)],
        ] as [string, string][]) {
          log(`  ${label.padEnd(10)} ${palette.meta(value)}`);
        }
        return "ok";
      }

      case "model": {
        if (!command.args) {
          log(`${providerConfig.provider}/${providerConfig.model}`);
          log(palette.meta(`  available: ${Object.keys(PROVIDERS).join(", ")}`));
          log(palette.meta(`  switch with:  /model <provider>`));
          return "ok";
        }
        try {
          // A real switch, not a printout: otherwise changing model still
          // means quitting and editing the environment (spec §17.5c).
          const next = resolveProviderConfig({ ...process.env, PROVIDER: command.args });
          providerConfig = next;
          deps.send = createSend(next);
          deps.contextWindowTokens = next.contextWindowTokens;
          log(palette.success(`✓ now using ${next.provider}/${next.model}`));
          log(palette.meta("  the history carries over — it is stored normalized, not per-provider"));
        } catch (error) {
          log(palette.error(error instanceof Error ? error.message : String(error)));
        }
        return "ok";
      }

      case "tools": {
        for (const tool of Object.values(tools)) {
          log(`  ${palette.accent2(tool.schema.name.padEnd(12))} ${palette.meta(firstSentence(tool.schema.description))}`);
        }
        return "ok";
      }

      case "approvals": {
        log(
          args.fullAuto
            ? palette.warn("full-auto — nothing is confirmed")
            : "asks before: writing outside the project, sudo, system commands, git push",
        );
        log(palette.meta("  reading anything, and writing inside the project, never ask"));
        log(palette.meta("  start with --full-auto to skip all confirmation"));
        return "ok";
      }

      case "memory": {
        if (memory.layers.length === 0) {
          log("no AGENTS.md loaded");
          log(palette.meta(`  /init writes one for this project`));
          return "ok";
        }
        for (const layer of memory.layers) {
          log(`${palette.accent2(layer.scope)}  ${palette.meta(layer.file)}`);
          for (const entry of layer.content.trim().split("\n").slice(0, 8)) {
            log(palette.meta(`  ${entry}`));
          }
        }
        log(palette.meta(`  ${formatTokens(memory.tokens)} of the system prompt`));
        return "ok";
      }

      case "diff": {
        const result = await executor.run(
          "git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git diff --stat && git diff",
          { cwd: root, timeoutMs: config.commandTimeoutMs },
        );
        if (result.exitCode !== 0) {
          // Not a git repo: fall back to what this session is known to have
          // touched, which is all we can say without a baseline.
          if (changedThisSession.size === 0) log("nothing changed yet in this session");
          else for (const file of changedThisSession) log(`  ${file}`);
          return "ok";
        }
        const body = result.stdout.trim();
        if (!body) log("working tree is clean");
        else for (const entry of body.split("\n").slice(0, 60)) log(palette.meta(entry));
        return "ok";
      }

      case "undo": {
        if (lastUndo.length === 0) {
          log("nothing to undo — no files changed in the last turn");
          return "ok";
        }
        for (const entry of lastUndo) {
          try {
            const target = resolveInRoot(root, entry.path);
            if (entry.previous === null) fs.rmSync(target, { force: true });
            else fs.writeFileSync(target, entry.previous);
            log(palette.success(`✓ ${entry.previous === null ? "removed" : "restored"} ${entry.path}`));
          } catch (error) {
            log(palette.error(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
        lastUndo = [];
        log(palette.meta("  the model still believes it made those changes; tell it what you undid"));
        return "ok";
      }

      case "retry": {
        const previous = [...session.messages]
          .reverse()
          .find((message) => message.role === "user" && message.content.every((b) => b.type === "text"));
        const text = previous?.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        if (!text) {
          log("nothing to retry yet");
          return "ok";
        }
        queued.push(text);
        log(palette.meta(`resending: ${truncateForList(text)}`));
        return "ok";
      }

      case "view": {
        const url = await startViewer({ cwd: root, sessionId: session.id });
        log(`${palette.accent2(url)}`);
        log(palette.meta("  live while tcode runs here"));
        return "ok";
      }

      case "export": {
        const target = path.resolve(root, command.args || `tcode-${session.id}.md`);
        try {
          fs.writeFileSync(target, renderTranscriptMarkdown(session));
          log(palette.success(`✓ ${path.relative(root, target)}`));
        } catch (error) {
          log(palette.error(error instanceof Error ? error.message : String(error)));
        }
        return "ok";
      }

      case "init": {
        queued.push(
          "Look at this project — its layout, language, build and test commands, and any " +
            "conventions you can infer — then write a concise AGENTS.md at the project root " +
            "describing what a coding agent needs to know to work here. Keep it short and " +
            "specific; no filler. Then finish.",
        );
        log(palette.meta("scanning the project to write AGENTS.md…"));
        return "ok";
      }

      case "sessions": {
        for (const entry of sessionListLines(root, palette, session.id)) log(entry);
        return "ok";
      }

      case "new": {
        session = createSession(root, providerConfig.provider, providerConfig.model);
        turnIndex = 0;
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
        turnIndex = target.exchanges;
        log(
          palette.success(`✓ resumed ${session.id}`) +
            palette.meta(` · ${target.exchanges} messages`),
        );
        return "ok";
      }

      case "compact": {
        setActivity({ kind: "compacting" });
        try {
          if (await compactNow(session, deps, (_level, text) => log(text), tracer)) {
            saveSession(session);
          }
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
        const sendView = buildSendView(session, computeBudget(inputs));
        for (const [label, value] of [
          ["window", formatTokens(providerConfig.contextWindowTokens)],
          ["system prompt", formatTokens(systemPromptTokens)],
          ["  of which memory", formatTokens(memory.tokens)],
          ["history (as sent)", formatTokens(sendView.tokens)],
          ["reserved for reply", formatTokens(config.reservedOutputTokens)],
          ["messages", `${session.messages.length}`],
          ["detail level", sendView.level],
          ["compactions", `${(session.compactions ?? []).length}`],
        ] as [string, string][]) {
          log(`  ${label.padEnd(18)} ${palette.meta(value)}`);
        }
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
    view.blank();
    heading("tcode", clock());
    try {
      const result = await runTurn(session, expanded.text, deps, {
        tools,
        onEvent: (event) => view.event(event),
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
        view.outcome(`${mark} ${result.finish.summary}`, `${clock()} · ${elapsed}`);
      } else if (result.outcome === "interrupted") {
        view.outcome(palette.warn("⎋ interrupted"), `${clock()} · ${elapsed}`);
      }
      // What the user almost always does next is `git diff` or `git add`,
      // and reconstructing the list from the scrollback is busywork (§15.6).
      lastUndo = result.undo;
      for (const file of result.changedFiles) changedThisSession.add(file);
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
      view.blank();
    } catch (error) {
      // Keep the REPL alive on an API/network failure — the session is
      // still on disk and the user can retry.
      const message = error instanceof Error ? error.message : String(error);
      tracer.emit("error", { message });
      // Through `log`, not console.error: the input line is still drawn,
      // and a raw write would land inside it.
      log(palette.error(`turn failed: ${message}`));
      view.blank();
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

/** First sentence of a tool description — the schema text is written for
 * the model and runs long. */
function firstSentence(text: string): string {
  const stop = text.indexOf(". ");
  return stop === -1 ? text : text.slice(0, stop + 1);
}

/** The session as markdown, for `/export` (spec §17.5c). Sessions are JSON
 * because that is what replays; this is what a person pastes elsewhere. */
function renderTranscriptMarkdown(session: Session): string {
  const parts = [`# tcode session ${session.id}`, "", `${session.provider}/${session.model}`, ""];
  for (const message of session.messages) {
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const tools = message.content.filter((block) => block.type === "tool_use");
    if (message.role === "user" && text) parts.push(`## you`, "", text, "");
    else if (message.role === "assistant" && (text || tools.length)) {
      parts.push(`## tcode`, "");
      if (text) parts.push(text, "");
      for (const tool of tools) {
        if (tool.type !== "tool_use") continue;
        parts.push("```", `${tool.name} ${JSON.stringify(tool.input)}`, "```", "");
      }
    }
  }
  return parts.join("\n");
}
