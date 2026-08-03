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
  /** Interrupt signal (spec §3.2) — long-running tools should honour it. */
  signal?: AbortSignal;
}

/**
 * A line a tool wants shown to the user (spec §14.4 P0).
 *
 * `tone` is semantic, not a colour: tools must not know what red means, or
 * whether colour is on at all. `ui/format.ts` maps tone to style.
 */
export interface DisplayLine {
  text: string;
  tone?: "plain" | "added" | "removed" | "error" | "muted";
  /** Language for syntax highlighting (spec §16.8). Absent or "none"
   * leaves the line as written — guessing wrong is worse than plain. */
  code?: "c-like" | "hash" | "lisp" | "sql" | "none";
}

/**
 * What a tool returns when the terminal and the model need different
 * things (spec §14.4 P0).
 *
 * The two are deliberately separate paths. The model gets the full,
 * untruncated `result`; the user gets `display`, which is allowed to be a
 * diff, a line count, or the first few lines of a build log. Truncating one
 * must never affect the other — the old shape had a single string, so
 * everything shown to the user was also everything sent to the model, and
 * the way out was to show nothing at all.
 */
export interface ToolOutcome {
  /** Content of the `tool_result` — what the model sees. */
  result: string;
  /** What to print under the tool call. Omitted means "nothing to show":
   * the call line alone already said it. */
  display?: DisplayLine[];
  /** The tool completed but the thing it ran failed (a non-zero exit).
   * Not the same as throwing, which is the tool itself failing. */
  failed?: boolean;
  /** Right-aligned outcome on the tool's call line: `128 lines`, `+3 -1`,
   * `exit 1` (spec §16.9). */
  meta?: string;
}

export type ToolReturn = string | ToolOutcome;

export interface Tool {
  schema: ToolDefinition;
  /** True when the tool prints while it runs (`spawn_agent` streams a
   * subagent's progress). Its call line has to be printed *before*
   * execution, or that output lands above its own heading (spec §16.9). */
  streamsOutput?: boolean;
  execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolReturn> | ToolReturn;
}

/** A bare string still means "this is both the result and nothing to
 * show" — the common case for tools whose call line says it all. */
export function normalizeToolReturn(value: ToolReturn): ToolOutcome {
  return typeof value === "string" ? { result: value } : value;
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
