import fs from "node:fs";
import path from "node:path";
import { resolveInRoot } from "../security.js";
import { diffLines, diffStat } from "../ui/format.js";
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
    const before = existed ? fs.readFileSync(resolved, "utf8") : "";

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content);

    const verb = existed ? "overwrote" : "created";
    return {
      result: `${verb} ${inputPath} (${content.length} chars) ${diffStat(before, content)}`,
      display: diffLines(before, content),
    };
  },
};
