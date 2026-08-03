import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompleter, tokenAt } from "../../src/ui/completer.js";

let root: string;
let complete: (line: string) => [string[], string];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-completer-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.ts"), "");
  fs.writeFileSync(path.join(root, "src", "input.ts"), "");
  fs.writeFileSync(path.join(root, "readme.md"), "");
  fs.writeFileSync(path.join(root, ".hidden"), "");
  complete = createCompleter(root);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("path completion (spec §15.4)", () => {
  it("completes a partial name in a subdirectory", () => {
    const [candidates, token] = complete("look at src/in");
    expect(candidates).toEqual(["src/index.ts", "src/input.ts"]);
    expect(token).toBe("src/in");
  });

  it("marks directories with a slash so a second Tab descends", () => {
    expect(complete("sr")[0]).toEqual(["src/"]);
  });

  it("keeps the @ marker on the candidates", () => {
    // Accepting a completion has to leave a usable reference, not a bare
    // path that the model will never see.
    expect(complete("read @src/ind")[0]).toEqual(["@src/index.ts"]);
  });

  it("hides dotfiles until the dot is typed", () => {
    // Otherwise every completion in a repo root drowns in .git and .tcode.
    expect(complete("")[0]).toEqual([]);
    expect(complete("re")[0]).toEqual(["readme.md"]);
    expect(complete(".h")[0]).toEqual([".hidden"]);
  });

  it("refuses to browse outside the project", () => {
    // The completer is a discovery surface; one that lists ~/.ssh is worse
    // than a tool that refuses to read it (spec §6).
    expect(complete("../")[0]).toEqual([]);
    expect(complete("/etc/pass")[0]).toEqual([]);
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(complete("nope/x")[0]).toEqual([]);
  });

  it("completes only the last token of the line", () => {
    expect(tokenAt("please read src/in")).toBe("src/in");
    expect(tokenAt("")).toBe("");
  });
});
