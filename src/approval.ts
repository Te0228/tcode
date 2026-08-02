/**
 * Approval policy (spec §3/§5.1/§7). v1 has exactly one rule — `bash`
 * needs confirmation, everything else doesn't — kept behind this seam so
 * upgrading to a tiered policy (untrusted/on-failure/on-request/never)
 * touches only this file.
 */
import readline from "node:readline";
import { BASH_TOOL_NAME } from "./tools/bash.js";
import type { ToolUseBlock } from "./llm/types.js";

export interface ApprovalPolicy {
  needsConfirmation(toolUse: ToolUseBlock): boolean;
  confirm(toolUse: ToolUseBlock): Promise<boolean>;
}

export interface ApprovalOptions {
  /** `--full-auto` startup flag: skip confirmation entirely (spec §8.2). */
  fullAuto?: boolean;
  /** Prompt hook, injected in tests so no TTY is needed. */
  prompt?: (question: string) => Promise<string>;
}

/** Fallback only. A caller that already owns stdin (the REPL does) must
 * inject its own `prompt` — a second readline interface on the same stdin
 * silently swallows the answer. */
async function promptOnStdin(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

export function createApprovalPolicy(options: ApprovalOptions = {}): ApprovalPolicy {
  const ask = options.prompt ?? promptOnStdin;

  return {
    needsConfirmation(toolUse) {
      if (options.fullAuto) return false;
      return toolUse.name === BASH_TOOL_NAME;
    },

    // The loop already printed a summary line for this tool_use (spec §3),
    // so the prompt doesn't repeat the command.
    async confirm() {
      const answer = (await ask(`  run this? [Y/n] `)).trim().toLowerCase();
      // Enter (empty answer) means yes; only an explicit "n"/"no" declines.
      return answer !== "n" && answer !== "no";
    },
  };
}
