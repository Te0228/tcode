import fs from "node:fs";
import path from "node:path";
import { resolveInRoot } from "../security.js";
import { requireString, type Tool } from "./types.js";

export const writeFileTool: Tool = {
  schema: {
    name: "write_file",
    description:
      "Write a whole file, creating it or overwriting it entirely. " +
      "Use for new files or full rewrites; use edit_file for small changes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the project root." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
    },
  },

  execute(input, context) {
    const inputPath = requireString(input, "path");
    const content = requireString(input, "content");
    const resolved = resolveInRoot(context.root, inputPath);
    const existed = fs.existsSync(resolved);

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content);

    return `${existed ? "overwrote" : "created"} ${inputPath} (${content.length} chars)`;
  },
};
