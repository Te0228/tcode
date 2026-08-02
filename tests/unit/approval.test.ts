import { describe, expect, it, vi } from "vitest";
import { createApprovalPolicy } from "../../src/approval.js";
import type { ToolUseBlock } from "../../src/llm/types.js";

function toolUse(name: string, input: unknown = {}): ToolUseBlock {
  return { type: "tool_use", id: "t1", name, input };
}

describe("needsConfirmation", () => {
  it("requires confirmation for bash", () => {
    const policy = createApprovalPolicy();
    expect(policy.needsConfirmation(toolUse("bash", { command: "ls" }))).toBe(true);
  });

  it.each(["read_file", "edit_file", "write_file", "finish", "spawn_agent"])(
    "does not require confirmation for %s",
    (name) => {
      const policy = createApprovalPolicy();
      expect(policy.needsConfirmation(toolUse(name))).toBe(false);
    },
  );

  it("is always false under --full-auto, including for bash", () => {
    const policy = createApprovalPolicy({ fullAuto: true });
    expect(policy.needsConfirmation(toolUse("bash", { command: "rm -rf /" }))).toBe(false);
  });
});

describe("confirm", () => {
  it.each([
    ["y", true],
    ["Y", true],
    ["yes", true],
    ["", true],
    ["   ", true],
    ["n", false],
    ["N", false],
    ["no", false],
  ])("maps answer %j to %s", async (answer, expected) => {
    const policy = createApprovalPolicy({ prompt: async () => answer });
    expect(await policy.confirm(toolUse("bash", { command: "ls" }))).toBe(expected);
  });

  // The command itself is printed by the loop's summary line (spec §3),
  // so repeating it here would double it on screen.
  it("asks a yes/no question with yes as the default", async () => {
    const prompt = vi.fn().mockResolvedValue("y");
    const policy = createApprovalPolicy({ prompt });

    await policy.confirm(toolUse("bash", { command: "npm test" }));

    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("[Y/n]"));
  });
});
