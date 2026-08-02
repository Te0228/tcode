import { describe, expect, it } from "vitest";
import {
  activeCompaction,
  buildSendView,
  budgetWarning,
  computeBudget,
  findCutIndex,
  isClosedAt,
  renderForSummary,
  type Budget,
} from "../../src/context.js";
import { estimateTokens, formatTokens } from "../../src/tokens.js";
import type { Message } from "../../src/llm/types.js";
import type { Session } from "../../src/session.js";

function session(messages: Message[], compactions?: Session["compactions"]): Session {
  return {
    id: "t",
    cwd: "/tmp",
    provider: "deepseek",
    model: "deepseek-chat",
    createdAt: "",
    updatedAt: "",
    messages,
    compactions,
  };
}

const text = (role: Message["role"], body: string): Message => ({
  role,
  content: [{ type: "text", text: body }],
});
const toolUse = (id: string, input: unknown = {}): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "bash", input }],
});
const toolResult = (id: string, content: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", toolUseId: id, content, isError: false }],
});

const budget = (historyTokens: number): Budget => ({
  historyTokens,
  contextWindowTokens: 100_000,
  keepRecent: 2,
});

describe("estimateTokens", () => {
  it("counts latin text at roughly four characters per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("counts CJK at roughly one token per character", () => {
    expect(estimateTokens("中文测试")).toBe(4);
  });

  it("handles mixed text without under-counting", () => {
    // Under-counting is the dangerous direction: it overruns the API limit.
    const mixed = "中文abcd";
    expect(estimateTokens(mixed)).toBeGreaterThanOrEqual(3);
  });

  it("returns zero for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1.0k"],
    [12_345, "12.3k"],
  ])("formats %i as %s", (input, expected) => {
    expect(formatTokens(input)).toBe(expected);
  });
});

describe("computeBudget", () => {
  it("subtracts the reserved output and system prompt from the usable window", () => {
    const result = computeBudget({
      contextWindowTokens: 100_000,
      compactThreshold: 0.75,
      reservedOutputTokens: 8000,
      compactKeepRecent: 8,
      systemPromptTokens: 2000,
    });
    expect(result.historyTokens).toBe(75_000 - 8000 - 2000);
    expect(result.contextWindowTokens).toBe(100_000);
  });

  it("never goes negative on a tiny window", () => {
    const result = computeBudget({
      contextWindowTokens: 1000,
      compactThreshold: 0.5,
      reservedOutputTokens: 8000,
      compactKeepRecent: 8,
      systemPromptTokens: 100,
    });
    expect(result.historyTokens).toBe(0);
  });
});

describe("isClosedAt / findCutIndex", () => {
  const messages = [
    text("user", "do it"),
    toolUse("t1"),
    toolResult("t1", "output"),
    text("assistant", "done"),
  ];

  it("treats a boundary with an unanswered tool_use as not closed", () => {
    expect(isClosedAt(messages, 2)).toBe(false);
  });

  it("treats a boundary after the tool_result as closed", () => {
    expect(isClosedAt(messages, 3)).toBe(true);
  });

  it("walks back to the nearest closed boundary", () => {
    // 2 would split the pair, so it must fall back to 1.
    expect(findCutIndex(messages, 2)).toBe(1);
  });

  it("returns 0 when no closed boundary exists below the preference", () => {
    expect(findCutIndex([toolUse("t1")], 1)).toBe(0);
  });
});

describe("buildSendView", () => {
  it("sends the full history when it fits", () => {
    const s = session([text("user", "hi"), text("assistant", "hello")]);
    const view = buildSendView(s, budget(10_000));

    expect(view.level).toBe("full");
    expect(view.needsCompaction).toBe(false);
    expect(view.messages).toHaveLength(2);
  });

  it("never mutates the session", () => {
    const big = "Y".repeat(40_000);
    const s = session([text("user", "hi"), toolUse("t1"), toolResult("t1", big)]);
    const before = structuredClone(s.messages);

    buildSendView(s, budget(10));

    expect(s.messages).toEqual(before);
  });

  it("omits old tool_result content when over budget", () => {
    const big = "Y".repeat(40_000);
    const s = session([text("user", "hi"), toolUse("t1"), toolResult("t1", big)]);

    const view = buildSendView(s, budget(500));

    expect(view.level).toBe("omitted");
    const sent = JSON.stringify(view.messages);
    expect(sent).toContain("omitted, original content was 40000 chars");
    expect(sent).not.toContain(big);
  });

  it("asks for compaction when omitting is not enough", () => {
    // Bulk in tool_use input, which omission cannot touch.
    const messages = [
      text("user", "hi"),
      toolUse("t1", { command: "Z".repeat(40_000) }),
      toolResult("t1", "ok"),
      text("assistant", "done"),
    ];

    const view = buildSendView(session(messages), budget(100));

    expect(view.needsCompaction).toBe(true);
    expect(view.suggestedCutIndex).toBeGreaterThan(0);
  });

  it("replaces compacted messages with the summary and keeps the rest", () => {
    const messages = [
      text("user", "old one"),
      text("assistant", "old reply"),
      text("user", "recent"),
    ];
    const s = session(messages, [
      { upToIndex: 2, summary: "EARLIER: talked about old things", tokensBefore: 10, createdAt: "" },
    ]);

    const view = buildSendView(s, budget(10_000));

    expect(view.level).toBe("compacted");
    expect(view.messages).toHaveLength(2);
    expect(JSON.stringify(view.messages[0])).toContain("EARLIER: talked about old things");
    expect(view.messages[1]).toEqual(messages[2]);
    expect(JSON.stringify(view.messages)).not.toContain("old reply");
  });

  it("does not ask to re-compact ground an existing summary already covers", () => {
    const messages = [text("user", "a"), text("assistant", "b"), text("user", "c")];
    const s = session(messages, [
      { upToIndex: 3, summary: "everything so far", tokensBefore: 10, createdAt: "" },
    ]);

    // Budget of 0 forces degradation, but there is nothing new to compact.
    const view = buildSendView(s, budget(0));
    expect(view.needsCompaction).toBe(false);
  });
});

describe("activeCompaction", () => {
  it("picks the summary covering the most messages", () => {
    const s = session([], [
      { upToIndex: 4, summary: "first", tokensBefore: 1, createdAt: "" },
      { upToIndex: 12, summary: "second", tokensBefore: 1, createdAt: "" },
    ]);
    expect(activeCompaction(s)?.summary).toBe("second");
  });

  it("returns undefined for a session that has never been compacted", () => {
    expect(activeCompaction(session([]))).toBeUndefined();
  });
});

describe("renderForSummary", () => {
  it("renders text, calls and results in a readable transcript", () => {
    const rendered = renderForSummary([
      text("user", "fix the bug"),
      toolUse("t1", { command: "npm test" }),
      toolResult("t1", "2 failing"),
    ]);

    expect(rendered).toContain("USER: fix the bug");
    expect(rendered).toContain("TOOL CALL bash");
    expect(rendered).toContain("npm test");
    expect(rendered).toContain("TOOL RESULT: 2 failing");
  });

  it("caps a huge tool result so the summarizer request stays sane", () => {
    const rendered = renderForSummary([toolResult("t1", "X".repeat(10_000))]);
    expect(rendered.length).toBeLessThan(2500);
  });
});

describe("budgetWarning (spec §3.1)", () => {
  const inputs = {
    contextWindowTokens: 65_536,
    compactThreshold: 0.75,
    reservedOutputTokens: 8192,
    compactKeepRecent: 8,
    systemPromptTokens: 1200,
  };

  it("stays silent on a healthy budget", () => {
    expect(budgetWarning(computeBudget(inputs), inputs, 2000)).toEqual([]);
  });

  it("warns when the budget is zero", () => {
    const tiny = { ...inputs, contextWindowTokens: 8000 };
    const lines = budgetWarning(computeBudget(tiny), tiny, 2000);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/no context left/i);
  });

  it("warns when the budget is merely too small, not just zero", () => {
    const small = { ...inputs, contextWindowTokens: 14_000 };
    const budget = computeBudget(small);

    expect(budget.historyTokens).toBeGreaterThan(0);
    expect(budgetWarning(budget, small, 2000)[0]).toMatch(/only \d+ tokens/i);
  });

  it("shows every term of the arithmetic so the user knows which knob to turn", () => {
    const tiny = { ...inputs, contextWindowTokens: 8000 };
    const text = budgetWarning(computeBudget(tiny), tiny, 2000).join("\n");

    expect(text).toContain("8000");
    expect(text).toContain("COMPACT_THRESHOLD");
    expect(text).toContain("RESERVED_OUTPUT_TOKENS");
    expect(text).toContain("system prompt");
  });

  it("blames the reserved output when that is what ate the window", () => {
    const tiny = { ...inputs, contextWindowTokens: 8000 };
    const text = budgetWarning(computeBudget(tiny), tiny, 2000).join("\n");
    expect(text).toMatch(/RESERVED_OUTPUT_TOKENS is eating/);
  });

  it("blames memory when memory is the biggest share", () => {
    // Reserved output kept modest so memory is unambiguously the culprit.
    const memoryHeavy = {
      ...inputs,
      contextWindowTokens: 12_000,
      reservedOutputTokens: 2000,
      systemPromptTokens: 6000,
    };
    const text = budgetWarning(computeBudget(memoryHeavy), memoryHeavy, 2000, 5800).join("\n");

    expect(text).toMatch(/memory is eating/);
    expect(text).toContain("of which memory: 5800");
  });

  it("suggests raising the window when nothing else stands out", () => {
    const narrow = { ...inputs, contextWindowTokens: 4600, reservedOutputTokens: 500 };
    const text = budgetWarning(computeBudget(narrow), narrow, 2000).join("\n");
    expect(text).toMatch(/raise CONTEXT_WINDOW_TOKENS/);
  });

  it("does not fire for either shipped provider on default settings", () => {
    for (const window of [200_000, 65_536]) {
      const real = { ...inputs, contextWindowTokens: window, systemPromptTokens: 5200 };
      expect(budgetWarning(computeBudget(real), real, 2000)).toEqual([]);
    }
  });
});
