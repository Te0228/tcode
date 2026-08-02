/**
 * Tool registry (spec §5/§7): name -> { schema, execute }. The registry
 * shape is also the MCP extension point — adding a tool means adding a
 * row here, nothing in `agent.ts` changes.
 *
 * `spawn_agent` is NOT registered here: it depends on `agent.ts`, which
 * depends on this registry. `createToolRegistry()` in `spawn_agent.ts`
 * composes the two without a cycle.
 */
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit_file.js";
import { finishTool } from "./finish.js";
import { readFileTool } from "./read_file.js";
import { rememberTool } from "./remember.js";
import { writeFileTool } from "./write_file.js";
import type { Tool } from "./types.js";

export type ToolRegistry = Record<string, Tool>;

export const BASE_TOOLS: ToolRegistry = {
  [bashTool.schema.name]: bashTool,
  [readFileTool.schema.name]: readFileTool,
  [editFileTool.schema.name]: editFileTool,
  [writeFileTool.schema.name]: writeFileTool,
  [rememberTool.schema.name]: rememberTool,
  [finishTool.schema.name]: finishTool,
};

export function schemasOf(registry: ToolRegistry) {
  return Object.values(registry).map((tool) => tool.schema);
}

export { bashTool, editFileTool, finishTool, readFileTool, rememberTool, writeFileTool };
export * from "./types.js";
