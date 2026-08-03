import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { NOOP_TRACER } from "../../src/trace.js";
import { PathEscapesRootError } from "../../src/security.js";
import { bashTool } from "../../src/tools/bash.js";
import { finishTool } from "../../src/tools/finish.js";
import { readFileTool } from "../../src/tools/read_file.js";
import { writeFileTool } from "../../src/tools/write_file.js";
import {
  normalizeToolReturn,
  truncateOutput,
  type Tool,
  type ToolContext,
} from "../../src/tools/types.js";

/** Tools now return either a bare string or a {result, display} pair
 * (spec §14.4 P0); these tests are about the model-facing half. */
async function resultOf(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  return normalizeToolReturn(await tool.execute(input, ctx)).result;
}

let root: string;
let context: ToolContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-tools-test-"));
  context = { root, config: DEFAULT_CONFIG, log: () => {}, tracer: NOOP_TRACER };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("read_file", () => {
  it("returns content with line numbers", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "first\nsecond\n");
    const output = await resultOf(readFileTool, { path: "a.txt" }, context);
    expect(output).toContain("1\tfirst");
    expect(output).toContain("2\tsecond");
  });

  it("honors offset and limit for paging through a large file", async () => {
    fs.writeFileSync(path.join(root, "big.txt"), Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n"));

    const output = await resultOf(readFileTool, { path: "big.txt", offset: 50, limit: 2 }, context);

    expect(output).toContain("50\tline50");
    expect(output).toContain("51\tline51");
    expect(output).not.toContain("line52\n");
    expect(output).toContain("of 100");
  });

  it("errors when the file does not exist", () => {
    expect(() => readFileTool.execute({ path: "missing.txt" }, context)).toThrow(/not found/i);
  });

  it("errors when the path is a directory", () => {
    fs.mkdirSync(path.join(root, "sub"));
    expect(() => readFileTool.execute({ path: "sub" }, context)).toThrow(/directory/i);
  });

  it("rejects a path outside the project root", () => {
    expect(() => readFileTool.execute({ path: "../escape.txt" }, context)).toThrow(
      PathEscapesRootError,
    );
  });
});

describe("write_file", () => {
  it("creates a file that does not exist yet, including parent directories", async () => {
    await writeFileTool.execute({ path: "nested/deep/a.txt", content: "hello" }, context);
    expect(fs.readFileSync(path.join(root, "nested/deep/a.txt"), "utf8")).toBe("hello");
  });

  it("overwrites an existing file wholesale", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "old content");
    const output = await resultOf(writeFileTool, { path: "a.txt", content: "new" }, context);

    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("new");
    expect(output).toMatch(/overwrote/);
  });
});

describe("bash", () => {
  it("reports stdout and a zero exit code", async () => {
    const output = await resultOf(bashTool, { command: "echo hi" }, context);
    expect(output).toContain("exit code: 0");
    expect(output).toContain("hi");
  });

  it("reports a non-zero exit code and stderr rather than throwing", async () => {
    const output = await resultOf(bashTool, { command: "echo oops >&2; exit 3" }, context);
    expect(output).toContain("exit code: 3");
    expect(output).toContain("oops");
  });

  it("runs in the project root", async () => {
    fs.writeFileSync(path.join(root, "marker.txt"), "");
    const output = await resultOf(bashTool, { command: "ls" }, context);
    expect(output).toContain("marker.txt");
  });

  it("errors on timeout instead of hanging", async () => {
    await expect(
      bashTool.execute({ command: "sleep 5", timeout_ms: 150 }, context),
    ).rejects.toThrow(/timed out/i);
  });

  it("does not block the event loop while a command runs", async () => {
    // The whole reason the executor is async: a blocking one prevents the
    // SIGINT handler from running, so Ctrl+C does nothing until the
    // command finishes (spec §5.1/§3.2).
    let ticked = false;
    setTimeout(() => { ticked = true; }, 20);

    await bashTool.execute({ command: "sleep 0.3" }, context);

    expect(ticked).toBe(true);
  });
});

describe("finish", () => {
  it.each(["done", "blocked"] as const)("passes status %s through", async (status) => {
    const output = await resultOf(finishTool, { summary: "s", status }, context);
    expect(output).toBe(`[${status}] s`);
  });

  it("rejects an unknown status", () => {
    expect(() => finishTool.execute({ summary: "s", status: "maybe" }, context)).toThrow(
      /done.*blocked/,
    );
  });
});

describe("truncateOutput", () => {
  it("leaves output within budget untouched", () => {
    expect(truncateOutput("short", 100)).toBe("short");
  });

  it("keeps the head and the tail, dropping the middle", () => {
    const text = `${"A".repeat(500)}${"B".repeat(500)}${"C".repeat(500)}`;
    const truncated = truncateOutput(text, 100);

    expect(truncated.startsWith("A".repeat(50))).toBe(true);
    expect(truncated.endsWith("C".repeat(50))).toBe(true);
    expect(truncated).toContain("truncated 1400 chars");
    expect(truncated.length).toBeLessThan(text.length);
  });
});

describe("bash: interruption (spec §3.2)", () => {
  it("kills the running command instead of waiting it out", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);

    const output = await resultOf(bashTool, { command: "sleep 10" },
      { ...context, signal: controller.signal },
    );

    // The whole point: without killing, this would take 10s.
    expect(Date.now() - started).toBeLessThan(4000);
    expect(output).toMatch(/interrupted by user/i);
  });

  it("keeps the output produced before the interrupt", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600);

    const output = await resultOf(bashTool, { command: "echo early-output; sleep 10" },
      { ...context, signal: controller.signal },
    );

    // "Claude keeps the work done so far" — an interrupt is not a discard.
    expect(output).toContain("early-output");
  });

  it("is unaffected by a signal that never fires", async () => {
    const controller = new AbortController();
    const output = await resultOf(bashTool, { command: "echo done" },
      { ...context, signal: controller.signal },
    );

    expect(output).toContain("exit code: 0");
    expect(output).toContain("done");
  });

  it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();

    const output = await resultOf(bashTool, { command: "sleep 10" },
      { ...context, signal: controller.signal },
    );

    expect(Date.now() - started).toBeLessThan(4000);
    expect(output).toMatch(/interrupted/i);
  });
});

describe("finish: status is optional (spec §5.5)", () => {
  it("defaults to done when the model sends only a summary", async () => {
    // Regression lock: requiring it printed a red `"status" is required`
    // underneath the green ✓ of a turn the loop had already accepted.
    expect(await resultOf(finishTool, { summary: "did it" }, context)).toBe("[done] did it");
  });

  it("still rejects a status that is neither done nor blocked", async () => {
    expect(() => finishTool.execute({ summary: "s", status: "maybe" }, context)).toThrow(
      /done.*blocked/,
    );
  });
});
