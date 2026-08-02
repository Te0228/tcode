/**
 * Command execution boundary (spec §5.1/§7). v1 is a thin `spawnSync`
 * wrapper; swapping in a sandboxed executor (seatbelt/landlock/container)
 * later means replacing this file only — tools never touch child_process
 * directly.
 */
import { spawnSync } from "node:child_process";

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
  run(command: string, options: RunOptions): RunResult;
}

export const executor: Executor = {
  run(command, options) {
    const result = spawnSync(command, {
      shell: true,
      cwd: options.cwd,
      timeout: options.timeoutMs,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });

    // spawnSync reports a timeout kill as an ETIMEDOUT error plus a
    // SIGTERM signal; either one on its own is enough to call it a timeout.
    const timedOut =
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
      result.signal === "SIGTERM";

    // A spawn failure that isn't a timeout (e.g. shell missing) is a real
    // fault — let it throw so the tool layer turns it into an is_error
    // tool_result rather than reporting a bogus exit code.
    if (result.error && !timedOut) {
      throw result.error;
    }

    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      // Signal-killed processes have a null status; don't let that read as
      // success. 124 matches coreutils `timeout` convention.
      exitCode: result.status ?? (timedOut ? 124 : 1),
      timedOut,
    };
  },
};
