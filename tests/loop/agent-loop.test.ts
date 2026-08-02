/**
 * Agent loop scenarios from spec §12.2 — the control-flow decisions that
 * are easy to regress silently. A programmable fake `send` stands in for
 * the LLM; nothing here touches the network or a TTY.
 */
import { describe, expect, it, vi } from "vitest";
import { runTurn, type AgentDeps } from "../../src/agent.js";
import { DEFAULT_CONFIG, type Config } from "../../src/config.js";
import type { Message, Response, SendFn, ToolUseBlock } from "../../src/llm/types.js";
import type { Session } from "../../src/session.js";
import { createSpawnAgentTool, toolsForRole } from "../../src/tools/spawn_agent.js";
import type { Tool, ToolRegistry } from "../../src/tools/index.js";

function session(): Session {
  return {
    id: "test",
    cwd: "/tmp/tcode-test",
    provider: "anthropic",
    model: "claude-sonnet-5",
    createdAt: "",
    updatedAt: "",
    messages: [],
  };
}

/** Replays preset responses in order, recording every call. */
function fakeSend(responses: Response[]) {
  const calls: { messages: Message[]; toolNames: string[] }[] = [];
  const send: SendFn = async (messages, tools) => {
    calls.push({
      messages: structuredClone(messages),
      toolNames: tools.map((tool) => tool.name),
    });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`fake send: no response queued for call ${calls.length}`);
    return next;
  };
  return { send, calls };
}

function textResponse(text: string): Response {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

function toolResponse(...toolUses: ToolUseBlock[]): Response {
  return { content: toolUses, stopReason: "tool_use" };
}

function use(name: string, id: string, input: unknown = {}): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function fakeTool(name: string, execute: Tool["execute"]): Tool {
  return {
    schema: { name, description: name, inputSchema: { type: "object" } },
    execute,
  };
}

const finishStub = fakeTool("finish", (input) => `[${input.status}] ${input.summary}`);

function deps(send: SendFn, overrides: Partial<AgentDeps> = {}, config: Partial<Config> = {}): AgentDeps {
  return {
    send,
    approval: { needsConfirmation: () => false, confirm: async () => true },
    config: { ...DEFAULT_CONFIG, ...config },
    root: "/tmp/tcode-test",
    systemPrompt: "system",
    contextWindowTokens: 200_000,
    ...overrides,
  };
}

const noopPersist = () => {};

/** Every tool_use must be answered by a tool_result in a later message —
 * a dangling one makes the next `--continue` fail at the API. */
function danglingToolUseIds(messages: Message[]): string[] {
  const requested: string[] = [];
  const answered = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") requested.push(block.id);
      if (block.type === "tool_result") answered.add(block.toolUseId);
    }
  }
  return requested.filter((id) => !answered.has(id));
}

describe("scenario 1: no tool_use", () => {
  it("ends the turn without calling the LLM again", async () => {
    const { send, calls } = fakeSend([textResponse("just an answer")]);
    const result = await runTurn(session(), "hi", deps(send), { log: () => {}, persist: noopPersist });

    expect(result.outcome).toBe("no_tool_use");
    expect(result.lastText).toBe("just an answer");
    expect(calls).toHaveLength(1);
  });
});

describe("scenario 2: finish alone", () => {
  it("executes finish, refills its tool_result, and stops calling the LLM", async () => {
    const { send, calls } = fakeSend([
      toolResponse(use("finish", "f1", { summary: "all done", status: "done" })),
    ]);
    const s = session();

    const result = await runTurn(s, "do it", deps(send), {
      tools: { finish: finishStub },
      log: () => {},
      persist: noopPersist,
    });

    expect(result.outcome).toBe("finished");
    expect(result.finish).toEqual({ summary: "all done", status: "done" });
    expect(calls).toHaveLength(1);

    const last = s.messages.at(-1)!;
    expect(last.content).toEqual([
      { type: "tool_result", toolUseId: "f1", content: "[done] all done", isError: false },
    ]);
    expect(danglingToolUseIds(s.messages)).toEqual([]);
  });
});

describe("scenario 3 (REGRESSION LOCK): finish mixed with other tool_uses", () => {
  it("executes every tool, refills every tool_result, and leaves no dangling tool_use", async () => {
    const executed: string[] = [];
    const tools: ToolRegistry = {
      read_file: fakeTool("read_file", () => {
        executed.push("read_file");
        return "file contents";
      }),
      finish: fakeTool("finish", (input) => {
        executed.push("finish");
        return `[${input.status}] ${input.summary}`;
      }),
    };

    const { send, calls } = fakeSend([
      toolResponse(
        use("read_file", "r1", { path: "a.ts" }),
        use("finish", "f1", { summary: "read and done", status: "done" }),
      ),
    ]);
    const s = session();

    const result = await runTurn(s, "read then finish", deps(send), {
      tools,
      log: () => {},
      persist: noopPersist,
    });

    // finish does not short-circuit the rest of the batch.
    expect(executed).toEqual(["read_file", "finish"]);
    expect(result.outcome).toBe("finished");
    expect(calls).toHaveLength(1);

    const results = s.messages.at(-1)!.content;
    expect(results.map((block) => (block.type === "tool_result" ? block.toolUseId : null))).toEqual([
      "r1",
      "f1",
    ]);
    expect(danglingToolUseIds(s.messages)).toEqual([]);
  });

  it("survives a --continue that appends a new user message afterwards", async () => {
    const tools: ToolRegistry = {
      read_file: fakeTool("read_file", () => "file contents"),
      finish: finishStub,
    };

    const first = fakeSend([
      toolResponse(
        use("read_file", "r1", { path: "a.ts" }),
        use("finish", "f1", { summary: "done", status: "done" }),
      ),
    ]);
    const s = session();
    await runTurn(s, "first turn", deps(first.send), { tools, log: () => {}, persist: noopPersist });

    // Simulate reloading the session and sending another message.
    const resumed: Session = { ...s, messages: structuredClone(s.messages) };
    const second = fakeSend([textResponse("second turn answer")]);
    await runTurn(resumed, "second turn", deps(second.send), {
      tools,
      log: () => {},
      persist: noopPersist,
    });

    expect(danglingToolUseIds(resumed.messages)).toEqual([]);
    // The resumed turn saw the closed history from turn one.
    const sentMessages = second.calls[0].messages;
    expect(sentMessages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "second turn" }],
    });
  });
});

describe("scenario 4: tool throws", () => {
  it("refills an is_error result and keeps the loop going", async () => {
    const tools: ToolRegistry = {
      edit_file: fakeTool("edit_file", () => {
        throw new Error("no match for old_string");
      }),
      finish: finishStub,
    };

    const { send, calls } = fakeSend([
      toolResponse(use("edit_file", "e1", { path: "a.ts" })),
      toolResponse(use("finish", "f1", { summary: "recovered", status: "done" })),
    ]);
    const s = session();

    const result = await runTurn(s, "edit it", deps(send), { tools, log: () => {}, persist: noopPersist });

    expect(result.outcome).toBe("finished");
    expect(calls).toHaveLength(2);

    const errorResult = s.messages[2].content[0];
    expect(errorResult).toEqual({
      type: "tool_result",
      toolUseId: "e1",
      content: "no match for old_string",
      isError: true,
    });
  });
});

describe("scenario 5: user declines confirmation", () => {
  it("refills a decline result, does not execute, and keeps the loop going", async () => {
    const execute = vi.fn();
    const tools: ToolRegistry = {
      bash: fakeTool("bash", execute),
      finish: finishStub,
    };

    const { send } = fakeSend([
      toolResponse(use("bash", "b1", { command: "rm -rf /" })),
      toolResponse(use("finish", "f1", { summary: "stopped", status: "blocked" })),
    ]);
    const s = session();

    const result = await runTurn(
      s,
      "clean up",
      deps(send, {
        approval: { needsConfirmation: (t) => t.name === "bash", confirm: async () => false },
      }),
      { tools, log: () => {}, persist: noopPersist },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.outcome).toBe("finished");

    const declined = s.messages[2].content[0];
    expect(declined).toMatchObject({ toolUseId: "b1", isError: true });
    expect((declined as { content: string }).content).toMatch(/declined/i);
  });
});

describe("scenario 6: MAX_TOOL_ITERATIONS exhausted", () => {
  it("stops, warns, and leaves a complete saveable session", async () => {
    const responses = Array.from({ length: 3 }, (_, i) =>
      toolResponse(use("read_file", `r${i}`, { path: "a.ts" })),
    );
    const { send, calls } = fakeSend(responses);
    const tools: ToolRegistry = { read_file: fakeTool("read_file", () => "contents") };

    const logged: string[] = [];
    const persisted = vi.fn();
    const s = session();

    const result = await runTurn(s, "loop forever", deps(send, {}, { maxToolIterations: 3 }), {
      tools,
      log: (line) => logged.push(line),
      persist: persisted,
    });

    expect(result.outcome).toBe("max_iterations");
    expect(calls).toHaveLength(3);
    expect(logged.some((line) => line.includes("3 tool iterations"))).toBe(true);
    expect(persisted).toHaveBeenCalledOnce();
    expect(danglingToolUseIds(s.messages)).toEqual([]);
  });
});

describe("scenario 7: multiple non-finish tools in one batch", () => {
  it("runs them serially in the order the model requested", async () => {
    const order: string[] = [];
    const makeTool = (name: string) =>
      fakeTool(name, async () => {
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${name}:end`);
        return name;
      });

    const tools: ToolRegistry = {
      write_file: makeTool("write_file"),
      read_file: makeTool("read_file"),
      bash: makeTool("bash"),
    };

    const { send } = fakeSend([
      toolResponse(
        use("write_file", "w1"),
        use("read_file", "r1"),
        use("bash", "b1"),
      ),
      textResponse("done"),
    ]);
    const s = session();

    await runTurn(s, "do three things", deps(send), { tools, log: () => {}, persist: noopPersist });

    // Fully serial: no tool starts before the previous one ends.
    expect(order).toEqual([
      "write_file:start",
      "write_file:end",
      "read_file:start",
      "read_file:end",
      "bash:start",
      "bash:end",
    ]);
    expect(s.messages[2].content.map((b) => (b.type === "tool_result" ? b.toolUseId : null))).toEqual([
      "w1",
      "r1",
      "b1",
    ]);
  });
});

describe("oversized tool_result", () => {
  it("truncates a single result to MAX_OUTPUT_CHARS before it enters the history", async () => {
    const huge = "X".repeat(50_000);
    const tools: ToolRegistry = { bash: fakeTool("bash", () => huge) };

    const { send } = fakeSend([toolResponse(use("bash", "b1")), textResponse("ok")]);
    const s = session();

    await runTurn(s, "dump a lot", deps(send, {}, { maxOutputChars: 1000 }), {
      tools,
      log: () => {},
      persist: noopPersist,
    });

    const result = s.messages[2].content[0] as { content: string };
    expect(result.content.length).toBeLessThan(2000);
    expect(result.content).toContain("truncated");
  });
});

describe("context management: session stays intact", () => {
  it("omits old tool output from the REQUEST without touching session.messages", async () => {
    const big = "Y".repeat(20_000);
    const tools: ToolRegistry = { bash: fakeTool("bash", () => big) };

    const { send, calls } = fakeSend([
      toolResponse(use("bash", "b1")),
      toolResponse(use("bash", "b2")),
      toolResponse(use("bash", "b3")),
      textResponse("done"),
    ]);
    const s = session();

    await runTurn(s, "run three", deps(send, { contextWindowTokens: 8000 }), {
      tools,
      log: () => {},
      persist: noopPersist,
    });

    // The request degraded...
    const sentResults = calls
      .at(-1)!
      .messages.flatMap((m) => m.content)
      .filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result");
    expect(sentResults.some((r) => r.content.includes("omitted, original content"))).toBe(true);

    // ...but the session kept every byte. This is the invariant that the
    // old in-place pruning violated: history must survive --continue.
    const storedResults = s.messages
      .flatMap((m) => m.content)
      .filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result");
    expect(storedResults).toHaveLength(3);
    for (const result of storedResults) {
      expect(result.content).toBe(big);
    }
  });

  it("reports context usage back to the caller", async () => {
    const { send } = fakeSend([textResponse("hi")]);
    const result = await runTurn(session(), "hello", deps(send, { contextWindowTokens: 50_000 }), {
      log: () => {},
      persist: noopPersist,
    });

    expect(result.usage.contextWindowTokens).toBe(50_000);
    expect(result.usage.tokens).toBeGreaterThan(0);
  });
});

describe("context management: compaction", () => {
  // Compaction only fires when omitting tool_results is not enough, so the
  // bulk has to live somewhere unomittable — here, the tool_use input.
  const BIG_INPUT = { command: "Z".repeat(30_000) };
  function bigHistoryTools() {
    return { bash: fakeTool("bash", () => "ok") } satisfies ToolRegistry;
  }

  it("summarizes old messages, caches the summary, and keeps every message", async () => {
    const responses = [
      toolResponse(use("bash", "b1", BIG_INPUT)),
      toolResponse(use("bash", "b2", BIG_INPUT)),
      toolResponse(use("bash", "b3", BIG_INPUT)),
      toolResponse(use("bash", "b4", BIG_INPUT)),
      textResponse("done"),
    ];
    const { send, calls } = fakeSend([...responses]);

    // The compaction call is an extra, tool-less request; serve it a summary.
    let compactionCalls = 0;
    const sendWithSummarizer: typeof send = async (messages, tools, system, options) => {
      if (tools.length === 0) {
        compactionCalls++;
        return textResponse("SUMMARY: ran bash a few times, all fine.");
      }
      return send(messages, tools, system, options);
    };

    const s = session();
    await runTurn(
      s,
      "run several",
      deps(sendWithSummarizer, { contextWindowTokens: 12_000 }, { compactKeepRecent: 2 }),
      { tools: bigHistoryTools(), log: () => {}, persist: noopPersist },
    );

    expect(compactionCalls).toBeGreaterThan(0);
    expect(s.compactions?.length).toBeGreaterThan(0);
    expect(s.compactions![0].summary).toContain("SUMMARY:");

    // Nothing was deleted from the history.
    expect(s.messages.length).toBeGreaterThan(s.compactions![0].upToIndex);

    // Later requests carry the summary instead of the compacted messages.
    const lastSent = JSON.stringify(calls.at(-1)!.messages);
    expect(lastSent).toContain("SUMMARY:");
  });

  it("never cuts between a tool_use and its tool_result", async () => {
    const { send } = fakeSend([
      toolResponse(use("bash", "b1", BIG_INPUT)),
      toolResponse(use("bash", "b2", BIG_INPUT)),
      toolResponse(use("bash", "b3", BIG_INPUT)),
      textResponse("done"),
    ]);

    const sendWithSummarizer: typeof send = async (messages, tools, system, options) => {
      if (tools.length === 0) return textResponse("SUMMARY");
      return send(messages, tools, system, options);
    };

    const s = session();
    await runTurn(
      s,
      "run several",
      deps(sendWithSummarizer, { contextWindowTokens: 10_000 }, { compactKeepRecent: 1 }),
      { tools: bigHistoryTools(), log: () => {}, persist: noopPersist },
    );

    for (const compaction of s.compactions ?? []) {
      // Everything before the cut must be self-contained.
      const before = s.messages.slice(0, compaction.upToIndex);
      expect(danglingToolUseIds(before)).toEqual([]);
    }
  });

  it("falls back to the omitted view when the summarizer fails, without killing the turn", async () => {
    const { send } = fakeSend([
      toolResponse(use("bash", "b1", BIG_INPUT)),
      toolResponse(use("bash", "b2", BIG_INPUT)),
      toolResponse(use("bash", "b3", BIG_INPUT)),
      textResponse("finished anyway"),
    ]);

    const sendWithFailingSummarizer: typeof send = async (messages, tools, system, options) => {
      if (tools.length === 0) throw new Error("summarizer exploded");
      return send(messages, tools, system, options);
    };

    const logged: string[] = [];
    const s = session();
    const result = await runTurn(
      s,
      "run several",
      deps(sendWithFailingSummarizer, { contextWindowTokens: 10_000 }, { compactKeepRecent: 1 }),
      { tools: bigHistoryTools(), log: (line) => logged.push(line), persist: noopPersist },
    );

    expect(result.outcome).toBe("no_tool_use");
    expect(s.compactions ?? []).toEqual([]);
    expect(logged.some((line) => line.includes("compaction failed"))).toBe(true);
  });
});

describe("subagent approval", () => {
  it("still routes a subagent's bash through the approval policy", async () => {
    const executed = vi.fn(() => "ran");
    const subTools: ToolRegistry = { bash: fakeTool("bash", executed), finish: finishStub };

    const confirm = vi.fn(async () => false);
    const subDeps = deps(
      fakeSend([
        toolResponse(use("bash", "sb1", { command: "rm -rf /" })),
        toolResponse(use("finish", "sf1", { summary: "declined", status: "blocked" })),
      ]).send,
      { approval: { needsConfirmation: (t) => t.name === "bash", confirm } },
    );

    const spawnTool = createSpawnAgentTool({
      deps: subDeps,
      runTurn: (subSession, task, d, options) =>
        runTurn(subSession, task, d, { ...options, tools: subTools }),
    });

    const { send } = fakeSend([
      toolResponse(use("spawn_agent", "s1", { task: "clean up", role: "general" })),
      textResponse("ok"),
    ]);

    await runTurn(session(), "delegate", deps(send), {
      tools: { spawn_agent: spawnTool },
      log: () => {},
      persist: noopPersist,
    });

    // Being a subagent is not a way around the approval prompt.
    expect(confirm).toHaveBeenCalledOnce();
    expect(executed).not.toHaveBeenCalled();
  });
});

describe("scenario 8: spawn_agent", () => {
  it("returns only the subagent's summary and hides its intermediate messages", async () => {
    // The subagent's own loop, driven by its own fake send.
    const subSend = fakeSend([
      toolResponse(use("read_file", "sr1", { path: "a.ts" })),
      toolResponse(use("finish", "sf1", { summary: "found it in src/foo.ts", status: "done" })),
    ]);

    const subTools: ToolRegistry = {
      read_file: fakeTool("read_file", () => "secret intermediate content"),
      finish: finishStub,
    };

    const spawnTool = createSpawnAgentTool({
      deps: deps(subSend.send),
      // Force the subagent's tool set to the fakes while keeping the real
      // role-trimming assertion below on the production mapping.
      runTurn: (subSession, task, subDeps, options) =>
        runTurn(subSession, task, subDeps, { ...options, tools: subTools }),
    });

    const mainSend = fakeSend([
      toolResponse(use("spawn_agent", "s1", { task: "find the thing", role: "explore" })),
      textResponse("thanks"),
    ]);
    const s = session();

    await runTurn(s, "delegate this", deps(mainSend.send), {
      tools: { spawn_agent: spawnTool },
      log: () => {},
      persist: noopPersist,
    });

    const spawnResult = s.messages[2].content[0];
    expect(spawnResult).toEqual({
      type: "tool_result",
      toolUseId: "s1",
      content: "[done] found it in src/foo.ts",
      isError: false,
    });

    // The subagent's intermediate work never entered the main session.
    const mainHistory = JSON.stringify(s.messages);
    expect(mainHistory).not.toContain("secret intermediate content");
    expect(mainHistory).not.toContain("sr1");
    // The subagent started from an empty history, not a copy of the main one.
    expect(subSend.calls[0].messages).toEqual([
      { role: "user", content: [{ type: "text", text: "find the thing" }] },
    ]);
  });

  it("never hands a subagent the spawn_agent tool", () => {
    for (const role of ["general", "explore"] as const) {
      expect(Object.keys(toolsForRole(role))).not.toContain("spawn_agent");
    }
  });

  it("reports back when the subagent hits the iteration limit without finishing", async () => {
    const subSend = fakeSend([toolResponse(use("read_file", "sr1", { path: "a.ts" }))]);
    const subTools: ToolRegistry = { read_file: fakeTool("read_file", () => "contents") };

    const spawnTool = createSpawnAgentTool({
      deps: deps(subSend.send, {}, { maxToolIterations: 1 }),
      runTurn: (subSession, task, subDeps, options) =>
        runTurn(subSession, task, subDeps, { ...options, tools: subTools }),
    });

    const mainSend = fakeSend([
      toolResponse(use("spawn_agent", "s1", { task: "endless", role: "general" })),
      textResponse("ok"),
    ]);
    const s = session();

    await runTurn(s, "delegate", deps(mainSend.send), {
      tools: { spawn_agent: spawnTool },
      log: () => {},
      persist: noopPersist,
    });

    const spawnResult = s.messages[2].content[0] as { content: string; isError: boolean };
    expect(spawnResult.content).toMatch(/iteration limit/i);
    // Reported as a normal result, not an error — the main agent decides
    // what to do about it rather than treating it as a crash.
    expect(spawnResult.isError).toBe(false);
  });
});
