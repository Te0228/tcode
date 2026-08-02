import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { editFileTool } from "../../src/tools/edit_file.js";
import { PathEscapesRootError } from "../../src/security.js";
import type { ToolContext } from "../../src/tools/types.js";

let root: string;
let context: ToolContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-edit-test-"));
  context = { root, config: DEFAULT_CONFIG, log: () => {} };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string) {
  fs.writeFileSync(path.join(root, relative), content);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

describe("edit_file", () => {
  it("replaces a unique match", () => {
    write("a.ts", "const a = 1;\nconst b = 2;\n");

    editFileTool.execute({ path: "a.ts", old_string: "const a = 1;", new_string: "const a = 42;" }, context);

    expect(read("a.ts")).toBe("const a = 42;\nconst b = 2;\n");
  });

  it("errors on zero matches and leaves the file untouched", () => {
    write("a.ts", "const a = 1;\n");

    expect(() =>
      editFileTool.execute({ path: "a.ts", old_string: "nope", new_string: "x" }, context),
    ).toThrow(/no match/i);
    expect(read("a.ts")).toBe("const a = 1;\n");
  });

  it("errors with the match count when multiple matches and replace_all is not true", () => {
    write("a.ts", "x\nx\nx\n");

    expect(() =>
      editFileTool.execute({ path: "a.ts", old_string: "x", new_string: "y" }, context),
    ).toThrow(/matched 3 times/);
    expect(read("a.ts")).toBe("x\nx\nx\n");
  });

  it("replaces every occurrence when replace_all is true", () => {
    write("a.ts", "x\nx\nx\n");

    editFileTool.execute(
      { path: "a.ts", old_string: "x", new_string: "y", replace_all: true },
      context,
    );

    expect(read("a.ts")).toBe("y\ny\ny\n");
  });

  it("creates a new file when old_string is empty and the file does not exist", () => {
    editFileTool.execute({ path: "new.ts", old_string: "", new_string: "hello" }, context);
    expect(read("new.ts")).toBe("hello");
  });

  it("refuses an empty old_string on an existing file and points at write_file", () => {
    write("a.ts", "original");

    expect(() =>
      editFileTool.execute({ path: "a.ts", old_string: "", new_string: "replaced" }, context),
    ).toThrow(/write_file/);
    expect(read("a.ts")).toBe("original");
  });

  it("errors when the target file does not exist", () => {
    expect(() =>
      editFileTool.execute({ path: "missing.ts", old_string: "a", new_string: "b" }, context),
    ).toThrow(/file not found/i);
  });

  it("rejects a path that escapes the project root", () => {
    expect(() =>
      editFileTool.execute({ path: "../outside.ts", old_string: "", new_string: "x" }, context),
    ).toThrow(PathEscapesRootError);
  });
});
