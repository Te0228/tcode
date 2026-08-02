import { executor } from "../executor.js";
import {
  ToolError,
  optionalNumber,
  requireString,
  truncateOutput,
  type Tool,
} from "./types.js";

export const BASH_TOOL_NAME = "bash";

/**
 * Runs a shell command in the project root (spec §5.1). No allowlist and
 * no sandbox — the pre-execution confirmation in `approval.ts` is v1's
 * only safety net, and `cwd` is the only scoping applied (spec §6).
 */
export const bashTool: Tool = {
  schema: {
    name: BASH_TOOL_NAME,
    description:
      "Run a shell command in the project root and return its stdout, stderr and exit code. " +
      "Blocks until the command exits or times out, so it cannot host long-running processes " +
      "(dev servers, watchers). Requires user confirmation unless started with --full-auto.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        timeout_ms: { type: "number", description: "Timeout in ms; defaults to COMMAND_TIMEOUT_MS." },
      },
      required: ["command"],
    },
  },

  async execute(input, context) {
    const command = requireString(input, "command");
    const timeoutMs = optionalNumber(input, "timeout_ms") ?? context.config.commandTimeoutMs;

    const result = await executor.run(command, { cwd: context.root, timeoutMs });

    if (result.timedOut) {
      throw new ToolError(
        `command timed out after ${timeoutMs}ms: ${command}\n` +
          formatStreams(result.stdout, result.stderr, context.config.maxOutputChars),
      );
    }

    const streams = formatStreams(result.stdout, result.stderr, context.config.maxOutputChars);
    return `exit code: ${result.exitCode}\n${streams}`;
  },
};

/** Split the budget across both streams so a noisy stdout can't crowd out
 * the stderr that usually explains the failure. */
function formatStreams(stdout: string, stderr: string, maxOutputChars: number): string {
  const perStream = Math.floor(maxOutputChars / 2);
  const parts = [`stdout:\n${truncateOutput(stdout, perStream) || "(empty)"}`];
  if (stderr.trim()) {
    parts.push(`stderr:\n${truncateOutput(stderr, perStream)}`);
  }
  return parts.join("\n\n");
}
