import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  Response,
  SendFn,
  StopReason,
  ToolDefinition,
} from "../types.js";

type AnthropicContentBlockParam =
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

export function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(toAnthropicBlock),
  }));
}

function toAnthropicBlock(block: ContentBlock): AnthropicContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

export function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

export function fromAnthropicMessage(message: Anthropic.Message): Response {
  const content: ContentBlock[] = [];
  for (const block of message.content) {
    const normalized = fromAnthropicBlock(block);
    if (normalized) content.push(normalized);
  }
  return {
    content,
    stopReason: fromAnthropicStopReason(message.stop_reason),
  };
}

function fromAnthropicBlock(block: Anthropic.ContentBlock): ContentBlock | undefined {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  // Defensive: don't crash the whole turn over a response block type this
  // adapter doesn't know about yet (e.g. a future block type not in the
  // installed SDK's ContentBlock union). Drop it and keep going rather
  // than throwing.
  console.error(
    `anthropic adapter: dropping unsupported response block type "${(block as { type: string }).type}"`,
  );
  return undefined;
}

function fromAnthropicStopReason(
  reason: Anthropic.Message["stop_reason"],
): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "other";
  }
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export function createAnthropicSend(config: AnthropicConfig): SendFn {
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });

  return async (messages, tools, system, options) => {
    const stream = client.messages.stream({
      model: config.model,
      max_tokens: 8192,
      system,
      messages: toAnthropicMessages(messages),
      tools: toAnthropicTools(tools),
    });

    if (options?.onTextDelta) {
      stream.on("text", (delta) => options.onTextDelta?.(delta));
    }

    const finalMessage = await stream.finalMessage();
    return fromAnthropicMessage(finalMessage);
  };
}
