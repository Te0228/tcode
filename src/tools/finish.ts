import { ToolError, requireString, type Tool } from "./types.js";

export const FINISH_TOOL_NAME = "finish";

/**
 * Pure signal tool (spec §5.5): no side effects, echoes its args back as
 * the tool_result. The agent loop still executes it in batch order and
 * refills its result like any other tool — it just doesn't call the LLM
 * again afterwards (spec §3).
 */
export const finishTool: Tool = {
  schema: {
    name: FINISH_TOOL_NAME,
    description:
      "Signal that this turn's work is complete. Ends the current turn and returns control " +
      "to the user — it does NOT exit the program. Use status 'blocked' if you need the user " +
      "to clarify something before you can continue.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What you did, or what you're blocked on." },
        status: {
          type: "string",
          enum: ["done", "blocked"],
          description: "Turn outcome; defaults to 'done'.",
        },
      },
      required: ["summary"],
    },
  },

  execute(input) {
    const summary = requireString(input, "summary");
    // Optional by decision, not by laziness (spec §5.5): models routinely
    // send only a summary, and rejecting that printed a red "status is
    // required" underneath the green ✓ of a turn the loop had already
    // accepted as finished.
    const status = input.status ?? "done";
    if (status !== "done" && status !== "blocked") {
      throw new ToolError(`status must be "done" or "blocked", got "${String(status)}"`);
    }
    return `[${status}] ${summary}`;
  },
};

export interface FinishPayload {
  summary: string;
  status: "done" | "blocked";
}

/** Reads a `finish` tool_use's input for display/subagent return (spec §5.6). */
export function finishPayloadOf(input: unknown): FinishPayload | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { summary, status } = input as Record<string, unknown>;
  if (typeof summary !== "string") return undefined;
  return { summary, status: status === "blocked" ? "blocked" : "done" };
}
