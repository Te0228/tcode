import fs from "node:fs";
import { resolveInRoot } from "../security.js";
import {
  ToolError,
  optionalNumber,
  requireString,
  truncateOutput,
  type Tool,
} from "./types.js";

/** `cat -n` style output so the model can quote exact `old_string`s for
 * `edit_file` (spec §5.2). */
function withLineNumbers(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, " ")}\t${line}`)
    .join("\n");
}

export const readFileTool: Tool = {
  schema: {
    name: "read_file",
    description:
      "Read a file from the project, returned with line numbers (like `cat -n`). " +
      "Use `offset`/`limit` to page through large files. Always read a file before editing it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the project root." },
        offset: { type: "number", description: "1-based line number to start from." },
        limit: { type: "number", description: "Maximum number of lines to return." },
      },
      required: ["path"],
    },
  },

  execute(input, context) {
    const inputPath = requireString(input, "path");
    const offset = optionalNumber(input, "offset");
    const limit = optionalNumber(input, "limit");
    const resolved = resolveInRoot(context.root, inputPath);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new ToolError(`file not found: ${inputPath}`);
    }
    if (stat.isDirectory()) {
      throw new ToolError(`path is a directory, not a file: ${inputPath}`);
    }

    const allLines = fs.readFileSync(resolved, "utf8").split("\n");
    const startLine = Math.max(1, Math.floor(offset ?? 1));
    const start = startLine - 1;
    if (start >= allLines.length) {
      throw new ToolError(
        `offset ${startLine} is past the end of ${inputPath} (${allLines.length} lines)`,
      );
    }

    const end = limit === undefined ? allLines.length : start + Math.max(1, Math.floor(limit));
    const selected = allLines.slice(start, end);
    const body = withLineNumbers(selected, startLine);
    const truncated = end < allLines.length
      ? `${body}\n\n[showing lines ${startLine}-${start + selected.length} of ${allLines.length}]`
      : body;

    return truncateOutput(truncated, context.config.maxOutputChars);
  },
};
