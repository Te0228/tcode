/**
 * `@path` file references (spec §15.4).
 *
 * Without them, pointing the model at a file means describing its path in
 * prose and waiting for it to call `read_file` — an extra round trip on the
 * single most common thing anyone wants to do, and one that fails outright
 * if the path was typed slightly wrong.
 *
 * The expansion is one-way and explicit: what the model receives is the
 * message with the file appended, and what the terminal shows is a single
 * folded line per attachment. Pasting a 2000-line file into the transcript
 * would defeat the point.
 */
import fs from "node:fs";
import { PathEscapesRootError, resolveInRoot } from "./security.js";
import { truncateOutput } from "./tools/types.js";

/** `@` followed by a path. Stops at whitespace; a trailing comma or period
 * is punctuation, not part of the filename. */
const MENTION = /(^|\s)@([^\s]+?)([.,;:!?]?)(?=\s|$)/g;

export interface Attachment {
  path: string;
  lines: number;
  truncated: boolean;
}

export interface ExpandedMessage {
  /** What goes into `session.messages` — the model's copy. */
  text: string;
  /** One entry per file actually attached, for the terminal. */
  attachments: Attachment[];
  /** Mentions that resolved to nothing, so the user can be told rather than
   * left wondering why the model ignored the file. */
  failures: { path: string; reason: string }[];
}

export function expandMentions(
  input: string,
  root: string,
  maxChars: number,
): ExpandedMessage {
  const attachments: Attachment[] = [];
  const failures: { path: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const match of input.matchAll(MENTION)) {
    const mentioned = match[2];
    if (seen.has(mentioned)) continue;
    seen.add(mentioned);

    let resolved: string;
    try {
      resolved = resolveInRoot(root, mentioned);
    } catch (error) {
      failures.push({
        path: mentioned,
        reason: error instanceof PathEscapesRootError ? "outside the project" : "bad path",
      });
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      failures.push({ path: mentioned, reason: "not found" });
      continue;
    }
    if (stat.isDirectory()) {
      failures.push({ path: mentioned, reason: "is a directory" });
      continue;
    }

    const content = fs.readFileSync(resolved, "utf8");
    const truncated = content.length > maxChars;
    attachments.push({
      path: mentioned,
      lines: content.split("\n").length,
      truncated,
    });
    // Kept out of the prose and fenced with the path, so the model can tell
    // the attachment from the user's own words.
    const body = truncateOutput(content, maxChars);
    input += `\n\n<file path="${mentioned}">\n${body}\n</file>`;
  }

  return { text: input, attachments, failures };
}
