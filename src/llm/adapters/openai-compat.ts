/**
 * OpenAI Chat Completions wire format adapter (spec §8.1). Shared by
 * DeepSeek and any other "OpenAI compatible" provider — they differ only
 * by base_url/model, never by wire shape.
 */
import type {
  ContentBlock,
  Message,
  Response,
  SendFn,
  StopReason,
  ToolDefinition,
  ToolUseBlock,
} from "../types.js";

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * Normalized -> wire. `system` becomes a leading `role: "system"` message.
 * A normalized "user" message's `tool_result` blocks each become their own
 * `role: "tool"` message (OpenAI has no batched tool_result concept).
 */
export function toOpenAIMessages(messages: Message[], system: string): OpenAIMessage[] {
  const wire: OpenAIMessage[] = [];
  if (system) wire.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "assistant") {
      wire.push(assistantBlockToWire(message.content));
      continue;
    }

    // Tool results first, text second, whatever order the blocks are in.
    // OpenAI requires the `tool` messages to follow the assistant's
    // `tool_calls` immediately — a `user` message slipped in between is a
    // 400, not a reordering. Steering makes this reachable: it puts the
    // user's mid-turn message in the same normalized message as the
    // tool_results (spec §3.2).
    for (const block of message.content) {
      if (block.type === "tool_result") {
        wire.push({ role: "tool", tool_call_id: block.toolUseId, content: block.content });
      }
    }

    const text = textOf(message.content);
    if (text) wire.push({ role: "user", content: text });
  }

  return wire;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function assistantBlockToWire(content: ContentBlock[]): OpenAIMessage {
  const text = textOf(content);
  const toolUses = content.filter((b): b is ToolUseBlock => b.type === "tool_use");

  const message: OpenAIMessage = { role: "assistant", content: text || null };
  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map((tu) => ({
      id: tu.id,
      type: "function",
      function: { name: tu.name, arguments: JSON.stringify(tu.input) },
    }));
  }
  return message;
}

export function toOpenAITools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/** Wire -> normalized, for a single (non-streamed) chat.completion choice. */
export function fromOpenAIMessage(
  message: { content?: string | null; tool_calls?: OpenAIToolCall[] },
  finishReason: string | null,
): Response {
  const content: ContentBlock[] = [];
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
  }
  return { content, stopReason: fromOpenAIFinishReason(finishReason) };
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`openai-compat adapter: failed to parse tool_call arguments as JSON: ${raw}`);
    return { _raw: raw };
  }
}

function fromOpenAIFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "other";
  }
}

export interface OpenAICompatConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface StreamingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Real SSE streaming (spec §8.1): parses `data: {...}` chunks off
 * `/chat/completions?stream=true`. Text deltas fire `onTextDelta`
 * incrementally; tool_call deltas (which arrive fragmented, keyed by
 * index) are accumulated until the stream ends.
 */
export function createOpenAICompatSend(config: OpenAICompatConfig): SendFn {
  const baseUrl = (config.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");

  return async (messages, tools, system, options) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        messages: toOpenAIMessages(messages, system),
        tools: tools.length > 0 ? toOpenAITools(tools) : undefined,
      }),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`openai-compat request failed: ${res.status} ${res.statusText} ${body}`);
    }

    let textContent = "";
    const toolCalls = new Map<number, StreamingToolCall>();
    let finishReason: string | null = null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice("data:".length).trim();
        if (data === "[DONE]") continue;

        const chunk = JSON.parse(data);
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          textContent += delta.content;
          options?.onTextDelta?.(delta.content);
        }

        for (const tc of delta.tool_calls ?? []) {
          const existing = toolCalls.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCalls.set(tc.index, existing);
        }
      }
    }

    const content: ContentBlock[] = [];
    if (textContent) content.push({ type: "text", text: textContent });
    for (const [, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: parseArgs(call.arguments) });
    }

    return { content, stopReason: fromOpenAIFinishReason(finishReason) };
  };
}
