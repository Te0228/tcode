import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { appendMemory, loadMemory, projectMemoryPath, userMemoryPath } from "../../src/memory.js";
import { buildSystemPrompt } from "../../src/prompt.js";

let root: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-memory-root-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-memory-home-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const writeProject = (name: string, body: string) => fs.writeFileSync(path.join(root, name), body);
const writeUser = (body: string) => {
  fs.mkdirSync(path.join(home, ".tcode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".tcode", "AGENTS.md"), body);
};

const load = () => loadMemory(root, DEFAULT_CONFIG.memoryMaxTokens, home);

describe("loadMemory: project layer", () => {
  it("reads AGENTS.md when present", () => {
    writeProject("AGENTS.md", "always run npm test");
    const { layers } = load();
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ scope: "project", content: "always run npm test" });
  });

  it("falls back to TCODE.md", () => {
    writeProject("TCODE.md", "tcode conventions");
    expect(load().layers[0].file).toBe(path.join(root, "TCODE.md"));
  });

  it("prefers AGENTS.md when both exist", () => {
    writeProject("AGENTS.md", "agents wins");
    writeProject("TCODE.md", "tcode loses");
    const { layers } = load();
    expect(layers).toHaveLength(1);
    expect(layers[0].content).toBe("agents wins");
  });

  it("ignores an empty file", () => {
    writeProject("AGENTS.md", "   \n\n");
    expect(load().layers).toEqual([]);
  });
});

describe("loadMemory: layering", () => {
  it("loads both layers, user first so the project layer carries more weight", () => {
    writeUser("answer in Chinese");
    writeProject("AGENTS.md", "this repo uses pnpm");

    const { layers } = load();

    expect(layers.map((l) => l.scope)).toEqual(["user", "project"]);
    expect(layers[0].content).toBe("answer in Chinese");
    expect(layers[1].content).toBe("this repo uses pnpm");
  });

  it("works with only the user layer present", () => {
    writeUser("answer in Chinese");
    expect(load().layers.map((l) => l.scope)).toEqual(["user"]);
  });

  it("returns no layers when neither exists, without throwing", () => {
    expect(load()).toMatchObject({ layers: [], truncated: false });
  });

  it("truncates the user layer first when over the cap", () => {
    writeUser(Array.from({ length: 400 }, (_, i) => `- user rule ${i}`).join("\n"));
    writeProject("AGENTS.md", "- keep this project rule");

    const { layers, truncated } = loadMemory(root, 200, home);

    expect(truncated).toBe(true);
    expect(layers.find((l) => l.scope === "user")!.content).toContain("older entries dropped");
    // The more specific layer survives intact.
    expect(layers.find((l) => l.scope === "project")!.content).toBe("- keep this project rule");
  });
});

describe("loadMemory: entry-level truncation (spec §9.4)", () => {
  // ~32 tokens total; a cap of 30 forces truncation, 4000 does not.
  const THREE =
    "# Project memory\n\n" +
    "- OLDEST entry about deployment steps\n" +
    "- MIDDLE entry about database rules\n" +
    "- NEWEST entry about commit messages\n";

  it("never cuts an entry mid-sentence", () => {
    writeProject("AGENTS.md", "# Project memory\n\n- deploy only after running npm run build\n");

    const { layers } = loadMemory(root, 12, home);
    const content = layers[0]?.content ?? "";

    // A half-sentence like "- deploy only after runn" is worse than nothing.
    const entryLines = content.split("\n").filter((l) => l.startsWith("- "));
    for (const line of entryLines) {
      expect(line).toBe("- deploy only after running npm run build");
    }
  });

  it("keeps the newest entries and drops the oldest", () => {
    writeProject("AGENTS.md", THREE);

    const { layers, dropped } = loadMemory(root, 30, home);

    expect(layers[0].content).toContain("NEWEST entry");
    expect(layers[0].content).not.toContain("OLDEST entry");
    expect(dropped.map((d) => d.preview)).toContain("OLDEST entry about deployment steps");
  });

  it("reports what it dropped so the user knows what to prune", () => {
    writeProject("AGENTS.md", THREE);

    const { dropped } = loadMemory(root, 30, home);

    expect(dropped.length).toBeGreaterThan(0);
    for (const entry of dropped) {
      expect(entry.scope).toBe("project");
      expect(entry.preview).not.toMatch(/^-/); // bullet stripped for display
      expect(entry.preview.length).toBeGreaterThan(0);
    }
  });

  it("keeps the preamble out of entry truncation", () => {
    writeProject("AGENTS.md", THREE);
    expect(loadMemory(root, 30, home).layers[0].content).toContain("# Project memory");
  });

  it("keeps the newest entry even when the marker alone would squeeze it out", () => {
    writeProject("AGENTS.md", THREE);

    // Budget where marker + preamble leaves no room; the floor applies.
    const { layers } = loadMemory(root, 15, home);

    expect(layers[0].content).toContain("NEWEST entry");
  });

  it("leaves a file that fits completely untouched", () => {
    writeProject("AGENTS.md", THREE);

    const { layers, dropped, truncated } = loadMemory(root, 4000, home);

    expect(truncated).toBe(false);
    expect(dropped).toEqual([]);
    expect(layers[0].content).toBe(THREE.trim());
  });

  it("handles a multi-line entry as one unit", () => {
    writeProject(
      "AGENTS.md",
      "# Project memory\n\n- first entry\n  continued on the next line\n- second entry\n",
    );

    const { layers } = loadMemory(root, 4000, home);
    expect(layers[0].content).toContain("continued on the next line");
  });
});

describe("appendMemory", () => {
  it("creates the project file with a header on first write", () => {
    const file = appendMemory("project", "use vitest", root, home);
    expect(file).toBe(path.join(root, "AGENTS.md"));
    const body = fs.readFileSync(file, "utf8");
    expect(body).toContain("# Project memory");
    expect(body).toContain("- use vitest");
  });

  it("appends without destroying existing content", () => {
    writeProject("AGENTS.md", "# Project memory\n\n- existing rule\n");
    appendMemory("project", "new rule", root, home);

    const body = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(body).toContain("- existing rule");
    expect(body).toContain("- new rule");
    // Header is not duplicated on a file that already has content.
    expect(body.match(/# Project memory/g)).toHaveLength(1);
  });

  it("creates ~/.tcode/ as needed for a user-scope write", () => {
    const file = appendMemory("user", "answer in Chinese", root, home);
    expect(file).toBe(userMemoryPath(home));
    expect(fs.readFileSync(file, "utf8")).toContain("- answer in Chinese");
  });

  it("appends to the existing project file that loadMemory would read", () => {
    writeProject("TCODE.md", "# Project memory\n\n- old\n");
    const file = appendMemory("project", "added", root, home);
    expect(file).toBe(projectMemoryPath(root));
    expect(file).toBe(path.join(root, "TCODE.md"));
  });
});

describe("buildSystemPrompt", () => {
  it("states the project root as the working directory", () => {
    expect(buildSystemPrompt({ root: "/proj" })).toContain("/proj");
  });

  it("embeds both memory layers and says the project layer wins", () => {
    writeUser("answer in Chinese");
    writeProject("AGENTS.md", "use pnpm");

    const prompt = buildSystemPrompt({ root: "/proj", memory: load() });

    expect(prompt).toContain("answer in Chinese");
    expect(prompt).toContain("use pnpm");
    expect(prompt).toMatch(/project layer wins/i);
    // User layer comes first so the project layer is the last word.
    expect(prompt.indexOf("answer in Chinese")).toBeLessThan(prompt.indexOf("use pnpm"));
  });

  it("mentions the remember tool when memory is loaded", () => {
    writeProject("AGENTS.md", "use pnpm");
    expect(buildSystemPrompt({ root: "/proj", memory: load() })).toContain("remember tool");
  });

  it("tells the model bash needs confirmation by default", () => {
    expect(buildSystemPrompt({ root: "/proj" })).toMatch(/confirmation/i);
  });

  it("tells the model confirmation is off under --full-auto", () => {
    expect(buildSystemPrompt({ root: "/proj", fullAuto: true })).toContain("--full-auto");
  });

  it("explains that finish ends the turn, not the program", () => {
    expect(buildSystemPrompt({ root: "/proj" })).toMatch(/does not exit the/i);
  });
});
