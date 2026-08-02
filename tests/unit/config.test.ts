import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, loadEnvFiles, userConfigDir } from "../../src/config.js";

describe("loadConfig", () => {
  it("uses documented defaults when nothing is set", () => {
    expect(loadConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("reads each value from its env var", () => {
    expect(
      loadConfig({
        MAX_TOOL_ITERATIONS: "10",
        PROGRESS_EVERY_ITERATIONS: "5",
        COMMAND_TIMEOUT_MS: "5000",
        MAX_OUTPUT_CHARS: "100",
        COMPACT_THRESHOLD: "0.5",
        COMPACT_KEEP_RECENT: "4",
        RESERVED_OUTPUT_TOKENS: "2048",
        MEMORY_MAX_TOKENS: "500",
        MIN_USABLE_HISTORY_TOKENS: "2000",
      }),
    ).toEqual({
      maxToolIterations: 10,
      progressEveryIterations: 5,
      commandTimeoutMs: 5000,
      maxOutputChars: 100,
      compactThreshold: 0.5,
      compactKeepRecent: 4,
      reservedOutputTokens: 2048,
      memoryMaxTokens: 500,
      minUsableHistoryTokens: 2000,
    });
  });

  it.each(["-1", "abc", ""])(
    "falls back to the default for invalid value %j instead of failing startup",
    (raw) => {
      expect(loadConfig({ MAX_TOOL_ITERATIONS: raw }).maxToolIterations).toBe(
        DEFAULT_CONFIG.maxToolIterations,
      );
    },
  );

  it("defaults to no ceiling at all (spec §3)", () => {
    // 0 means unlimited, and it is the default: the old hard cap severed
    // legitimate long tasks. Esc is the brake for interactive use; this
    // knob exists for unattended runs.
    expect(DEFAULT_CONFIG.maxToolIterations).toBe(0);
    expect(loadConfig({}).maxToolIterations).toBe(0);
  });

  it("treats an explicit 0 as 'no ceiling', not as an invalid value", () => {
    expect(loadConfig({ MAX_TOOL_ITERATIONS: "0" }).maxToolIterations).toBe(0);
    expect(loadConfig({ PROGRESS_EVERY_ITERATIONS: "0" }).progressEveryIterations).toBe(0);
  });
});

describe("COMPACT_THRESHOLD", () => {
  it.each(["0", "-0.5", "1.5", "abc"])(
    "falls back to the default for out-of-range value %j",
    (raw) => {
      expect(loadConfig({ COMPACT_THRESHOLD: raw }).compactThreshold).toBe(
        DEFAULT_CONFIG.compactThreshold,
      );
    },
  );

  it("accepts a valid fraction", () => {
    expect(loadConfig({ COMPACT_THRESHOLD: "0.9" }).compactThreshold).toBe(0.9);
  });
});

describe("loadEnvFiles", () => {
  let root: string;
  let home: string;
  let saved: NodeJS.ProcessEnv;

  const KEYS = ["TCODE_TEST_A", "TCODE_TEST_B", "TCODE_TEST_C"];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-env-root-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-env-home-"));
    fs.mkdirSync(path.join(home, ".tcode"));
    saved = { ...process.env };
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  const writeProjectEnv = (body: string) => fs.writeFileSync(path.join(root, ".env"), body);
  const writeUserEnv = (body: string) =>
    fs.writeFileSync(path.join(home, ".tcode", ".env"), body);

  it("reads the user-level ~/.tcode/.env so a global install works anywhere", () => {
    writeUserEnv("TCODE_TEST_A=from_user\n");
    loadEnvFiles(root, home);
    expect(process.env.TCODE_TEST_A).toBe("from_user");
  });

  it("lets a project .env override the user-level config", () => {
    writeUserEnv("TCODE_TEST_B=from_user\n");
    writeProjectEnv("TCODE_TEST_B=from_project\n");
    loadEnvFiles(root, home);
    expect(process.env.TCODE_TEST_B).toBe("from_project");
  });

  it("lets a real environment variable override both files", () => {
    process.env.TCODE_TEST_C = "from_shell";
    writeUserEnv("TCODE_TEST_C=from_user\n");
    writeProjectEnv("TCODE_TEST_C=from_project\n");
    loadEnvFiles(root, home);
    expect(process.env.TCODE_TEST_C).toBe("from_shell");
  });

  it("merges keys across both files instead of letting one shadow the other", () => {
    writeUserEnv("TCODE_TEST_A=from_user\n");
    writeProjectEnv("TCODE_TEST_B=from_project\n");
    loadEnvFiles(root, home);
    expect(process.env.TCODE_TEST_A).toBe("from_user");
    expect(process.env.TCODE_TEST_B).toBe("from_project");
  });

  it("skips missing files silently and reports which were loaded", () => {
    expect(() => loadEnvFiles(root, home)).not.toThrow();
    expect(loadEnvFiles(root, home)).toEqual([]);

    writeUserEnv("TCODE_TEST_A=x\n");
    expect(loadEnvFiles(root, home)).toEqual([path.join(home, ".tcode", ".env")]);
  });
});

describe("userConfigDir", () => {
  it("mirrors the per-project .tcode/ naming", () => {
    expect(userConfigDir("/home/me")).toBe(path.join("/home/me", ".tcode"));
  });
});
