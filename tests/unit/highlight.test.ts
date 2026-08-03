import { describe, expect, it } from "vitest";
import { detectLanguage, highlight } from "../../src/ui/highlight.js";
import { BASIC_PALETTE, NO_COLOR_PALETTE } from "../../src/ui/theme.js";
import { displayWidth } from "../../src/ui/width.js";

describe("detectLanguage (spec §16.8)", () => {
  it("maps the families it knows", () => {
    expect(detectLanguage("src/a.ts")).toBe("c-like");
    expect(detectLanguage("main.go")).toBe("c-like");
    expect(detectLanguage("script.py")).toBe("hash");
    expect(detectLanguage("deploy.sh")).toBe("hash");
    expect(detectLanguage("query.sql")).toBe("sql");
  });

  it("accepts a fence tag as well as a filename", () => {
    expect(detectLanguage("typescript")).toBe("c-like");
    expect(detectLanguage("bash")).toBe("hash");
  });

  it("returns none rather than guessing", () => {
    // Rendering Python's `#` comment as C code tells the reader something
    // false; plain text tells them nothing, which is better.
    expect(detectLanguage("notes.txt")).toBe("none");
    expect(detectLanguage("")).toBe("none");
    expect(detectLanguage("weird.qqq")).toBe("none");
  });
});

describe("highlight (spec §16.8)", () => {
  const plain = NO_COLOR_PALETTE;

  it("leaves the text untouched when there is no language", () => {
    expect(highlight("const a = 1;", "none", BASIC_PALETTE)).toBe("const a = 1;");
  });

  it("never changes the display width", () => {
    // The frame erase counts rows from measured widths (spec §14.3); a
    // highlighter that added or dropped a character would corrupt it.
    for (const source of [
      `const greeting = "hello"; // note`,
      `def f(x): return x + 1  # note`,
      `SELECT * FROM t WHERE a = 'b'`,
      `const 中文 = "值";`,
    ]) {
      for (const language of ["c-like", "hash", "sql"] as const) {
        expect(displayWidth(highlight(source, language, BASIC_PALETTE))).toBe(
          displayWidth(source),
        );
      }
    }
  });

  it("recognises comments to the end of the line", () => {
    const styled = highlight(`let a = 1; // const string`, "c-like", BASIC_PALETTE);
    // Everything after `//` is one comment run; the keyword inside it must
    // not be picked out again.
    const commentStart = styled.indexOf("//");
    expect(styled.slice(commentStart)).not.toContain(BASIC_PALETTE.accent("const"));
  });

  it("uses the right comment marker per family", () => {
    expect(highlight("# not code", "hash", plain)).toBe("# not code");
    // `#` is not a comment in a C-like file, so the line is scanned normally.
    expect(highlight("#include <a.h>", "c-like", plain)).toBe("#include <a.h>");
  });

  it("keeps a string whole, including escapes and other quotes", () => {
    const source = `a = "he said \\"hi\\" and 'bye'";`;
    expect(displayWidth(highlight(source, "c-like", BASIC_PALETTE))).toBe(displayWidth(source));
  });

  it("does not run off the end of an unterminated string", () => {
    expect(highlight(`a = "unterminated`, "c-like", plain)).toBe(`a = "unterminated`);
  });

  it("colours keywords, strings and numbers differently", () => {
    const styled = highlight(`const x = 42; const s = "y";`, "c-like", BASIC_PALETTE);
    expect(styled).toContain(BASIC_PALETTE.accent("const"));
    expect(styled).toContain(BASIC_PALETTE.code("42"));
    expect(styled).toContain(BASIC_PALETTE.success('"y"'));
  });

  it("does not treat a keyword inside an identifier as a keyword", () => {
    const styled = highlight("constant = 1", "c-like", BASIC_PALETTE);
    expect(styled.startsWith("constant")).toBe(true);
  });
});
