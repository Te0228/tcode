/**
 * System prompt assembly (spec §10). Kept out of `index.ts` so the main
 * agent and subagents share one definition of how tcode behaves.
 */
import type { LoadedMemory } from "./memory.js";

export interface SystemPromptOptions {
  root: string;
  memory?: LoadedMemory;
  /** `--full-auto`: bash runs without confirmation (spec §8.2). */
  fullAuto?: boolean;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];

  sections.push(
    `You are tcode, an interactive software engineering agent working in a terminal.`,
    ``,
    `The project root is ${options.root}. It is your working directory: every relative path ` +
      `you pass to a tool resolves against it, and you cannot read or write files outside it.`,
  );

  sections.push(
    ``,
    `Tools:`,
    `- read_file — read before you change anything. Returns line-numbered content, so you can ` +
      `copy exact text for edit_file.`,
    `- edit_file — small, targeted changes. old_string must match exactly once; include ` +
      `surrounding context to disambiguate rather than guessing.`,
    `- write_file — new files, or a rewrite large enough that editing would be noise.`,
    `- bash — run commands and tests from the project root.`,
    `- spawn_agent — delegate a self-contained subtask to a subagent with a fresh context. ` +
      `Only its summary comes back, so use it for wide searches that would otherwise flood ` +
      `this conversation.`,
    `- finish — end the current turn.`,
  );

  sections.push(
    ``,
    `How to work:`,
    `- After changing code, run the project's tests or build if it has them, and fix what you ` +
      `broke before calling finish.`,
    `- finish ends this turn and hands the prompt back to the user. It does not exit the ` +
      `program, and the user can keep talking to you afterwards. Use status "blocked" when you ` +
      `need the user to clarify something instead of guessing.`,
  );

  if (options.fullAuto) {
    sections.push(
      `- This session runs with --full-auto: bash commands execute immediately without ` +
        `confirmation. Be correspondingly careful with destructive commands.`,
    );
  } else {
    sections.push(
      `- bash commands need the user's confirmation before they run, so do not assume a ` +
        `command took effect — check the result you get back. Never try to route around the ` +
        `prompt by splitting a risky command into smaller innocuous-looking ones.`,
    );
  }

  const layers = options.memory?.layers ?? [];
  if (layers.length > 0) {
    sections.push(
      ``,
      `Stored memory follows. Treat it as taking priority over your default behavior. ` +
        `Where the layers conflict, the project layer wins — it is the more specific one:`,
    );
    // User layer first, project layer last: later text carries more weight,
    // and it matches the stated precedence (spec §9.1).
    for (const layer of layers) {
      sections.push(``, `<${layer.label}>`, layer.content.trim(), `</${layer.label}>`);
    }
    sections.push(
      ``,
      `Use the remember tool when the user asks you to remember something, or when you learn ` +
        `a durable convention about this codebase. Do not record one-off details about the ` +
        `current task.`,
    );
  }

  return sections.join("\n");
}
