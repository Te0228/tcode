/**
 * Append-only event log (spec §13). Parallel to the session, with the
 * opposite job: the session holds what we send to the model (lean, gets
 * trimmed), the trace holds what actually happened (complete, timestamped,
 * never rewritten) — including subagent internals, which deliberately
 * never enter the session.
 *
 * Tracing is auxiliary. A write failure warns once and degrades to a
 * no-op; it must never take down the user's turn.
 */
import fs from "node:fs";
import path from "node:path";

export interface TraceEvent {
  seq: number;
  t: number;
  /** Nesting level: 0 for the main agent, 1 for a subagent (spec §13.2). */
  depth: number;
  type: string;
  [key: string]: unknown;
}

export interface Tracer {
  emit(type: string, data?: Record<string, unknown>): void;
  /** A tracer writing to the same sink one level deeper (spec §5.6/§13.2). */
  child(): Tracer;
}

export const NOOP_TRACER: Tracer = {
  emit() {},
  child() {
    return NOOP_TRACER;
  },
};

export function tracesDir(cwd: string): string {
  return path.join(cwd, ".tcode", "traces");
}

export function tracePath(cwd: string, sessionId: string): string {
  return path.join(tracesDir(cwd), `${sessionId}.jsonl`);
}

/** Shared mutable state so `child()` tracers keep one sequence and one
 * "already warned" flag across the whole session. */
interface TraceSink {
  file: string;
  seq: number;
  broken: boolean;
  warn: (message: string) => void;
}

function write(sink: TraceSink, event: TraceEvent): void {
  if (sink.broken) return;
  try {
    fs.appendFileSync(sink.file, `${JSON.stringify(event)}\n`);
  } catch (error) {
    // Warn once, then stay quiet: a full disk should not produce one
    // warning per tool call.
    sink.broken = true;
    sink.warn(
      `tracing disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function tracerFor(sink: TraceSink, depth: number): Tracer {
  return {
    emit(type, data) {
      write(sink, { seq: sink.seq++, t: Date.now(), depth, type, ...data });
    },
    child() {
      return tracerFor(sink, depth + 1);
    },
  };
}

export interface FileTracerOptions {
  cwd: string;
  sessionId: string;
  /** Where the one-time failure warning goes. */
  warn?: (message: string) => void;
}

/**
 * Opens (or reopens) the trace for a session. `--continue`/`--resume`
 * append to the same file so one conversation stays in one file.
 */
export function createFileTracer(options: FileTracerOptions): Tracer {
  const file = tracePath(options.cwd, options.sessionId);
  const warn = options.warn ?? ((message: string) => console.error(message));

  try {
    fs.mkdirSync(tracesDir(options.cwd), { recursive: true });
  } catch (error) {
    warn(`tracing disabled: ${error instanceof Error ? error.message : String(error)}`);
    return NOOP_TRACER;
  }

  // Continue the sequence across restarts so ordering stays total.
  const sink: TraceSink = { file, seq: countExistingEvents(file), broken: false, warn };
  return tracerFor(sink, 0);
}

function countExistingEvents(file: string): number {
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.split("\n").filter((line) => line.trim()).length;
  } catch {
    return 0; // No prior trace — start at 0.
  }
}

/** `TRACE=off` disables tracing entirely (spec §13.3). */
export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TRACE ?? "on").trim().toLowerCase() !== "off";
}

/** Reads a trace back for the viewer. Malformed lines are skipped rather
 * than failing the whole read — a trace truncated by a crash should still
 * be viewable. */
export function readTrace(cwd: string, sessionId: string): TraceEvent[] {
  let content: string;
  try {
    content = fs.readFileSync(tracePath(cwd, sessionId), "utf8");
  } catch {
    return [];
  }

  const events: TraceEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // Half-written last line, e.g. after a kill -9.
    }
  }
  return events;
}
