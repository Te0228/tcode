/**
 * Config-file loading plus the numeric runtime config, parsed once at
 * startup (spec §7/§8.2). `agent.ts` and `tools/` read from here rather
 * than each reaching into `process.env`. Provider key/model/base_url is
 * NOT here — that belongs to `llm/providers.ts`.
 */
import os from "node:os";
import path from "node:path";

/** User-level config directory — mirrors the per-project `.tcode/`
 * (spec §8.2). */
export function userConfigDir(home: string = os.homedir()): string {
  return path.join(home, ".tcode");
}

/**
 * Populates `process.env` from the config files, highest priority first
 * (spec §8.2): real environment variables, then `<project>/.env`, then
 * `~/.tcode/.env`. `loadEnvFile` never overwrites a key that is already
 * set, so load order alone establishes precedence. Missing files are
 * skipped silently.
 */
export function loadEnvFiles(root: string, home: string = os.homedir()): string[] {
  const loaded: string[] = [];
  for (const file of [path.join(root, ".env"), path.join(userConfigDir(home), ".env")]) {
    try {
      process.loadEnvFile(file);
      loaded.push(file);
    } catch {
      // Absent or unreadable — both are normal.
    }
  }
  return loaded;
}

export interface Config {
  /** Optional ceiling on tool-call rounds per turn; `0` means unlimited,
   * which is the default (spec §3). Meant for unattended runs — an
   * interactive user stops a turn with Esc. */
  maxToolIterations: number;
  /** Print a progress line every N tool rounds; `0` disables it (spec §3).
   * This is what replaced the old hard iteration cap: a long turn should be
   * visible, not severed. */
  progressEveryIterations: number;
  /** Default `bash` timeout in ms (spec §5.1). */
  commandTimeoutMs: number;
  /** Per-tool_result content cap; excess is head/tail truncated (spec §5.1). */
  maxOutputChars: number;
  /** Fraction of the context window at which compaction kicks in (spec §3.1). */
  compactThreshold: number;
  /** Messages always kept verbatim, never compacted (spec §3.1). */
  compactKeepRecent: number;
  /** Held back from the history budget for the model's reply (spec §3.1). */
  reservedOutputTokens: number;
  /** Combined cap for both memory layers (spec §9.3/§9.4). */
  memoryMaxTokens: number;
  /** Below this, the history budget is too small to be useful and startup
   * warns instead of silently degrading every request (spec §3.1). */
  minUsableHistoryTokens: number;
}

export const DEFAULT_CONFIG: Config = {
  maxToolIterations: 0,
  progressEveryIterations: 25,
  commandTimeoutMs: 60_000,
  maxOutputChars: 30_000,
  compactThreshold: 0.75,
  compactKeepRecent: 8,
  reservedOutputTokens: 8192,
  memoryMaxTokens: 4000,
  minUsableHistoryTokens: 2000,
};

/**
 * Invalid values (non-numeric, <= 0) fall back to the default rather than
 * failing startup — spec §8.2 deliberately treats a typo'd number as less
 * severe than a missing API key.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** Same fallback rule, but `0` is a meaningful value ("no limit" /
 * "disabled") rather than an invalid one. */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/** Same fallback rule as `positiveInt`, for a 0-1 ratio. */
function fraction(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    maxToolIterations: nonNegativeInt(env.MAX_TOOL_ITERATIONS, DEFAULT_CONFIG.maxToolIterations),
    progressEveryIterations: nonNegativeInt(
      env.PROGRESS_EVERY_ITERATIONS,
      DEFAULT_CONFIG.progressEveryIterations,
    ),
    commandTimeoutMs: positiveInt(env.COMMAND_TIMEOUT_MS, DEFAULT_CONFIG.commandTimeoutMs),
    maxOutputChars: positiveInt(env.MAX_OUTPUT_CHARS, DEFAULT_CONFIG.maxOutputChars),
    compactThreshold: fraction(env.COMPACT_THRESHOLD, DEFAULT_CONFIG.compactThreshold),
    compactKeepRecent: positiveInt(env.COMPACT_KEEP_RECENT, DEFAULT_CONFIG.compactKeepRecent),
    reservedOutputTokens: positiveInt(
      env.RESERVED_OUTPUT_TOKENS,
      DEFAULT_CONFIG.reservedOutputTokens,
    ),
    memoryMaxTokens: positiveInt(env.MEMORY_MAX_TOKENS, DEFAULT_CONFIG.memoryMaxTokens),
    minUsableHistoryTokens: positiveInt(
      env.MIN_USABLE_HISTORY_TOKENS,
      DEFAULT_CONFIG.minUsableHistoryTokens,
    ),
  };
}
