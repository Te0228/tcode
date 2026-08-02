#!/usr/bin/env node
/**
 * CLI entry point (spec §2). Presentation layer only: argument parsing,
 * the readline REPL, and session load/save. All agent behavior lives in
 * `agent.ts`, so swapping this for a TUI later touches nothing else.
 */
import path from "node:path";
import readline from "node:readline";
import { runTurn, type AgentDeps } from "./agent.js";
import { createApprovalPolicy } from "./approval.js";
import { loadConfig, loadEnvFiles, userConfigDir } from "./config.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { budgetWarning, computeBudget } from "./context.js";
import { createSend, MissingApiKeyError, resolveProviderConfig } from "./llm/index.js";
import { loadMemory } from "./memory.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  createSession,
  findLatestSession,
  loadSession,
  saveSession,
  type Session,
} from "./session.js";
import { createToolRegistry } from "./tools/spawn_agent.js";
import { NOOP_TRACER, createFileTracer, tracingEnabled } from "./trace.js";
import { startViewer } from "./viewer/server.js";

interface CliArgs {
  continueLatest: boolean;
  resumeId?: string;
  fullAuto: boolean;
  /** `--view [id]`: open the read-only trace viewer (spec §13.4). */
  view?: { sessionId?: string };
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { continueLatest: false, fullAuto: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--continue" || arg === "-c") {
      args.continueLatest = true;
    } else if (arg === "--resume") {
      const id = argv[++i];
      if (!id) throw new Error("--resume requires a session id");
      args.resumeId = id;
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

  let args: CliArgs;
  let providerConfig: ReturnType<typeof resolveProviderConfig>;
  let session: Session;
  try {
    args = parseArgs(process.argv.slice(2));
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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Keeping typed input readable while the model streams (spec §3.2).
  //
  // Streamed text and the user's input share the terminal's last line, so
  // without help they interleave into "Helabcloworld". The fix: while the
  // user has something typed, hold partial output back and only emit
  // complete lines, redrawing their input underneath. When nothing is
  // typed — the normal case — output streams through untouched, so the
  // live feel is preserved.
  const isTTY = process.stdout.isTTY === true;
  let heldOutput = "";
  let midLine = false;

  const userTyping = () => isTTY && rl.line.length > 0;

  const redrawInput = () => {
    process.stdout.write(rl.line);
    readline.cursorTo(process.stdout, rl.cursor);
  };

  const emitAboveInput = (text: string) => {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(text);
    redrawInput();
  };

  const write = (text: string) => {
    if (!userTyping()) {
      if (heldOutput) {
        process.stdout.write(heldOutput);
        heldOutput = "";
      }
      process.stdout.write(text);
      midLine = !text.endsWith("\n");
      return;
    }

    // First output since they started typing: close off any partial line
    // so their input gets a line of its own.
    if (midLine) {
      process.stdout.write("\n");
      midLine = false;
      redrawInput();
    }

    heldOutput += text;
    const lastBreak = heldOutput.lastIndexOf("\n");
    if (lastBreak >= 0) {
      emitAboveInput(heldOutput.slice(0, lastBreak + 1));
      heldOutput = heldOutput.slice(lastBreak + 1);
    }
  };

  const log = (line: string) => write(line.endsWith("\n") ? line : `${line}\n`);

  // Ctrl+D / piped-stdin EOF closes readline; resolve to null so callers
  // stop instead of questioning a closed interface (spec §2).
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  const ask = (question: string): Promise<string | null> =>
    new Promise((resolve) => {
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

  const deps: AgentDeps = {
    send: createSend(providerConfig),
    approval: createApprovalPolicy({
      root,
      fullAuto: args.fullAuto,
      // Reuse the REPL's interface: a second readline on the same stdin
      // swallows the answer and hangs. EOF counts as a decline — never
      // run an unconfirmed command because input ran out.
      prompt: async (question) => (await ask(question)) ?? "n",
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

  console.log(`tcode · ${providerConfig.provider}/${providerConfig.model} · ${root}`);
  console.log(`session ${session.id}${args.fullAuto ? " · --full-auto" : ""}`);
  console.log(`Ctrl+C interrupts a running turn · empty line, "exit" or Ctrl+D quits\n`);

  // Input typed while a turn is running is queued for the next one, and
  // Ctrl+C interrupts that turn rather than killing the process (spec §3.2).
  const queued: string[] = [];
  let controller: AbortController | null = null;

  rl.on("line", (line) => {
    if (!controller) return; // Idle: `ask()` owns this line.
    const text = line.trim();
    if (!text) return;
    queued.push(text);
    // The line is consumed; flush anything held back for it.
    if (heldOutput) {
      process.stdout.write(heldOutput);
      heldOutput = "";
      midLine = false;
    }
    log(`⏎ queued (${queued.length}) — will send after this turn`);
  });

  const onInterrupt = () => {
    // Idempotent: readline (TTY) and the process handler (pipes) can both
    // fire for one Ctrl+C, and `aborted` makes the second call a no-op.
    if (controller && !controller.signal.aborted) {
      controller.abort();
      log(`\n⎋ interrupting after the current tool finishes… (Ctrl+C again to quit)`);
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

  while (true) {
    // A queued message runs without re-prompting; otherwise wait for input.
    let input = queued.shift();
    if (input === undefined) {
      const answer = await ask("› ");
      if (answer === null) break;
      input = answer.trim();
    } else {
      log(`› ${input}`);
    }
    if (!input || input === "exit" || input === "quit") break;

    controller = new AbortController();
    try {
      const result = await runTurn(session, input, deps, {
        tools,
        log,
        writeText: write,
        persist: saveSession,
        tracer,
        signal: controller.signal,
      });
      if (result.finish) {
        const label = result.finish.status === "blocked" ? "⚠ blocked" : "✓ done";
        log(`\n${label}: ${result.finish.summary}`);
      }
      // Context usage is never a surprise: show it every turn (spec §3.1).
      log(
        `\n[context ${formatTokens(result.usage.tokens)}/${formatTokens(result.usage.contextWindowTokens)}]\n`,
      );
    } catch (error) {
      // Keep the REPL alive on an API/network failure — the session is
      // still on disk and the user can retry.
      const message = error instanceof Error ? error.message : String(error);
      tracer.emit("error", { message });
      console.error(`\nturn failed: ${message}\n`);
      saveSession(session);
    } finally {
      controller = null;
    }
  }

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
