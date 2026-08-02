import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, findLatestSession, loadSession, saveSession } from "../../src/session.js";

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-session-test-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("session persistence", () => {
  it("creates a new session with an empty message history", () => {
    const session = createSession(cwd, "anthropic", "claude-sonnet-5");
    expect(session.messages).toEqual([]);
    expect(session.provider).toBe("anthropic");
    expect(session.model).toBe("claude-sonnet-5");
  });

  it("round-trips save/load with the normalized message format intact", () => {
    const session = createSession(cwd, "anthropic", "claude-sonnet-5");
    session.messages.push({ role: "user", content: [{ type: "text", text: "hi" }] });
    saveSession(session);

    const loaded = loadSession(cwd, session.id);
    expect(loaded.messages).toEqual(session.messages);
    expect(loaded.id).toBe(session.id);
  });

  it("--resume with an unknown id throws a clear error instead of crashing", () => {
    expect(() => loadSession(cwd, "does-not-exist")).toThrow(/no session found/);
  });

  it("--continue picks the most recently updated session", async () => {
    const a = createSession(cwd, "anthropic", "claude-sonnet-5");
    saveSession(a);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = createSession(cwd, "anthropic", "claude-sonnet-5");
    saveSession(b);

    expect(findLatestSession(cwd)?.id).toBe(b.id);
  });

  it("returns undefined when no sessions exist yet (fresh project)", () => {
    expect(findLatestSession(cwd)).toBeUndefined();
  });
});
