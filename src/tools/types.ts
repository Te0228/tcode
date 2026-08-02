/**
 * Tool contract shared by the registry (spec §5/§7). A tool's `execute`
 * returns the string that becomes the `tool_result` content; throwing is
 * how a tool reports failure — `agent.ts` catches and refills the result
 * with `is_error: true` (spec §3) rather than crashing the turn.
 */
import type { Config } from "../config.js";
import type { ToolDefinition } from "../llm/types.js";
import type { Tracer } from "../trace.js";

export interface ToolContext {
  /** Project root; every path tool resolves against this (spec §6). */
  root: string;
  config: Config;
  /** Terminal output sink — subagents pass a prefixing logger (spec §5.6). */
  log: (line: string) => void;
  /** Event log, so a tool that runs a nested agent can trace into it
   * (spec §13). Tools that don't need it can ignore it. */
  tracer: Tracer;
}

export interface Tool {
  schema: ToolDefinition;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<string> | string;
}

/** Thrown for expected, model-correctable failures (bad args, no match). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string") {
    throw new ToolError(`"${field}" is required and must be a string`);
  }
  return value;
}

export function optionalNumber(
  input: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolError(`"${field}" must be a number`);
  }
  return value;
}

/**
 * Head/tail truncation (spec §5.1): keeps the first and last half of the
 * budget with a marker in between, so both the start of a build log and
 * the error at its end survive.
 */
export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n\n... [truncated ${omitted} chars] ...\n\n${text.slice(-half)}`;
}
