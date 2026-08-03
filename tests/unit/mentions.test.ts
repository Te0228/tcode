import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandMentions } from "../../src/mentions.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-mentions-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "line 1\nline 2\nline 3");
  fs.writeFileSync(path.join(root, "b.ts"), "b contents");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("@path references (spec §15.4)", () => {
  it("appends the file for the model and reports it for the terminal", () => {
    const out = expandMentions("look at @src/a.ts please", root, 10_000);
    expect(out.text).toContain("look at @src/a.ts please");
    expect(out.text).toContain('<file path="src/a.ts">');
    expect(out.text).toContain("line 2");
    expect(out.attachments).toEqual([{ path: "src/a.ts", lines: 3, truncated: false }]);
  });

  it("attaches several files but each only once", () => {
    const out = expandMentions("@src/a.ts and @b.ts and @src/a.ts again", root, 10_000);
    expect(out.attachments.map((a) => a.path)).toEqual(["src/a.ts", "b.ts"]);
  });

  it("leaves a message with no mentions untouched", () => {
    const out = expandMentions("email me at a@b.com", root, 10_000);
    expect(out.text).toBe("email me at a@b.com");
    expect(out.attachments).toEqual([]);
    expect(out.failures).toEqual([]);
  });

  it("treats trailing punctuation as punctuation, not filename", () => {
    const out = expandMentions("check @b.ts, then stop", root, 10_000);
    expect(out.attachments.map((a) => a.path)).toEqual(["b.ts"]);
  });

  it("refuses to reach outside the project", () => {
    // Same boundary as the file tools (spec §6): a reference is a read.
    const out = expandMentions("see @../../etc/passwd", root, 10_000);
    expect(out.attachments).toEqual([]);
    expect(out.failures[0].reason).toMatch(/outside/);
  });

  it("reports a missing file instead of silently sending nothing", () => {
    const out = expandMentions("see @nope.ts", root, 10_000);
    expect(out.failures).toEqual([{ path: "nope.ts", reason: "not found" }]);
    expect(out.text).not.toContain("<file");
  });

  it("reports a directory rather than trying to read it", () => {
    expect(expandMentions("@src", root, 10_000).failures[0].reason).toMatch(/directory/);
  });

  it("truncates a large file and says so", () => {
    fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(5_000));
    const out = expandMentions("@big.txt", root, 100);
    expect(out.attachments[0].truncated).toBe(true);
    expect(out.text).toContain("truncated");
  });
});
