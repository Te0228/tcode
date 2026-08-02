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
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the command was killed for exceeding `timeoutMs`. */
  timedOut: boolean;
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
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

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
        // SIGKILL after a grace period: a shell ignoring SIGTERM must not
        // hold the turn open past its timeout.
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, options.timeoutMs);

      child.on("error", (error) => {
        // A spawn failure that isn't a timeout (e.g. missing shell) is a
        // real fault — surface it so the tool layer turns it into an
        // is_error tool_result rather than a bogus exit code.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          // A signal-killed process has a null code; don't let that read
          // as success. 124 matches the coreutils `timeout` convention.
          exitCode: code ?? (timedOut ? 124 : signal ? 1 : 0),
          timedOut,
        });
      });
    });
  },
};
