import fs from "node:fs";
import path from "node:path";
import { resolveInRoot } from "../security.js";
import { ToolError, requireString, type Tool } from "./types.js";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const editFileTool: Tool = {
  schema: {
    name: "edit_file",
    description:
      "Replace an exact string in a file. `old_string` must match exactly once unless " +
      "`replace_all` is true — include surrounding context to make it unique. " +
      "Pass an empty `old_string` to create a new file. Read the file first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the project root." },
        old_string: { type: "string", description: "Exact text to replace; empty to create a new file." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },

  execute(input, context) {
    const inputPath = requireString(input, "path");
    const oldString = requireString(input, "old_string");
    const newString = requireString(input, "new_string");
    const replaceAll = input.replace_all === true;
    const resolved = resolveInRoot(context.root, inputPath);
    const exists = fs.existsSync(resolved);

    // Empty old_string is create-only. Refuse on an existing file rather
    // than guessing between "overwrite" and "append" (spec §5.3).
    if (oldString === "") {
      if (exists) {
        throw new ToolError(
          `${inputPath} already exists; an empty old_string only creates new files. ` +
            `Use write_file to overwrite it, or pass the exact text to replace.`,
        );
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, newString);
      return `created ${inputPath} (${newString.length} chars)`;
    }

    if (!exists) {
      throw new ToolError(`file not found: ${inputPath}`);
    }

    const content = fs.readFileSync(resolved, "utf8");
    const matches = countOccurrences(content, oldString);

    if (matches === 0) {
      throw new ToolError(
        `no match for old_string in ${inputPath}. Read the file and copy the exact text, including whitespace.`,
      );
    }
    if (matches > 1 && !replaceAll) {
      throw new ToolError(
        `old_string matched ${matches} times in ${inputPath}; nothing was changed. ` +
          `Add surrounding context to make it unique, or pass replace_all: true.`,
      );
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    fs.writeFileSync(resolved, updated);

    return matches > 1
      ? `edited ${inputPath} (${matches} occurrences replaced)`
      : `edited ${inputPath}`;
  },
};
