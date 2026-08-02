/**
 * Context window management (spec §3.1).
 *
 * The invariant this module exists to protect: `session.messages` is the
 * complete, never-destroyed truth. Everything here produces a *view* to
 * send to the model. Nothing in this file mutates the session.
 */
import type { Message, ToolResultBlock } from "./llm/types.js";
import type { Compaction, Session } from "./session.js";
import { estimateMessagesTokens, estimateTokens } from "./tokens.js";

export interface Budget {
  /** Tokens available for conversation history. */
  historyTokens: number;
  /** Full model window, for reporting usage to the user. */
  contextWindowTokens: number;
  /** Keep at least this many recent messages verbatim. */
  keepRecent: number;
}

export interface BudgetInputs {
  contextWindowTokens: number;
  compactThreshold: number;
  reservedOutputTokens: number;
  compactKeepRecent: number;
  systemPromptTokens: number;
}

export function computeBudget(options: BudgetInputs): Budget {
  const usable = options.contextWindowTokens * options.compactThreshold;
  return {
    historyTokens: Math.max(
      0,
      Math.floor(usable - options.reservedOutputTokens - options.systemPromptTokens),
    ),
    contextWindowTokens: options.contextWindowTokens,
    keepRecent: options.compactKeepRecent,
  };
}

/**
 * Explains an unusably small history budget (spec §3.1). Returns the
 * lines to print, or an empty array when the budget is fine.
 *
 * The whole point is showing every term of the arithmetic: a bare "your
 * budget is 0" leaves the user with no idea which knob to turn.
 */
export function budgetWarning(
  budget: Budget,
  inputs: BudgetInputs,
  minUsableHistoryTokens: number,
  memoryTokens = 0,
): string[] {
  if (budget.historyTokens >= minUsableHistoryTokens) return [];

  const usable = Math.floor(inputs.contextWindowTokens * inputs.compactThreshold);
  const lines = [
    budget.historyTokens === 0
      ? `warning: no context left for conversation history — every request will be maximally degraded.`
      : `warning: only ${budget.historyTokens} tokens left for conversation history (below ${minUsableHistoryTokens}).`,
    `  context window            ${inputs.contextWindowTokens}`,
    `  × COMPACT_THRESHOLD ${inputs.compactThreshold}   = ${usable}`,
    `  − RESERVED_OUTPUT_TOKENS  ${inputs.reservedOutputTokens}`,
    `  − system prompt           ${inputs.systemPromptTokens}${
      memoryTokens > 0 ? ` (of which memory: ${memoryTokens})` : ""
    }`,
    `  = history budget          ${budget.historyTokens}`,
  ];

  // Point at the biggest lever rather than making them work it out.
  if (inputs.reservedOutputTokens >= usable / 2) {
    lines.push(`  → RESERVED_OUTPUT_TOKENS is eating most of the window; lower it.`);
  } else if (memoryTokens >= usable / 4) {
    lines.push(`  → memory is eating a large share; lower MEMORY_MAX_TOKENS or prune AGENTS.md.`);
  } else {
    lines.push(`  → raise CONTEXT_WINDOW_TOKENS if the model actually supports a larger window.`);
  }

  return lines;
}

export type ViewLevel = "full" | "omitted" | "compacted";

export interface SendView {
  messages: Message[];
  tokens: number;
  /** Which degradation level produced this view (spec §3.1). */
  level: ViewLevel;
  /** Set when the view still exceeds budget and compaction is needed. */
  needsCompaction: boolean;
  /** Where compaction should cut, if it runs. */
  suggestedCutIndex?: number;
}

const OMITTED_PLACEHOLDER = (chars: number) => `[omitted, original content was ${chars} chars]`;

/**
 * A cut is only legal where every tool_use issued so far has had its
 * tool_result filled in. Splitting a tool_use from its result leaves a
 * dangling call and the API rejects the very next request (spec §3.1).
 */
export function isClosedAt(messages: Message[], index: number): boolean {
  const requested = new Set<string>();
  for (let i = 0; i < index; i++) {
    for (const block of messages[i].content) {
      if (block.type === "tool_use") requested.add(block.id);
      if (block.type === "tool_result") requested.delete(block.toolUseId);
    }
  }
  return requested.size === 0;
}

/**
 * Largest legal cut index at or below `preferred`. Returns 0 when no
 * closed boundary exists, which simply means "don't compact yet".
 */
export function findCutIndex(messages: Message[], preferred: number): number {
  for (let index = Math.min(preferred, messages.length); index > 0; index--) {
    if (isClosedAt(messages, index)) return index;
  }
  return 0;
}

/** The compaction actually in force — the one covering the most messages. */
export function activeCompaction(session: Session): Compaction | undefined {
  const compactions = session.compactions ?? [];
  let active: Compaction | undefined;
  for (const compaction of compactions) {
    if (!active || compaction.upToIndex > active.upToIndex) active = compaction;
  }
  return active;
}

function summaryMessage(summary: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `[Summary of earlier conversation, condensed to save context. ` +
          `Treat it as established history.]\n\n${summary}`,
      },
    ],
  };
}

/** Deep-copies only what we rewrite, so the session's blocks stay intact. */
function omitOldToolResults(messages: Message[], budgetTokens: number): Message[] {
  const view = messages.map((message) => ({ ...message, content: [...message.content] }));

  let total = estimateMessagesTokens(view);
  if (total <= budgetTokens) return view;

  for (let i = 0; i < view.length && total > budgetTokens; i++) {
    const content = view[i].content;
    for (let j = 0; j < content.length && total > budgetTokens; j++) {
      const block = content[j];
      if (block.type !== "tool_result") continue;

      const placeholder = OMITTED_PLACEHOLDER(block.content.length);
      if (placeholder.length >= block.content.length) continue;

      const saved = estimateTokens(block.content) - estimateTokens(placeholder);
      content[j] = { ...block, content: placeholder } satisfies ToolResultBlock;
      total -= saved;
    }
  }

  return view;
}

/**
 * Builds the message list to send, degrading in three steps (spec §3.1):
 * full history → omit old tool_results → report that compaction is needed.
 * Pure: never touches `session`.
 */
export function buildSendView(session: Session, budget: Budget): SendView {
  const compaction = activeCompaction(session);
  const base = compaction
    ? [summaryMessage(compaction.summary), ...session.messages.slice(compaction.upToIndex)]
    : session.messages;

  const full = base.map((message) => ({ ...message, content: [...message.content] }));
  const fullTokens = estimateMessagesTokens(full);
  const level: ViewLevel = compaction ? "compacted" : "full";

  if (fullTokens <= budget.historyTokens) {
    return { messages: full, tokens: fullTokens, level, needsCompaction: false };
  }

  const omitted = omitOldToolResults(base, budget.historyTokens);
  const omittedTokens = estimateMessagesTokens(omitted);

  if (omittedTokens <= budget.historyTokens) {
    return { messages: omitted, tokens: omittedTokens, level: "omitted", needsCompaction: false };
  }

  // Still over budget: compact everything except the most recent messages.
  // The cut index is relative to session.messages, not the view.
  const preferred = Math.max(0, session.messages.length - budget.keepRecent);
  const cutIndex = findCutIndex(session.messages, preferred);
  const alreadyCovered = compaction ? compaction.upToIndex : 0;

  return {
    messages: omitted,
    tokens: omittedTokens,
    level: "omitted",
    // Only worth compacting if it would cover ground the existing
    // summary doesn't already cover — otherwise we'd loop forever.
    needsCompaction: cutIndex > alreadyCovered,
    suggestedCutIndex: cutIndex > alreadyCovered ? cutIndex : undefined,
  };
}

export const COMPACTION_SYSTEM_PROMPT =
  `You are compacting the earlier part of a software engineering session to free up context. ` +
  `Write a dense summary that lets the agent continue without re-reading what was dropped.\n\n` +
  `Cover, in this order:\n` +
  `1. What the user asked for, including constraints and preferences they stated.\n` +
  `2. Decisions made and why — especially ones that would be wrong to revisit.\n` +
  `3. Files created or modified, with the specific changes.\n` +
  `4. Commands run and what they showed (test results, errors).\n` +
  `5. What is still in progress or unresolved.\n\n` +
  `Be specific: keep file paths, function names, exact error messages, and numbers. ` +
  `Drop conversational filler and superseded intermediate steps. ` +
  `Output only the summary — no preamble, no closing remarks.`;

/** The messages being summarized, rendered as one readable transcript. */
export function renderForSummary(messages: Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text.trim()) lines.push(`${message.role.toUpperCase()}: ${block.text.trim()}`);
          break;
        case "tool_use":
          lines.push(`TOOL CALL ${block.name}: ${JSON.stringify(block.input)}`);
          break;
        case "tool_result":
          lines.push(
            `TOOL RESULT${block.isError ? " (error)" : ""}: ${block.content.slice(0, 2000)}`,
          );
          break;
      }
    }
  }
  return lines.join("\n");
}
