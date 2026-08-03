/**
 * Approval policy (spec §3/§5.1/§7).
 *
 * One question decides everything: **does this command write outside the
 * project directory?** Reading anything is harmless; writing inside the
 * project is the user's own workspace. Only writes that escape the
 * project — plus privilege escalation, system administration and
 * outward-facing publishing — are worth interrupting for.
 *
 * Prompting for every `ls` is not caution, it is noise: users learn to
 * hit enter without reading, and then the one dangerous command sails
 * through too. Approval fatigue is itself a security problem.
 *
 * This analysis is a HEURISTIC, not a guarantee — see spec §5.1. Bash
 * commands are opaque strings and `eval "$X"` defeats any static check.
 * The hard guarantee lives in `security.ts`, for the file tools.
 */
import path from "node:path";
import readline from "node:readline";
import { BASH_TOOL_NAME } from "./tools/bash.js";
import type { ToolUseBlock } from "./llm/types.js";

/** Commands that only read. Safe regardless of which paths they touch. */
const READ_ONLY_COMMANDS = new Set([
  "cat", "ls", "grep", "rg", "find", "head", "tail", "wc", "file", "stat",
  "which", "type", "diff", "echo", "pwd", "date", "basename", "dirname",
  "realpath", "readlink", "du", "df", "tree", "less", "more", "sort", "uniq",
  "awk", "sed", "cut", "env", "printenv", "whoami", "hostname", "uname", "ps",
]);

/** `git <sub>` that only reads. Anything else (push, clean, reset) falls
 * through to the general rules. */
const READ_ONLY_GIT = new Set([
  "status", "log", "diff", "show", "branch", "remote", "config", "blame",
  "describe", "ls-files", "rev-parse", "shortlog", "tag",
]);

/** Commands whose whole job is changing the machine, not the project. */
const SYSTEM_COMMANDS = new Set([
  "brew", "apt", "apt-get", "yum", "dnf", "pacman", "systemctl", "launchctl",
  "defaults", "crontab", "diskutil", "shutdown", "reboot", "mkfs", "mount",
  "umount", "chown", "chgrp", "dscl", "visudo",
]);

const ESCALATION_COMMANDS = new Set(["sudo", "su", "doas", "pkexec"]);

/** Writing here is harmless and extremely common (`2>/dev/null`). */
const HARMLESS_WRITE_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

export interface ApprovalDecision {
  needsConfirmation: boolean;
  /** Shown to the user so the prompt explains itself. */
  reason?: string;
}

/** Splits on pipes and connectors so each stage is judged on its own —
 * `cat a > /etc/hosts` must not pass just because it starts with `cat`. */
function splitSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** Crude tokenizer: good enough to spot paths and flags, and it keeps
 * quoted strings together so `echo "a b"` is one token. */
function tokenize(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, "");
}

function isInsideRoot(target: string, root: string): boolean {
  const resolved = path.resolve(root, target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** Output redirection to somewhere outside the project. Catches both
 * `> /etc/x` and `>/etc/x`. */
function redirectsOutsideRoot(segment: string, root: string): string | undefined {
  for (const match of segment.matchAll(/(?:^|\s)\d?>>?\s*("[^"]*"|'[^']*'|\S+)/g)) {
    const target = unquote(match[1]);
    if (HARMLESS_WRITE_TARGETS.has(target)) continue;
    if (!isInsideRoot(target, root)) return target;
  }
  return undefined;
}

/** A token that points outside the project: absolute path, home, or a
 * `..` traversal that escapes. */
function escapingPath(token: string, root: string): string | undefined {
  const value = unquote(token);
  if (value.startsWith("-")) return undefined;

  if (value === "~" || value.startsWith("~/") || value.includes("$HOME")) return value;
  if (value.startsWith("/")) {
    return HARMLESS_WRITE_TARGETS.has(value) || isInsideRoot(value, root) ? undefined : value;
  }
  if (value.split("/").includes("..")) {
    return isInsideRoot(value, root) ? undefined : value;
  }
  return undefined;
}

function judgeSegment(segment: string, root: string): ApprovalDecision {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return { needsConfirmation: false };

  const command = path.basename(unquote(tokens[0]));

  if (ESCALATION_COMMANDS.has(command)) {
    // Also practical: sudo prompts for a password, and `bash` runs
    // synchronously — an unattended sudo would hang the terminal.
    return { needsConfirmation: true, reason: `runs with elevated privileges (${command})` };
  }

  const redirect = redirectsOutsideRoot(segment, root);
  if (redirect) {
    return { needsConfirmation: true, reason: `writes outside the project (${redirect})` };
  }

  // Reading is harmless wherever it points — that is the whole rule.
  if (READ_ONLY_COMMANDS.has(command)) return { needsConfirmation: false };
  if (command === "git" && READ_ONLY_GIT.has(unquote(tokens[1] ?? ""))) {
    return { needsConfirmation: false };
  }

  if (SYSTEM_COMMANDS.has(command)) {
    return { needsConfirmation: true, reason: `changes system state (${command})` };
  }

  if (command === "git" && unquote(tokens[1] ?? "") === "push") {
    return { needsConfirmation: true, reason: "publishes to a remote and is hard to undo" };
  }

  if (["npm", "yarn", "pnpm"].includes(command)) {
    if (tokens.some((token) => token === "-g" || token === "--global")) {
      return { needsConfirmation: true, reason: "installs globally, outside the project" };
    }
  }

  for (const token of tokens.slice(1)) {
    const escaped = escapingPath(token, root);
    if (escaped) {
      return { needsConfirmation: true, reason: `touches a path outside the project (${escaped})` };
    }
  }

  return { needsConfirmation: false };
}

/**
 * Judges a whole command line. Any segment needing confirmation makes the
 * whole command need it (spec §5.1).
 */
export function judgeCommand(command: string, root: string): ApprovalDecision {
  const resolvedRoot = path.resolve(root);
  for (const segment of splitSegments(command)) {
    const decision = judgeSegment(segment, resolvedRoot);
    if (decision.needsConfirmation) return decision;
  }
  return { needsConfirmation: false };
}

export interface ApprovalPolicy {
  needsConfirmation(toolUse: ToolUseBlock): boolean;
  confirm(toolUse: ToolUseBlock): Promise<boolean>;
  /** Why the last decision required confirmation, for the prompt text. */
  reasonFor(toolUse: ToolUseBlock): string | undefined;
}

/** Result of asking the user (spec §16.6). `always` records the command
 * for the rest of the process, nothing more — a persistent allowlist is a
 * different decision and not one to make in passing. */
export type ApprovalAnswer = "yes" | "always" | "no";

export interface ApprovalOptions {
  /** Project root — the boundary the whole policy is defined against. */
  root: string;
  /** `--full-auto` startup flag: skip confirmation entirely (spec §8.2). */
  fullAuto?: boolean;
  /** Single-keypress dialog (spec §16.6). Preferred when present. */
  ask?: (request: { command: string; reason: string }) => Promise<ApprovalAnswer>;
  /** Text fallback for a pipe, and for tests that need no TTY. */
  prompt?: (question: string) => Promise<string>;
}

/** Fallback only. A caller that already owns stdin (the REPL does) must
 * inject its own `prompt` — a second readline interface on the same stdin
 * silently swallows the answer. */
async function promptOnStdin(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

function commandOf(toolUse: ToolUseBlock): string {
  const input = toolUse.input as Record<string, unknown> | null;
  return input && typeof input.command === "string" ? input.command : "";
}

export function createApprovalPolicy(options: ApprovalOptions): ApprovalPolicy {
  const askText = options.prompt ?? promptOnStdin;
  const root = path.resolve(options.root);
  /** Commands the user chose "don't ask again" for. Process-scoped and
   * never written to disk (spec §16.6). */
  const allowed = new Set<string>();

  const decide = (toolUse: ToolUseBlock): ApprovalDecision => {
    if (options.fullAuto) return { needsConfirmation: false };
    if (allowed.has(commandOf(toolUse).trim())) return { needsConfirmation: false };
    // Only bash is opaque. The file tools are hard-bounded by
    // `resolveInRoot`, and `remember` writes a path fixed in code.
    if (toolUse.name !== BASH_TOOL_NAME) return { needsConfirmation: false };
    return judgeCommand(commandOf(toolUse), root);
  };

  return {
    needsConfirmation: (toolUse) => decide(toolUse).needsConfirmation,
    reasonFor: (toolUse) => decide(toolUse).reason,

    async confirm(toolUse) {
      const reason = decide(toolUse).reason ?? "run this";
      const command = commandOf(toolUse).trim();

      if (options.ask) {
        const answer = await options.ask({ command, reason });
        // Repeating the same command a dozen times in one task and being
        // asked every time is how users learn to confirm without reading —
        // the approval fatigue §5.1 exists to avoid.
        if (answer === "always") allowed.add(command);
        return answer !== "no";
      }

      const answer = (await askText(`  ${reason}. proceed? [Y/n] `)).trim().toLowerCase();
      // Enter (empty answer) means yes; only an explicit "n"/"no" declines.
      return answer !== "n" && answer !== "no";
    },
  };
}
