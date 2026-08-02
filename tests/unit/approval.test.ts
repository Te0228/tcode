import { describe, expect, it, vi } from "vitest";
import { createApprovalPolicy, judgeCommand } from "../../src/approval.js";
import type { ToolUseBlock } from "../../src/llm/types.js";

const ROOT = "/proj";

function bash(command: string): ToolUseBlock {
  return { type: "tool_use", id: "t1", name: "bash", input: { command } };
}

function toolUse(name: string, input: unknown = {}): ToolUseBlock {
  return { type: "tool_use", id: "t1", name, input };
}

const judge = (command: string) => judgeCommand(command, ROOT);

describe("judgeCommand: reading is always allowed (spec §5.1)", () => {
  it.each([
    "ls -la",
    "cat src/index.ts",
    "grep -r foo src/",
    "find . -name '*.ts'",
    "git status",
    "git log --oneline",
    "git diff HEAD~1",
  ])("allows %s", (command) => {
    expect(judge(command).needsConfirmation).toBe(false);
  });

  it.each([
    "cat /etc/hosts",
    "ls /usr/local/bin",
    "grep -r pattern /var/log",
    "head -5 /etc/passwd",
  ])("allows reading outside the project too: %s", (command) => {
    // Reading a system file breaks nothing; prompting for it is pure noise.
    expect(judge(command).needsConfirmation).toBe(false);
  });
});

describe("judgeCommand: writing inside the project is allowed", () => {
  it.each([
    "npm test",
    "npm run build",
    "npm install lodash",
    "rm -rf node_modules",
    "mkdir -p src/new",
    "echo hi > out.txt",
    "node dist/index.js 2>/dev/null",
    "touch src/a.ts && npm test",
  ])("allows %s", (command) => {
    expect(judge(command).needsConfirmation).toBe(false);
  });
});

describe("judgeCommand: writing outside the project needs confirmation", () => {
  it.each([
    ["cat a.txt > /etc/hosts", /outside the project/],
    ["echo x >> ../outside.txt", /outside the project/],
    ["rm -rf ~/Documents", /outside the project/],
    ["mv src/a.ts $HOME/a.ts", /outside the project/],
  ])("confirms %s", (command, reason) => {
    const decision = judge(command);
    expect(decision.needsConfirmation).toBe(true);
    expect(decision.reason).toMatch(reason);
  });

  it("confirms privilege escalation", () => {
    expect(judge("sudo rm -rf /").reason).toMatch(/elevated privileges/);
  });

  it.each(["brew install jq", "apt-get install curl", "systemctl restart nginx"])(
    "confirms system administration: %s",
    (command) => {
      expect(judge(command).reason).toMatch(/system state/);
    },
  );

  it("confirms a global install but not a local one", () => {
    expect(judge("npm i -g typescript").needsConfirmation).toBe(true);
    expect(judge("npm i typescript").needsConfirmation).toBe(false);
  });

  it("confirms git push but not other git subcommands", () => {
    expect(judge("git push origin main").reason).toMatch(/publishes/);
    expect(judge("git commit -m x").needsConfirmation).toBe(false);
  });
});

describe("judgeCommand: judged per segment, not by the first word", () => {
  it("does not let a read-only prefix smuggle a dangerous tail through", () => {
    // The whole point of splitting: `ls` must not vouch for `rm -rf ~`.
    expect(judge("ls && rm -rf ~/Documents").needsConfirmation).toBe(true);
    expect(judge("cat /etc/passwd | tee /etc/shadow").needsConfirmation).toBe(true);
    expect(judge("npm test; sudo reboot").needsConfirmation).toBe(true);
  });

  it("does not flag a read command just because it redirects to /dev/null", () => {
    expect(judge("npm test > /dev/null 2>&1").needsConfirmation).toBe(false);
  });

  it("does not flag a flag that looks like a path", () => {
    expect(judge("npm test --reporter=verbose").needsConfirmation).toBe(false);
  });
});

describe("needsConfirmation: which tools are subject to it at all", () => {
  const policy = createApprovalPolicy({ root: ROOT });

  it.each(["read_file", "edit_file", "write_file", "finish", "remember", "spawn_agent"])(
    "never asks for %s — those are hard-bounded by resolveInRoot",
    (name) => {
      expect(policy.needsConfirmation(toolUse(name))).toBe(false);
    },
  );

  it("asks for a dangerous bash command", () => {
    expect(policy.needsConfirmation(bash("sudo rm -rf /"))).toBe(true);
  });

  it("does not ask for an ordinary bash command", () => {
    expect(policy.needsConfirmation(bash("npm test"))).toBe(false);
  });

  it("is always false under --full-auto, even for the worst command", () => {
    const auto = createApprovalPolicy({ root: ROOT, fullAuto: true });
    expect(auto.needsConfirmation(bash("sudo rm -rf /"))).toBe(false);
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
    const policy = createApprovalPolicy({ root: ROOT, prompt: async () => answer });
    expect(await policy.confirm(bash("sudo rm -rf /"))).toBe(expected);
  });

  it("explains why it is asking, so the prompt is not a blind y/n", () => {
    const prompt = vi.fn().mockResolvedValue("y");
    const policy = createApprovalPolicy({ root: ROOT, prompt });

    void policy.confirm(bash("sudo rm -rf /"));

    expect(prompt).toHaveBeenCalledWith(expect.stringMatching(/elevated privileges/));
  });
});
