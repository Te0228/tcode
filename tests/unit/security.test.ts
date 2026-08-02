import path from "node:path";
import { describe, expect, it } from "vitest";
import { PathEscapesRootError, resolveInRoot } from "../../src/security.js";

const ROOT = "/tmp/tcode-test-root";

describe("resolveInRoot", () => {
  it("resolves a relative path inside root", () => {
    expect(resolveInRoot(ROOT, "foo/bar.txt")).toBe(path.join(ROOT, "foo/bar.txt"));
  });

  it("allows the root itself", () => {
    expect(resolveInRoot(ROOT, ".")).toBe(ROOT);
  });

  it("rejects a relative ../ escape", () => {
    expect(() => resolveInRoot(ROOT, "../outside.txt")).toThrow(PathEscapesRootError);
  });

  it("rejects a deeply nested ../ escape", () => {
    expect(() => resolveInRoot(ROOT, "a/b/../../../outside.txt")).toThrow(PathEscapesRootError);
  });

  it("rejects an absolute path outside root", () => {
    expect(() => resolveInRoot(ROOT, "/etc/passwd")).toThrow(PathEscapesRootError);
  });

  it("allows an absolute path that is inside root", () => {
    const inside = path.join(ROOT, "x.txt");
    expect(resolveInRoot(ROOT, inside)).toBe(inside);
  });

  it("rejects a sibling directory sharing the same string prefix", () => {
    // /tmp/tcode-test-root-evil starts with the ROOT string but is not inside it.
    expect(() => resolveInRoot(ROOT, "../tcode-test-root-evil/file.txt")).toThrow(
      PathEscapesRootError,
    );
  });
});
