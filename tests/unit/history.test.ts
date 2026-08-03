import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHistory, saveHistory } from "../../src/history.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-history-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("input history (spec §15.5)", () => {
  it("survives a round trip newest-first, the order readline wants", () => {
    saveHistory(root, ["newest", "middle", "oldest"]);
    expect(loadHistory(root)).toEqual(["newest", "middle", "oldest"]);
  });

  it("keeps a multi-line message as one entry", () => {
    // One entry per line in the file, so a message containing newlines must
    // not come back as several separate history entries.
    saveHistory(root, ["line one\nline two", "plain"]);
    expect(loadHistory(root)).toEqual(["line one\nline two", "plain"]);
  });

  it("round-trips a literal backslash", () => {
    saveHistory(root, ["C:\\path\\n not a newline"]);
    expect(loadHistory(root)).toEqual(["C:\\path\\n not a newline"]);
  });

  it("caps the file so it cannot grow without bound", () => {
    saveHistory(root, Array.from({ length: 50 }, (_, i) => `entry ${i}`), 10);
    const loaded = loadHistory(root, 10);
    expect(loaded).toHaveLength(10);
    expect(loaded[0]).toBe("entry 0"); // newest kept, oldest dropped
  });

  it("drops blank entries instead of storing empty lines", () => {
    saveHistory(root, ["real", "   ", ""]);
    expect(loadHistory(root)).toEqual(["real"]);
  });

  it("treats a missing file as empty, never as an error", () => {
    // History is a convenience; it must never stand between the user and a
    // working REPL.
    expect(loadHistory(root)).toEqual([]);
  });

  it("stays quiet when the directory cannot be written", () => {
    const readOnly = path.join(root, "nope");
    fs.mkdirSync(readOnly);
    fs.chmodSync(readOnly, 0o500);
    expect(() => saveHistory(readOnly, ["x"])).not.toThrow();
    fs.chmodSync(readOnly, 0o700);
  });
});
