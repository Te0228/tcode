import path from "node:path";
import { appendMemory, type MemoryScope } from "../memory.js";
import { ToolError, requireString, type Tool } from "./types.js";

export const REMEMBER_TOOL_NAME = "remember";

function isScope(value: string): value is MemoryScope {
  return value === "user" || value === "project";
}

/**
 * Appends to layered memory (spec §5.7/§9.2).
 *
 * Note the missing `path` parameter — that omission is the security
 * design. `scope: "user"` writes outside ROOT, the single exception to
 * the directory scoping in spec §6; it is only safe because the
 * destination is fixed in code and the model cannot influence it.
 */
export const rememberTool: Tool = {
  schema: {
    name: REMEMBER_TOOL_NAME,
    description:
      "Record something worth remembering across sessions. Use scope 'project' for conventions " +
      "specific to this codebase (commands, architecture decisions, gotchas) and 'user' for the " +
      "user's standing personal preferences that apply everywhere. Only record things with " +
      "lasting value — not one-off details about the current task.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["user", "project"],
          description: "'project' for this codebase, 'user' for cross-project preferences.",
        },
        content: {
          type: "string",
          description: "One self-contained note. It must make sense read months later, alone.",
        },
      },
      required: ["scope", "content"],
    },
  },

  execute(input, context) {
    const scope = requireString(input, "scope");
    const content = requireString(input, "content");

    if (!isScope(scope)) {
      throw new ToolError(`scope must be "user" or "project", got "${scope}"`);
    }
    if (!content.trim()) {
      throw new ToolError("content must not be empty");
    }

    const file = appendMemory(scope, content, context.root);

    // Always visible: memory outlives the session, so the user must be
    // able to see what the agent recorded (spec §5.7).
    context.log(`✎ remembered (${scope}) → ${path.basename(file)}: ${content.trim()}`);

    return `recorded to ${scope} memory (${file})`;
  },
};
