/**
 * Single-level, serial subtask delegation (spec §5.6). Not a multi-agent
 * orchestrator — one subagent at a time, blocking, reusing `runTurn`
 * rather than a second loop implementation.
 */
import { runTurn, type AgentDeps } from "../agent.js";
import type { Session } from "../session.js";
import { BASE_TOOLS, type ToolRegistry } from "./index.js";
import { ToolError, requireString, type Tool } from "./types.js";

export const SPAWN_AGENT_TOOL_NAME = "spawn_agent";

export type SubagentRole = "general" | "explore";

/** Role -> allowed tool names. `spawn_agent` is absent from every row:
 * recursion is prevented by the subagent physically not having the tool,
 * not by asking the model nicely (spec §5.6). */
export const ROLE_TOOLS: Record<SubagentRole, string[]> = {
  general: ["bash", "read_file", "edit_file", "write_file", "remember", "finish"],
  // Read-only investigation: no file writes, and no memory writes either —
  // a subagent shouldn't be recording lasting conventions off a search task.
  explore: ["bash", "read_file", "finish"],
};

export function toolsForRole(role: SubagentRole, registry: ToolRegistry = BASE_TOOLS): ToolRegistry {
  const allowed = ROLE_TOOLS[role];
  const subset: ToolRegistry = {};
  for (const name of allowed) {
    const tool = registry[name];
    if (tool) subset[name] = tool;
  }
  return subset;
}

function isRole(value: string): value is SubagentRole {
  return value === "general" || value === "explore";
}

export interface SpawnAgentDeps {
  deps: AgentDeps;
  /** Injected in tests; defaults to the real loop. */
  runTurn?: typeof runTurn;
}

export function createSpawnAgentTool(spawn: SpawnAgentDeps): Tool {
  const run = spawn.runTurn ?? runTurn;

  return {
    schema: {
      name: SPAWN_AGENT_TOOL_NAME,
      description:
        "Delegate a self-contained subtask to a subagent with a fresh, empty context. " +
        "Only the subagent's final summary comes back — its intermediate steps never enter " +
        "this conversation, so use it for searching or exploration that would otherwise " +
        "flood the context. Use role 'explore' for read-only investigation, 'general' when " +
        "the subtask needs to modify files.",
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "Self-contained instructions. The subagent sees none of this conversation, " +
              "so include every detail it needs.",
          },
          role: { type: "string", enum: ["general", "explore"], description: "Tool set to grant." },
        },
        required: ["task", "role"],
      },
    },

    async execute(input, context) {
      const task = requireString(input, "task");
      const role = requireString(input, "role");
      if (!isRole(role)) {
        throw new ToolError(`role must be "general" or "explore", got "${role}"`);
      }

      context.tracer.emit("subagent_start", { role, task });
      context.log(`⇢ subagent [${role}] started`);

      // Fresh, empty history — the subagent shares nothing with the main
      // session, and this throwaway session is never persisted (spec §5.6).
      const subSession: Session = {
        id: `subagent-${role}`,
        cwd: context.root,
        provider: "",
        model: "",
        createdAt: "",
        updatedAt: "",
        messages: [],
      };

      const prefixed = (line: string) => context.log(`  │ ${line}`);
      // Streamed text arrives as fragments; buffer to line boundaries so
      // the subagent's output stays visibly nested (spec §5.6).
      let pending = "";
      const writeText = (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) prefixed(line);
      };

      const result = await run(subSession, task, spawn.deps, {
        tools: toolsForRole(role),
        log: prefixed,
        writeText,
        persist: () => {},
        // Same trace file, one level deeper: the subagent's steps are the
        // most interesting thing to visualize, and they never enter the
        // main session (spec §5.6/§13.1).
        tracer: context.tracer.child(),
        // Interrupt the subagent too, or the main loop stops while the
        // subagent keeps working (spec §3.2).
        signal: context.signal,
      });

      if (pending) prefixed(pending);
      context.tracer.emit("subagent_end", {
        role,
        outcome: result.outcome,
        summary: result.finish?.summary ?? result.lastText,
      });
      context.log(`⇠ subagent [${role}] ${result.outcome}`);

      // Only the summary crosses back into the main session — that's the
      // whole point of delegating (spec §5.6).
      if (result.finish) {
        return `[${result.finish.status}] ${result.finish.summary}`;
      }
      if (result.outcome === "max_iterations") {
        return (
          `subagent hit the tool-iteration limit without finishing. ` +
          `Last thing it said: ${result.lastText || "(nothing)"}`
        );
      }
      return result.lastText || "subagent returned no summary";
    },
  };
}

/** Builds the full registry, including `spawn_agent`. Kept here rather
 * than in `tools/index.ts` so the tool -> agent -> registry dependency
 * doesn't become a cycle. */
export function createToolRegistry(deps: AgentDeps): ToolRegistry {
  return {
    ...BASE_TOOLS,
    [SPAWN_AGENT_TOOL_NAME]: createSpawnAgentTool({ deps }),
  };
}
