/**
 * The agent turn loop (spec §3). Depends only on the normalized types
 * from `llm/` — it never learns which provider is behind `send`. Every
 * collaborator (send / approval / tools / persistence / output) is
 * injected so the loop scenarios in spec §12.2 can be tested without a
 * network or a TTY.
 */
import type { Config } from "./config.js";
import type { ApprovalPolicy } from "./approval.js";
import type {
  ContentBlock,
  Message,
  SendFn,
  ToolResultBlock,
  ToolUseBlock,
} from "./llm/types.js";
import { toolUseBlocksOf } from "./llm/types.js";
import {
  COMPACTION_SYSTEM_PROMPT,
  buildSendView,
  computeBudget,
  renderForSummary,
  type Budget,
} from "./context.js";
import { saveSession, type Session } from "./session.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { NOOP_TRACER, type Tracer } from "./trace.js";
import { FINISH_TOOL_NAME, finishPayloadOf, type FinishPayload } from "./tools/finish.js";
import { BASE_TOOLS, type ToolRegistry } from "./tools/index.js";
import { truncateOutput } from "./tools/types.js";

export interface AgentDeps {
  send: SendFn;
  approval: ApprovalPolicy;
  config: Config;
  /** Project root, handed to every tool for path scoping (spec §6). */
  root: string;
  systemPrompt: string;
  /** Active model's context window, for budgeting (spec §3.1/§8.2). */
  contextWindowTokens: number;
}

export interface RunTurnOptions {
  /** Overrides the default tool set — this is how `spawn_agent` hands a
   * subagent a trimmed registry without `spawn_agent` in it (spec §5.6). */
  tools?: ToolRegistry;
  /** One-line status sink; subagents pass a prefixing logger (spec §5.6). */
  log?: (line: string) => void;
  /** Raw sink for streamed assistant text — deltas are fragments, not
   * lines, so they must not go through `log` (spec §3/§8.1). */
  writeText?: (chunk: string) => void;
  /** Persistence hook; subagents pass a no-op so throwaway histories
   * don't litter `.tcode/sessions/` (spec §5.6). */
  persist?: (session: Session) => void;
  /** Event log (spec §13). Subagents get `tracer.child()` so their steps
   * land in the same file one level deeper. */
  tracer?: Tracer;
}

export type TurnOutcome = "finished" | "no_tool_use" | "max_iterations";

export interface TurnResult {
  outcome: TurnOutcome;
  /** Payload of the `finish` call that ended the turn, when there was one. */
  finish?: FinishPayload;
  /** Last assistant text of the turn — the fallback summary for a
   * subagent that never called `finish` (spec §5.6). */
  lastText: string;
  /** Context usage of the last request, for the REPL's status line. */
  usage: { tokens: number; contextWindowTokens: number };
}

/** One-line "what the agent is doing now" summary (spec §3). */
export function summaryLineOf(toolUse: ToolUseBlock): string {
  const input = (toolUse.input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");

  switch (toolUse.name) {
    case "bash":
      return `$ ${str("command")}`;
    case "read_file":
      return `⋮ read ${str("path")}`;
    case "edit_file":
      return `✎ edit ${str("path")}`;
    case "write_file":
      return `✎ write ${str("path")}`;
    case "remember":
      return `✎ remember (${str("scope") || "project"})`;
    case "finish":
      return `✓ finish (${str("status") || "done"})`;
    case "spawn_agent":
      return `⇢ spawn_agent [${str("role") || "general"}] ${str("task")}`;
    default:
      return `· ${toolUse.name}`;
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Summarizes `messages[0, cutIndex)` and records it on the session
 * (spec §3.1). The messages themselves are never removed — the summary
 * is a cache that lets `buildSendView` skip them.
 *
 * A failure here must not kill the user's turn: the caller falls back to
 * the omit-only view.
 */
async function compact(
  session: Session,
  cutIndex: number,
  tokensBefore: number,
  deps: AgentDeps,
  status: (line: string) => void,
  tracer: Tracer,
): Promise<boolean> {
  const transcript = renderForSummary(session.messages.slice(0, cutIndex));
  status(`⋯ compacting ${cutIndex} earlier messages to free context`);

  try {
    const response = await deps.send(
      [{ role: "user", content: [{ type: "text", text: transcript }] }],
      [],
      COMPACTION_SYSTEM_PROMPT,
    );
    const summary = response.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!summary) throw new Error("summarizer returned no text");

    session.compactions = [
      ...(session.compactions ?? []),
      { upToIndex: cutIndex, summary, tokensBefore, createdAt: new Date().toISOString() },
    ];
    tracer.emit("compaction", { upToIndex: cutIndex, tokensBefore, ok: true, summary });
    return true;
  } catch (error) {
    tracer.emit("compaction", { upToIndex: cutIndex, tokensBefore, ok: false, error: errorMessageOf(error) });
    status(`⚠ compaction failed (${errorMessageOf(error)}); continuing with omitted tool output`);
    return false;
  }
}

async function executeToolUse(
  toolUse: ToolUseBlock,
  tools: ToolRegistry,
  deps: AgentDeps,
  log: (line: string) => void,
  tracer: Tracer,
): Promise<ToolResultBlock> {
  const tool = tools[toolUse.name];
  if (!tool) {
    // Reachable when the model calls a tool trimmed out of this agent's
    // registry (e.g. `edit_file` inside an `explore` subagent, spec §5.6).
    return {
      type: "tool_result",
      toolUseId: toolUse.id,
      content: `unknown tool "${toolUse.name}"; available tools: ${Object.keys(tools).join(", ")}`,
      isError: true,
    };
  }

  const startedAt = Date.now();
  try {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    const output = await tool.execute(input, {
      root: deps.root,
      config: deps.config,
      log,
      tracer,
    });
    const content = truncateOutput(output, deps.config.maxOutputChars);
    tracer.emit("tool_result", {
      id: toolUse.id,
      name: toolUse.name,
      ok: true,
      durationMs: Date.now() - startedAt,
      content,
    });
    return { type: "tool_result", toolUseId: toolUse.id, content, isError: false };
  } catch (error) {
    // Tool failures are fed back to the model as is_error so it can retry
    // or change approach — they never crash the turn (spec §3).
    const content = truncateOutput(errorMessageOf(error), deps.config.maxOutputChars);
    tracer.emit("tool_result", {
      id: toolUse.id,
      name: toolUse.name,
      ok: false,
      durationMs: Date.now() - startedAt,
      content,
    });
    return { type: "tool_result", toolUseId: toolUse.id, content, isError: true };
  }
}

export async function runTurn(
  session: Session,
  userInput: string,
  deps: AgentDeps,
  options: RunTurnOptions = {},
): Promise<TurnResult> {
  const tools = options.tools ?? BASE_TOOLS;
  const log = options.log ?? ((line: string) => console.log(line));
  const persist = options.persist ?? saveSession;
  const tracer = options.tracer ?? NOOP_TRACER;
  const turnStartedAt = Date.now();

  // Streamed text has no trailing newline of its own; remember whether we
  // left the cursor mid-line so status lines start cleanly.
  let textOpen = false;
  const writeText =
    options.writeText ?? ((chunk: string) => process.stdout.write(chunk));
  const stream = (chunk: string) => {
    if (chunk) textOpen = true;
    writeText(chunk);
  };
  const status = (line: string) => {
    if (textOpen) {
      writeText("\n");
      textOpen = false;
    }
    log(line);
  };

  session.messages.push({ role: "user", content: [{ type: "text", text: userInput }] });
  tracer.emit("turn_start", { input: userInput });

  const budget: Budget = computeBudget({
    contextWindowTokens: deps.contextWindowTokens,
    compactThreshold: deps.config.compactThreshold,
    reservedOutputTokens: deps.config.reservedOutputTokens,
    compactKeepRecent: deps.config.compactKeepRecent,
    systemPromptTokens: estimateTokens(deps.systemPrompt),
  });

  let outcome: TurnOutcome = "max_iterations";
  let finish: FinishPayload | undefined;
  let lastText = "";
  let lastViewTokens = 0;
  let announcedOmission = false;

  for (let iteration = 0; iteration < deps.config.maxToolIterations; iteration++) {
    // Build the view fresh each round: session.messages is the untouched
    // truth, this is only what we send (spec §3.1).
    let view = buildSendView(session, budget);

    if (view.needsCompaction && view.suggestedCutIndex !== undefined) {
      const compacted = await compact(
        session,
        view.suggestedCutIndex,
        view.tokens,
        deps,
        status,
        tracer,
      );
      if (compacted) {
        view = buildSendView(session, budget);
        status(`⋯ context now ${formatTokens(view.tokens)}/${formatTokens(budget.contextWindowTokens)}`);
      }
    } else if (view.level === "omitted" && !announcedOmission) {
      tracer.emit("context_omitted", { tokens: view.tokens, budget: budget.historyTokens });
      status("⋯ older tool output omitted from this request to stay within context");
      announcedOmission = true;
    }

    lastViewTokens = view.tokens;

    tracer.emit("request_start", {
      iteration,
      viewLevel: view.level,
      tokens: view.tokens,
      messageCount: view.messages.length,
    });
    const requestStartedAt = Date.now();

    const response = await deps.send(
      view.messages,
      Object.values(tools).map((tool) => tool.schema),
      deps.systemPrompt,
      { onTextDelta: stream },
    );

    session.messages.push({ role: "assistant", content: response.content });

    const text = response.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.trim()) lastText = text;

    const toolUses = toolUseBlocksOf(response);
    tracer.emit("request_end", {
      durationMs: Date.now() - requestStartedAt,
      stopReason: response.stopReason,
      textLength: text.length,
      toolCount: toolUses.length,
    });
    if (text.trim()) tracer.emit("assistant_text", { text });

    if (toolUses.length === 0) {
      outcome = "no_tool_use";
      break;
    }

    // Serial, in the order the model asked for — never concurrent, so two
    // writes in one batch can't race each other (spec §3).
    const results: ToolResultBlock[] = [];
    for (const toolUse of toolUses) {
      status(summaryLineOf(toolUse));
      tracer.emit("tool_call", { id: toolUse.id, name: toolUse.name, input: toolUse.input });

      if (deps.approval.needsConfirmation(toolUse)) {
        const approved = await deps.approval.confirm(toolUse);
        tracer.emit("approval", {
          id: toolUse.id,
          name: toolUse.name,
          decision: approved ? "approved" : "declined",
        });
        if (!approved) {
          // A decline is reported back as an error result, not silently
          // skipped — otherwise the model can't tell it didn't run (spec §3).
          results.push({
            type: "tool_result",
            toolUseId: toolUse.id,
            content: "user declined to run this tool",
            isError: true,
          });
          continue;
        }
      }

      results.push(await executeToolUse(toolUse, tools, deps, log, tracer));
    }

    // Close the history BEFORE deciding whether to break. A response can
    // mix `finish` with other tool_uses; breaking early would leave a
    // dangling tool_use that makes the next `--continue` fail (spec §3).
    session.messages.push({ role: "user", content: results });

    const finishUse = toolUses.find((toolUse) => toolUse.name === FINISH_TOOL_NAME);
    if (finishUse) {
      outcome = "finished";
      finish = finishPayloadOf(finishUse.input);
      break;
    }
  }

  if (outcome === "max_iterations") {
    status(
      `⚠ stopped after ${deps.config.maxToolIterations} tool iterations without finishing. ` +
        `Send another message to continue.`,
    );
  } else if (textOpen) {
    writeText("\n");
  }

  // session.messages is saved complete and untrimmed — the only thing
  // context management writes back is the compaction cache (spec §3.1).
  persist(session);

  const usage = { tokens: lastViewTokens, contextWindowTokens: budget.contextWindowTokens };
  tracer.emit("turn_end", {
    outcome,
    durationMs: Date.now() - turnStartedAt,
    usage,
    ...(finish ? { finish } : {}),
  });

  return { outcome, finish, lastText, usage };
}
