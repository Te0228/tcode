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
import { createLiveInput } from "./ui/live-input.js";
import { createSpinner, SPINNER_INTERVAL_MS, type Activity } from "./ui/spinner.js";
import { colorEnabled, createPalette, type Palette } from "./ui/style.js";
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
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", filter);
    process.stdout.write(ENABLE_BRACKETED_PASTE);
    // Restore the terminal no matter how we leave, or every later paste in
    // that shell spills raw `[200~` markers into whatever runs next.
    process.on("exit", () => process.stdout.write(DISABLE_BRACKETED_PASTE));
  }

  const rl = readline.createInterface({
    input: readlineInput,
    output: process.stdout,
    terminal: interactive ? true : undefined,
    completer: interactive ? createCompleter(root) : undefined,
    history: interactive ? loadHistory(root) : undefined,
  });

  const PROMPT = `${palette.toolCall("›")} `;
  /** Shown while a message spans more than one line (spec §15.2). */
  const CONTINUATION_PROMPT = `${palette.meta("…")} `;

  // The input line stays on screen for the whole turn, with output
  // rendered above it (spec §3.2). Without this the prompt disappears the
  // moment work starts and typed characters land inside the streamed
  // output — input that is accepted but invisible reads as no input at all.
  const live = createLiveInput({
    write: (text) => process.stdout.write(text),
    columns: () => process.stdout.columns ?? 80,
    input: rl,
    prompt: PROMPT,
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
  const log = (line: string) => write(line.endsWith("\n") ? line : `${line}\n`);

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
        // about what is already on screen.
        live.rewritePending(textBuffer);
      }
    : write;

  // Ctrl+D / piped-stdin EOF closes readline; resolve to null so callers
  // stop instead of questioning a closed interface (spec §2).
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  // Always hands the terminal back first: readline is about to redraw its
  // own block, and it does that by moving up from where it last left the
  // cursor. Leaving a frame of ours in the way makes it erase real output.
  const ask = (question: string): Promise<string | null> =>
    new Promise((resolve) => {
      live.stop();
      if (closed) {
        resolve(null);
        return;
      }
      const onClose = () => resolve(null);
      rl.once("close", onClose);
      rl.question(question, (answer) => {
        rl.off("close", onClose);
        resolve(answer);
      });
    });

  /** `/resume` with no id, and `--resume` with no id (spec §15.6). */
  const pickSession = async (target: string) => {
    const sessions = listSessions(target);
    if (sessions.length === 0) {
      log("no sessions in this directory yet");
      return undefined;
    }
    for (const [index, entry] of sessions.entries()) {
      log(
        `  ${String(index + 1).padStart(2)}. ${formatWhen(entry.session.updatedAt)} ` +
          palette.meta(`${entry.exchanges} msgs `) +
          truncateForList(entry.firstInput || entry.session.id),
      );
    }
    const answer = await ask(`pick 1-${sessions.length} (Enter to cancel): `);
    const choice = Number(answer?.trim());
    if (!Number.isInteger(choice) || choice < 1 || choice > sessions.length) return undefined;
    return sessions[choice - 1];
  };

  const deps: AgentDeps = {
    send: createSend(providerConfig),
    approval: createApprovalPolicy({
      root,
      fullAuto: args.fullAuto,
      // Reuse the REPL's interface: a second readline on the same stdin
      // swallows the answer and hangs. EOF counts as a decline — never
      // run an unconfirmed command because input ran out.
      prompt: async (question) => {
        const answer = await ask(question);
        // The turn continues after the answer, so the input line goes back
        // up — `ask` took it down.
        live.start();
        return answer ?? "n";
      },
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
    rl.close();
    process.exit(result.outcome === "finished" || result.outcome === "no_tool_use" ? 0 : 1);
  }

  console.log(
    `${palette.strong("tcode")} · ${providerConfig.provider}/${providerConfig.model} · ${root}`,
  );
  console.log(palette.meta(`session ${session.id}${args.fullAuto ? " · --full-auto" : ""}`));

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
  console.log(
    palette.meta(
      `type any time — a message sent during a turn joins that turn\n` +
        `Esc or Ctrl+C interrupts a running turn · empty line, "exit" or Ctrl+D quits\n`,
    ),
  );

  // Input typed while a turn is running is queued for the next one, and
  // Ctrl+C interrupts that turn rather than killing the process (spec §3.2).
  const queued: string[] = [];
  let controller: AbortController | null = null;

  rl.on("line", (line) => {
    if (!controller) return; // Idle: `ask()` owns this line.
    // readline has already echoed the line and moved past it, so the frame
    // we were tracking is gone — tell the renderer before writing anything.
    live.commitLine();
    const text = line.trim();
    if (!text) return;
    queued.push(text);
    // "next step", not "after this turn": it joins the running turn as soon
    // as the current batch of tools finishes (spec §3.2).
    log(palette.meta(`⏎ queued (${queued.length}) — joins this turn at the next step`));
  });

  const onInterrupt = () => {
    // Idempotent: readline (TTY) and the process handler (pipes) can both
    // fire for one Ctrl+C, and `aborted` makes the second call a no-op.
    if (controller && !controller.signal.aborted) {
      controller.abort();
      log(palette.warn(`\n⎋ interrupted — stopping the running command (press again to quit)`));
      return;
    }
    log("");
    rl.close();
    process.exit(0);
  };

  // readline only emits SIGINT when stdin is a TTY. Without the process
  // handler, a piped stdin falls through to the default action — the
  // process dies mid-turn and the whole turn is lost, which is the exact
  // data loss this feature exists to prevent (spec §3.2).
  rl.on("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);

  // Esc is the de-facto interrupt key for this class of tool (spec §3.2).
  // Ctrl+C stays as the fallback: some terminals swallow Esc, and Esc is
  // also the prefix of ANSI escape sequences, so arrow keys travel the
  // same path.
  if (interactive) {
    readline.emitKeypressEvents(readlineInput, rl);
    readlineInput.on("keypress", (_char, key) => {
      if (!isInterruptKey(key)) return;
      // Only meaningful while a turn is running; at the prompt, Esc is
      // part of ordinary line editing.
      if (controller && !controller.signal.aborted) onInterrupt();
    });
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
        live.start();
        setActivity({ kind: "compacting" });
        try {
          if (await compactNow(session, deps, log, tracer)) saveSession(session);
        } finally {
          setActivity(null);
          live.stop();
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

  /** Prompt for the line being typed. A pasted or continued message is
   * folded into the prompt rather than echoed above it: at the idle prompt
   * readline owns that row, and printing into it lands on top of the `›`. */
  const promptFor = () =>
    draft.length === 0
      ? PROMPT
      : `${palette.meta(`[+${draft.length} line${draft.length === 1 ? "" : "s"}]`)} ${CONTINUATION_PROMPT}`;

  const refreshPrompt = () => {
    rl.setPrompt(promptFor());
    rl.prompt(true);
  };

  onPaste = (text) => {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    // The tail has no newline after it, so it is still being composed —
    // it goes into the line buffer where it can be edited before sending.
    const last = lines.pop() ?? "";
    if (lines.length > 0) {
      lines[0] = rl.line + lines[0];
      rl.write(null as never, { ctrl: true, name: "e" });
      rl.write(null as never, { ctrl: true, name: "u" });
      draft.push(...lines);
      refreshPrompt();
    }
    rl.write(last);
  };

  /** One complete user message: loops until a line neither ends with `\`
   * nor leaves a draft open. */
  const readMessage = async (): Promise<string | null> => {
    for (;;) {
      const answer = await ask(promptFor());
      if (answer === null) return null;
      if (answer.endsWith("\\")) {
        draft.push(answer.slice(0, -1));
        continue;
      }
      const message = [...draft, answer].join("\n").trim();
      draft = [];
      return message;
    }
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
      log(`${PROMPT}${palette.userInput(input)}`);
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
    live.start();
    try {
      const result = await runTurn(session, expanded.text, deps, {
        tools,
        log,
        writeText,
        palette,
        onActivity: setActivity,
        persist: saveSession,
        tracer,
        signal: controller.signal,
        // Steering (spec §3.2). Whatever is left over — queued during the
        // batch that called `finish` — falls through to the next turn via
        // the loop above.
        drainInput: () => queued.splice(0),
      });
      if (result.finish) {
        const blocked = result.finish.status === "blocked";
        const label = blocked ? palette.warn("⚠ blocked") : palette.success("✓ done");
        log(`\n${label}: ${result.finish.summary}`);
      }
      // What the user almost always does next is `git diff` or `git add`,
      // and reconstructing the list from the scrollback is busywork (§15.6).
      if (result.changedFiles.length > 0) {
        log(
          palette.meta(
            `\n${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"} changed: ` +
              result.changedFiles.join(", "),
          ),
        );
      }
      // Context usage is never a surprise: show it every turn (spec §3.1).
      log(
        palette.meta(
          `\n[context ${formatTokens(result.usage.tokens)}/${formatTokens(result.usage.contextWindowTokens)}]`,
        ) + "\n",
      );
    } catch (error) {
      // Keep the REPL alive on an API/network failure — the session is
      // still on disk and the user can retry.
      const message = error instanceof Error ? error.message : String(error);
      tracer.emit("error", { message });
      // Through `log`, not console.error: the input line is still drawn,
      // and a raw write would land inside it.
      log(palette.error(`\nturn failed: ${message}`) + "\n");
      saveSession(session);
    } finally {
      controller = null;
    }
  }

  // `history` is real and documented as an option, but absent from the
  // Interface type; readline maintains it on the instance.
  const historyOf = (): string[] => (rl as unknown as { history?: string[] }).history ?? [];
  if (interactive) saveHistory(root, historyOf(), HISTORY_MAX_ENTRIES);
  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
