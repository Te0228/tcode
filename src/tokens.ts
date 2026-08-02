/**
 * Heuristic token estimation (spec §3.1). Deliberately not a real
 * tokenizer: tiktoken-class dependencies are heavy for a minimal CLI and
 * every provider tokenizes differently anyway. We only need "how full is
 * the context" to be right enough to trigger compaction in time.
 *
 * Bias is toward OVER-estimating — under-estimating means hitting the API
 * limit and failing the request, over-estimating just compacts earlier.
 */
import type { ContentBlock, Message } from "./llm/types.js";

/** CJK, kana, Hangul, and full-width punctuation — roughly one token per
 * character. Latin text averages closer to one token per four. */
const CJK_PATTERN =
  /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/gu;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_PATTERN) ?? []).length;
  const rest = text.length - cjkCount;
  return Math.ceil(cjkCount + rest / 4);
}

/** Per-message envelope cost (role, delimiters) the wire format adds. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** A tool_use/tool_result carries an id and name beyond its payload. */
const BLOCK_OVERHEAD_TOKENS = 8;

export function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokens(block.text);
    case "tool_use":
      return (
        BLOCK_OVERHEAD_TOKENS +
        estimateTokens(block.name) +
        estimateTokens(JSON.stringify(block.input ?? {}))
      );
    case "tool_result":
      return BLOCK_OVERHEAD_TOKENS + estimateTokens(block.content);
  }
}

export function estimateMessageTokens(message: Message): number {
  return (
    MESSAGE_OVERHEAD_TOKENS +
    message.content.reduce((sum, block) => sum + estimateBlockTokens(block), 0)
  );
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** Compact human-readable form for the REPL's usage line: 12345 -> "12.3k". */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}
