/**
 * Normalized, provider-agnostic message/tool types (spec §8.1).
 * `agent.ts`, `session.ts` and `tools/` only ever see these — provider
 * wire formats (Anthropic Messages API, OpenAI Chat Completions, ...)
 * are translated to/from this shape inside `llm/adapters/*`.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface Response {
  content: ContentBlock[];
  stopReason: StopReason;
}

export interface SendOptions {
  /** Called incrementally as assistant text is generated (spec §3/§8.1). */
  onTextDelta?: (delta: string) => void;
}

export type SendFn = (
  messages: Message[],
  tools: ToolDefinition[],
  system: string,
  options?: SendOptions,
) => Promise<Response>;

export function textBlocksOf(response: Response): TextBlock[] {
  return response.content.filter((block): block is TextBlock => block.type === "text");
}

export function toolUseBlocksOf(response: Response): ToolUseBlock[] {
  return response.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
}
