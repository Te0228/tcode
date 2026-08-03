import { describe, expect, it } from "vitest";
import { COMMANDS, isKnownCommand, parseCommand, renderHelp, unknownCommand } from "../../src/commands.js";
import { NO_COLOR_PALETTE } from "../../src/ui/theme.js";

describe("parseCommand (spec §15.3)", () => {
  it("splits the name from its arguments", () => {
    expect(parseCommand("/resume abc-123")).toEqual({ name: "resume", args: "abc-123" });
    expect(parseCommand("/help")).toEqual({ name: "help", args: "" });
    expect(parseCommand("  /help  ")).toEqual({ name: "help", args: "" });
    expect(parseCommand("/HELP")).toEqual({ name: "help", args: "" });
  });

  it("leaves ordinary messages alone", () => {
    expect(parseCommand("what does /usr/bin do?")).toBeNull();
    expect(parseCommand("fix the bug")).toBeNull();
  });

  it("does not claim a bare slash or a path", () => {
    // `/` followed by nothing or whitespace is someone typing a path or a
    // division sign; it has to reach the model as written.
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("/ 2")).toBeNull();
    expect(parseCommand("/usr/local/bin")).toBeNull();
  });

  it("keeps multi-line arguments intact", () => {
    expect(parseCommand("/resume a\nb")).toEqual({ name: "resume", args: "a\nb" });
  });
});

describe("help (spec §15.3)", () => {
  it("lists every command that exists, minus the pure aliases", () => {
    const help = renderHelp(NO_COLOR_PALETTE).join("\n");
    for (const command of COMMANDS) {
      if (command.name === "quit") continue; // alias for /exit; listing both is noise
      expect(help, command.name).toContain(`/${command.name}`);
    }
  });

  it("covers what the tool can actually do (spec §17.5c)", () => {
    // The command set is derived from tcode's capabilities, not copied from
    // another tool: anything reachable only by restarting the process needs
    // a command.
    const names = COMMANDS.map((command) => command.name);
    for (const expected of [
      "model", "context", "compact", "diff", "undo", "retry",
      "memory", "init", "tools", "approvals", "view", "export",
      "sessions", "resume", "new", "clear", "status",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("documents the keys, which are otherwise undiscoverable", () => {
    const help = renderHelp(NO_COLOR_PALETTE).join("\n");
    for (const key of ["Esc", "Ctrl+C", "Tab", "@path"]) expect(help).toContain(key);
  });
});

describe("unknown commands", () => {
  it("names what was wrong and what exists", () => {
    // A typo must never reach the model: a thoughtful answer to /sessoins
    // is the most confusing possible response, because it looks like it ran.
    const message = unknownCommand("sessoins", NO_COLOR_PALETTE).join("\n");
    expect(message).toContain("/sessoins");
    expect(message).toContain("/sessions");
  });

  it("knows which names are real", () => {
    expect(isKnownCommand("help")).toBe(true);
    expect(isKnownCommand("sessoins")).toBe(false);
  });
});
