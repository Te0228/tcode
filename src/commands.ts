/**
 * Slash commands (spec §15.3).
 *
 * The REPL had no commands at all — including no `/help`, which meant the
 * CLI shipped without a way to ask it anything about itself. Switching
 * sessions or compacting meant quitting the process and relaunching with a
 * flag.
 *
 * Parsing and help text live here, as pure functions. Dispatch stays in the
 * REPL, which is the only thing holding the session and the agent deps.
 */
import type { Palette } from "./ui/theme.js";

export interface CommandSpec {
  name: string;
  /** Shown after the name in `/help`. */
  usage?: string;
  summary: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: "help", summary: "commands and keys" },
  { name: "status", summary: "provider, session, memory and approval mode" },
  { name: "model", usage: "[name]", summary: "show the active model, or switch to another" },
  { name: "context", summary: "what is using the context window" },
  { name: "compact", summary: "summarize the history now instead of at the threshold" },
  { name: "diff", summary: "what has changed on disk" },
  { name: "undo", summary: "put back the files the last turn changed" },
  { name: "retry", summary: "send the previous message again" },
  { name: "memory", summary: "which AGENTS.md files are loaded" },
  { name: "init", summary: "write a first AGENTS.md for this project" },
  { name: "tools", summary: "what this agent can do" },
  { name: "approvals", summary: "when tcode asks before running something" },
  { name: "view", summary: "open this session in the browser viewer" },
  { name: "export", usage: "[file]", summary: "write the transcript as markdown" },
  { name: "sessions", summary: "list sessions in this directory" },
  { name: "resume", usage: "[id]", summary: "switch session; without an id, pick from a list" },
  { name: "new", summary: "start an empty session here" },
  { name: "clear", summary: "clear the screen" },
  { name: "exit", summary: "quit" },
  { name: "quit", summary: "quit" },
];

export interface ParsedCommand {
  name: string;
  /** Everything after the command name, trimmed. */
  args: string;
}

/**
 * A leading `/` means the line is for the CLI, not the model.
 *
 * The name has to be followed by whitespace or nothing, so `/usr/local/bin`
 * stays a path and `/ 2` stays a division sign. Both are ordinary things to
 * type, and swallowing them as commands would be worse than missing a
 * command: the message never reaches the model at all.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

export function isKnownCommand(name: string): boolean {
  return COMMANDS.some((command) => command.name === name);
}

/** Keyboard behaviour is not discoverable by definition — it has to be
 * written down somewhere, and this is the only place the user can reach
 * without leaving the REPL. */
const KEY_HELP: [string, string][] = [
  ["Esc", "interrupt the running turn"],
  ["Ctrl+C", "interrupt; again to quit"],
  ["Ctrl+D", "quit"],
  ["Tab", "complete a file path"],
  ["@path", "send a file along with your message"],
  ["\\ at end of line", "continue on the next line"],
  ["↑ / ↓", "previous inputs"],
];

export function renderHelp(palette: Palette): string[] {
  const width = Math.max(...COMMANDS.map((command) => nameOf(command).length));
  const lines = [palette.strong("commands")];
  for (const command of COMMANDS) {
    // `/quit` is a pure alias; listing it twice is noise.
    if (command.name === "quit") continue;
    lines.push(`  ${nameOf(command).padEnd(width)}  ${palette.meta(command.summary)}`);
  }

  const keyWidth = Math.max(...KEY_HELP.map(([key]) => key.length));
  lines.push("", palette.strong("keys"));
  for (const [key, summary] of KEY_HELP) {
    lines.push(`  ${key.padEnd(keyWidth)}  ${palette.meta(summary)}`);
  }
  lines.push("");
  return lines;
}

function nameOf(command: CommandSpec): string {
  return `/${command.name}${command.usage ? ` ${command.usage}` : ""}`;
}

/**
 * A typo must not be forwarded to the model. Getting a thoughtful answer to
 * `/sessoins` is the most confusing possible response, because it looks
 * like the command ran.
 */
export function unknownCommand(name: string, palette: Palette): string[] {
  return [
    palette.error(`unknown command /${name}`),
    palette.meta(`  ${COMMANDS.map((command) => `/${command.name}`).join("  ")}`),
    "",
  ];
}
