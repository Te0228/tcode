/**
 * Input history that survives restarts (spec §15.5).
 *
 * readline keeps history in memory only, so every restart lost it — and
 * restarts are frequent, because until now switching sessions meant
 * quitting the process.
 *
 * Stored per project rather than globally: what you type in one repo has
 * almost no overlap with another, and merging them only makes scrolling
 * back longer.
 */
import fs from "node:fs";
import path from "node:path";

export const HISTORY_MAX_ENTRIES = 500;

function historyPath(root: string): string {
  return path.join(root, ".tcode", "history");
}

/**
 * Newest first, which is the order readline's `history` option expects.
 *
 * A missing or unreadable file is normal, not an error: history is a
 * convenience and must never stand between the user and a working REPL.
 */
export function loadHistory(root: string, max = HISTORY_MAX_ENTRIES): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(historyPath(root), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => decodeEntry(line))
    .filter((line) => line.length > 0)
    .slice(-max)
    .reverse();
}

/** `entries` arrives newest-first from readline; stored oldest-first so the
 * file reads like a log and appending stays natural. */
export function saveHistory(root: string, entries: string[], max = HISTORY_MAX_ENTRIES): void {
  try {
    fs.mkdirSync(path.dirname(historyPath(root)), { recursive: true });
    const body = entries
      .filter((entry) => entry.trim().length > 0)
      .slice(0, max)
      .reverse()
      .map(encodeEntry)
      .join("\n");
    fs.writeFileSync(historyPath(root), body ? `${body}\n` : "");
  } catch {
    // Losing history is not worth failing a session over.
  }
}

// One entry per line, so a multi-line message (spec §15.2) has to survive
// the round trip without turning into several history entries.
const encodeEntry = (entry: string): string => entry.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

function decodeEntry(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "\\") {
      out += line[i];
      continue;
    }
    const next = line[++i];
    out += next === "n" ? "\n" : next === "\\" ? "\\" : next ?? "";
  }
  return out;
}
