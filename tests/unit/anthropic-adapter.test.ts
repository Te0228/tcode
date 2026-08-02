import { describe, expect, it, vi } from "vitest";
import {
  fromAnthropicMessage,
  toAnthropicMessages,
  toAnthropicTools,
} from "../../src/llm/adapters/anthropic.js";
import type { Message, ToolDefinition } from "../../src/llm/types.js";

describe("anthropic adapter: normalized -> wire", () => {
  it("converts text/tool_use/tool_result blocks with the right field names", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: "file.txt", isError: false },
        ],
      },
    ];

    const wire = toAnthropicMessages(messages);

    expect(wire).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file.txt", is_error: false },
        ],
      },
    ]);
  });

  it("converts tool definitions to Anthropic's input_schema field name", () => {
    const tools: ToolDefinition[] = [
      { name: "read_file", description: "read a file", inputSchema: { type: "object" } },
    ];

    expect(toAnthropicTools(tools)).toEqual([
      { name: "read_file", description: "read a file", input_schema: { type: "object" } },
    ]);
  });
});

describe("anthropic adapter: wire -> normalized", () => {
  function fakeMessage(overrides: Partial<{ content: unknown[]; stop_reason: string | null }>) {
    return {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: overrides.content ?? [],
      stop_reason: "stop_reason" in overrides ? overrides.stop_reason : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Parameters<typeof fromAnthropicMessage>[0];
  }

  it("maps text and tool_use content blocks back to normalized form", () => {
    const response = fromAnthropicMessage(
      fakeMessage({
        content: [
          { type: "text", text: "done" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        ],
        stop_reason: "tool_use",
      }),
    );

    expect(response).toEqual({
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
      ],
      stopReason: "tool_use",
    });
  });

  it.each([
    ["end_turn", "end_turn"],
    ["stop_sequence", "end_turn"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    [null, "other"],
  ] as const)("maps stop_reason %s -> %s", (raw, expected) => {
    const response = fromAnthropicMessage(fakeMessage({ stop_reason: raw }));
    expect(response.stopReason).toBe(expected);
  });

  it("drops an unrecognized content block instead of throwing", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = fromAnthropicMessage(
      fakeMessage({ content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "ok" }] }),
    );

    expect(response.content).toEqual([{ type: "text", text: "ok" }]);
    warn.mockRestore();
  });
});
