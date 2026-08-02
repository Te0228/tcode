import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  findLatestSession,
  listSessions,
  loadSession,
  saveSession,
  type Session,
} from "../../src/session.js";

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

describe("listSessions (spec §4)", () => {
  it("orders newest first, which is what --continue picks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-list-"));
    const write = (id: string, updatedAt: string, messages: Session["messages"]) => {
      const target = path.join(dir, ".tcode", "sessions");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(
        path.join(target, `${id}.json`),
        JSON.stringify({
          id,
          cwd: dir,
          provider: "deepseek",
          model: "deepseek-chat",
          createdAt: updatedAt,
          updatedAt,
          messages,
        }),
      );
    };

    write("old", "2026-08-01T10:00:00.000Z", [
      { role: "user", content: [{ type: "text", text: "first task" }] },
    ]);
    write("new", "2026-08-02T10:00:00.000Z", [
      { role: "user", content: [{ type: "text", text: "later task" }] },
    ]);

    const listed = listSessions(dir);
    expect(listed.map((entry) => entry.session.id)).toEqual(["new", "old"]);
    expect(listed[0].firstInput).toBe("later task");
    // The head of the list and --continue must never disagree.
    expect(findLatestSession(dir)!.id).toBe(listed[0].session.id);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts conversation, not tool plumbing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-list-"));
    const target = path.join(dir, ".tcode", "sessions");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, "s.json"),
      JSON.stringify({
        id: "s",
        cwd: dir,
        provider: "deepseek",
        model: "deepseek-chat",
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "t1", content: "ok", isError: false }],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      }),
    );

    // 4 raw messages, but the tool_result carrier is plumbing.
    expect(listSessions(dir)[0].exchanges).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips a corrupt file instead of taking the whole list down with it", () => {
    // --continue is built on this, so one half-written file must not make
    // every session in the directory unreachable.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-list-"));
    const target = path.join(dir, ".tcode", "sessions");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "broken.json"), "{ not json");
    fs.writeFileSync(
      path.join(target, "good.json"),
      JSON.stringify({
        id: "good",
        cwd: dir,
        provider: "deepseek",
        model: "deepseek-chat",
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
        messages: [],
      }),
    );

    expect(listSessions(dir).map((entry) => entry.session.id)).toEqual(["good"]);
    expect(findLatestSession(dir)!.id).toBe("good");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing for a directory that has never been used", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-list-"));
    expect(listSessions(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
