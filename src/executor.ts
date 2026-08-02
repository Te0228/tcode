/**
 * Command execution boundary (spec §5.1/§7). A thin `spawn` wrapper;
 * swapping in a sandboxed executor (seatbelt/landlock/container) later
 * means replacing this file only — tools never touch child_process
 * directly.
 *
 * Asynchronous by requirement, not by taste: `spawnSync` blocks the event
 * loop, so signal handlers cannot run while a command is in flight. With
 * it, Ctrl+C produced no visible response until the command finished on
 * its own — making the interrupt in spec §3.2 useless in practice.
 */
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Interrupt (spec §3.2): terminates the child instead of waiting it
   * out. Output captured so far is still returned. */
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the command was killed for exceeding `timeoutMs`. */
  timedOut: boolean;
  /** True when the user interrupted it (spec §3.2). */
  interrupted: boolean;
}

export interface Executor {
  run(command: string, options: RunOptions): Promise<RunResult>;
}

/** Guard against a runaway command exhausting memory. */
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

export const executor: Executor = {
  run(command, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group, so termination can reach grandchildren.
        // `sh -c "echo x; sleep 10"` forks `sleep`; signalling only the
        // shell leaves `sleep` orphaned, still holding the pipes open, so
        // `close` never fires and the turn hangs anyway.
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let interrupted = false;
      let settled = false;

      // SIGTERM first so the command can clean up; SIGKILL if it ignores
      // us, so nothing can hold the turn open indefinitely. Signals go to
      // the whole group (negative pid) to catch grandchildren.
      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // Group already gone, or never created — fall back to the child.
          try {
            child.kill(signal);
          } catch {
            // Already reaped.
          }
        }
      };

      const terminate = () => {
        signalGroup("SIGTERM");
        setTimeout(() => signalGroup("SIGKILL"), 2000).unref();
      };

      const capture = (chunk: Buffer, into: "out" | "err") => {
        const text = chunk.toString("utf8");
        if (into === "out") {
          if (stdout.length < MAX_CAPTURE_BYTES) stdout += text;
        } else if (stderr.length < MAX_CAPTURE_BYTES) {
          stderr += text;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => capture(chunk, "out"));
      child.stderr?.on("data", (chunk: Buffer) => capture(chunk, "err"));

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);

      const onAbort = () => {
        interrupted = true;
        terminate();
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }
      const detach = () => options.signal?.removeEventListener("abort", onAbort);

      child.on("error", (error) => {
        // A spawn failure that isn't a timeout (e.g. missing shell) is a
        // real fault — surface it so the tool layer turns it into an
        // is_error tool_result rather than a bogus exit code.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detach();
        reject(error);
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detach();
        resolve({
          stdout,
          stderr,
          // A signal-killed process has a null code; don't let that read
          // as success. 124 matches the coreutils `timeout` convention.
          exitCode: code ?? (timedOut ? 124 : signal ? 1 : 0),
          timedOut,
          interrupted,
        });
      });
    });
  },
};
