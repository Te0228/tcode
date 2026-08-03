import { executor } from "../executor.js";
import { outputLines } from "../ui/format.js";
import {
  ToolError,
  optionalNumber,
  requireString,
  truncateOutput,
  type DisplayLine,
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

    const result = await executor.run(command, {
      cwd: context.root,
      timeoutMs,
      signal: context.signal,
    });

    if (result.interrupted) {
      // Not an error: the user asked for this, and the output collected so
      // far is still worth keeping (spec §3.2).
      return {
        result:
          `[interrupted by user]\n` +
          formatStreams(result.stdout, result.stderr, context.config.maxOutputChars),
        display: outputLines(result.stdout),
      };
    }

    if (result.timedOut) {
      throw new ToolError(
        `command timed out after ${timeoutMs}ms: ${command}\n` +
          formatStreams(result.stdout, result.stderr, context.config.maxOutputChars),
      );
    }

    const streams = formatStreams(result.stdout, result.stderr, context.config.maxOutputChars);
    const failed = result.exitCode !== 0;

    // What the user sees on failure is the exit code and stderr — the
    // reason. On success it is stdout, the thing they asked for. Before
    // this, both cases showed nothing and looked identical (spec §14.1).
    // The exit code rides on the call line now (spec §16.9), so the block
    // below carries only the reason: stderr on failure, stdout otherwise.
    const display: DisplayLine[] = failed
      ? outputLines(result.stderr || result.stdout, "error")
      : outputLines(result.stdout);

    return {
      result: `exit code: ${result.exitCode}\n${streams}`,
      display,
      failed,
      meta: `exit ${result.exitCode}`,
    };
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
