import { describe, expect, it, vi } from "vitest";
import {
  createOpenAICompatSend,
  fromOpenAIMessage,
  toOpenAIMessages,
  toOpenAITools,
} from "../../src/llm/adapters/openai-compat.js";
import type { Message, ToolDefinition } from "../../src/llm/types.js";

describe("openai-compat adapter: normalized -> wire", () => {
  it("prepends system as its own message", () => {
    const wire = toOpenAIMessages([], "be helpful");
    expect(wire).toEqual([{ role: "system", content: "be helpful" }]);
  });

  it("converts a user text message", () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    expect(toOpenAIMessages(messages, "")).toEqual([{ role: "user", content: "hi" }]);
  });

  it("converts an assistant tool_use block into tool_calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
      },
    ];
    expect(toOpenAIMessages(messages, "")).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        ],
      },
    ]);
  });

  it("converts a user tool_result block into its own role:tool message", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", content: "file.txt", isError: false }],
      },
    ];
    expect(toOpenAIMessages(messages, "")).toEqual([
      { role: "tool", tool_call_id: "t1", content: "file.txt" },
    ]);
  });

  it("converts tool definitions to OpenAI's function.parameters shape", () => {
    const tools: ToolDefinition[] = [
      { name: "read_file", description: "read a file", inputSchema: { type: "object" } },
    ];
    expect(toOpenAITools(tools)).toEqual([
      {
        type: "function",
        function: { name: "read_file", description: "read a file", parameters: { type: "object" } },
      },
    ]);
  });
});

describe("openai-compat adapter: wire -> normalized", () => {
  it("maps content + tool_calls back to normalized blocks", () => {
    const response = fromOpenAIMessage(
      {
        content: "done",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        ],
      },
      "tool_calls",
    );
    expect(response).toEqual({
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
      ],
      stopReason: "tool_use",
    });
  });

  it("falls back to a raw-string input when tool_call arguments aren't valid JSON", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = fromOpenAIMessage(
      { tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{not json" } }] },
      "tool_calls",
    );
    expect(response.content).toEqual([
      { type: "tool_use", id: "t1", name: "bash", input: { _raw: "{not json" } },
    ]);
    error.mockRestore();
  });

  it.each([
    ["stop", "end_turn"],
    ["tool_calls", "tool_use"],
    ["length", "max_tokens"],
    [null, "other"],
  ] as const)("maps finish_reason %s -> %s", (raw, expected) => {
    expect(fromOpenAIMessage({ content: "x" }, raw).stopReason).toBe(expected);
  });
});

describe("createOpenAICompatSend: SSE streaming", () => {
  function sseResponse(chunks: unknown[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  it("streams text deltas via onTextDelta and returns the assembled response", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const send = createOpenAICompatSend({ apiKey: "k", model: "deepseek-chat" });
    const deltas: string[] = [];
    const response = await send([], [], "", { onTextDelta: (d) => deltas.push(d) });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(response).toEqual({ content: [{ type: "text", text: "Hello" }], stopReason: "end_turn" });

    vi.unstubAllGlobals();
  });

  it("accumulates fragmented tool_call deltas across chunks", async () => {
    const chunks = [
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "ba", arguments: "" } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: "sh", arguments: '{"comm' } }] } },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const send = createOpenAICompatSend({ apiKey: "k", model: "deepseek-chat" });
    const response = await send([], [], "", {});

    expect(response).toEqual({
      content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
      stopReason: "tool_use",
    });

    vi.unstubAllGlobals();
  });

  it("throws with status/body when the request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad key", { status: 401, statusText: "Unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);

    const send = createOpenAICompatSend({ apiKey: "k", model: "deepseek-chat" });
    await expect(send([], [], "", {})).rejects.toThrow(/401/);

    vi.unstubAllGlobals();
  });
});

describe("steering: tool_result and user text in one normalized message (spec §3.2)", () => {
  const steered = [
    {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "c1", name: "bash", input: {} }],
    },
    {
      role: "user" as const,
      content: [
        { type: "tool_result" as const, toolUseId: "c1", content: "ok", isError: false },
        { type: "text" as const, text: "actually, do X instead" },
      ],
    },
  ];

  it("emits the tool message before the user text, never after", () => {
    // OpenAI rejects anything between an assistant `tool_calls` message and
    // the `tool` messages answering it — with a 400, not a reordering.
    // Block order in the normalized message must not decide wire order.
    const wire = toOpenAIMessages(steered, "");
    expect(wire.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(wire[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
    expect(wire[2]).toEqual({ role: "user", content: "actually, do X instead" });
  });

  it("answers every tool_call before any other message intervenes", () => {
    const wire = toOpenAIMessages(steered, "");
    const callIds = wire.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id));
    for (const id of callIds) {
      const callIndex = wire.findIndex((m) => m.tool_calls?.some((c) => c.id === id));
      const answerIndex = wire.findIndex((m) => m.tool_call_id === id);
      expect(answerIndex).toBe(callIndex + 1);
    }
  });
});
