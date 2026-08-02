import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { rememberTool } from "../../src/tools/remember.js";
import { ROLE_TOOLS } from "../../src/tools/spawn_agent.js";
import type { ToolContext } from "../../src/tools/types.js";

let root: string;
let logged: string[];
let context: ToolContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-remember-test-"));
  logged = [];
  context = { root, config: DEFAULT_CONFIG, log: (line) => logged.push(line) };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("remember", () => {
  it("appends to the project memory file", () => {
    rememberTool.execute({ scope: "project", content: "run npm test before finishing" }, context);

    const body = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(body).toContain("- run npm test before finishing");
  });

  it("always logs what it recorded, since memory outlives the session", () => {
    rememberTool.execute({ scope: "project", content: "use pnpm" }, context);
    expect(logged.join("\n")).toContain("use pnpm");
  });

  it("rejects an unknown scope", () => {
    expect(() => rememberTool.execute({ scope: "global", content: "x" }, context)).toThrow(
      /user.*project/,
    );
  });

  it("rejects empty content", () => {
    expect(() => rememberTool.execute({ scope: "project", content: "   " }, context)).toThrow(
      /empty/,
    );
  });

  it("exposes no path parameter — the write target must not be model-controlled", () => {
    const properties = rememberTool.schema.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["content", "scope"]);
    expect(properties.path).toBeUndefined();
  });

  it("ignores any path the model tries to smuggle in", () => {
    rememberTool.execute(
      { scope: "project", content: "note", path: "../../escape.md" } as Record<string, unknown>,
      context,
    );

    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "..", "..", "escape.md"))).toBe(false);
  });
});

describe("remember in subagent roles", () => {
  it("is available to `general`", () => {
    expect(ROLE_TOOLS.general).toContain("remember");
  });

  it("is withheld from read-only `explore`", () => {
    expect(ROLE_TOOLS.explore).not.toContain("remember");
  });
});
