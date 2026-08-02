import { describe, expect, it } from "vitest";
import { ROLE_TOOLS, toolsForRole } from "../../src/tools/spawn_agent.js";
import { BASE_TOOLS } from "../../src/tools/index.js";

describe("role -> tool subset", () => {
  it("gives `general` every tool except spawn_agent itself", () => {
    const names = Object.keys(toolsForRole("general")).sort();
    const expected = Object.keys(BASE_TOOLS).sort();
    expect(names).toEqual(expected);
    expect(names).not.toContain("spawn_agent");
  });

  it("withholds edit_file and write_file from `explore`", () => {
    const names = Object.keys(toolsForRole("explore"));
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("write_file");
    // Read-only investigation still needs to look around.
    expect(names).toContain("read_file");
    expect(names).toContain("bash");
    expect(names).toContain("finish");
  });

  it.each(["general", "explore"] as const)(
    "never includes spawn_agent in the %s subset (recursion guard)",
    (role) => {
      expect(ROLE_TOOLS[role]).not.toContain("spawn_agent");
      expect(Object.keys(toolsForRole(role))).not.toContain("spawn_agent");
    },
  );

  it("returns real tool objects from the registry, not stubs", () => {
    const tools = toolsForRole("explore");
    expect(tools.read_file).toBe(BASE_TOOLS.read_file);
  });
});
