/**
 * Layered memory (spec §9): static Markdown read into the system prompt,
 * with a write path so the agent isn't starting from zero every session.
 * No retrieval, no vector store, no background self-summarization.
 */
import fs from "node:fs";
import path from "node:path";
import { userConfigDir } from "./config.js";
import { estimateTokens } from "./tokens.js";

export const PROJECT_MEMORY_FILES = ["AGENTS.md", "TCODE.md"] as const;
export const USER_MEMORY_FILE = "AGENTS.md";

export type MemoryScope = "user" | "project";

export interface MemoryLayer {
  scope: MemoryScope;
  /** Absolute path, shown to the user so they know what got loaded. */
  file: string;
  /** Display label used in the system prompt. */
  label: string;
  content: string;
}

export interface DroppedEntry {
  scope: MemoryScope;
  /** Opening of the discarded entry, so the user can find and prune it. */
  preview: string;
}

export interface LoadedMemory {
  layers: MemoryLayer[];
  /** True when content was dropped to stay under the cap (spec §9.4). */
  truncated: boolean;
  /** What was dropped — discarding memory silently is not acceptable. */
  dropped: DroppedEntry[];
  tokens: number;
}

interface ParsedMemory {
  /** Title/prose before the first entry; kept out of entry truncation. */
  preamble: string;
  /** `- xxx` entries, oldest first (remember appends to the end). */
  entries: string[];
}

/**
 * Splits a memory file into its preamble and its `- ` entries. An entry
 * continues across following lines until the next `- ` bullet, so
 * multi-line notes survive intact.
 */
export function parseMemory(content: string): ParsedMemory {
  const lines = content.split("\n");
  const preamble: string[] = [];
  const entries: string[] = [];

  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      entries.push(line);
    } else if (entries.length > 0) {
      entries[entries.length - 1] += `\n${line}`;
    } else {
      preamble.push(line);
    }
  }

  return {
    preamble: preamble.join("\n").trim(),
    entries: entries.map((entry) => entry.trimEnd()).filter((entry) => entry.trim()),
  };
}

// Kept short on purpose: at small budgets a verbose marker crowds out the
// very entries it is announcing (spec §9.4).
const TRUNCATION_MARKER = "[... older entries dropped ...]";

/**
 * Drops whole entries, oldest first, until the layer fits (spec §9.4).
 * Never cuts mid-entry: a half sentence like "- always deploy with" is
 * worse than not having the entry at all.
 */
function truncateLayer(
  layer: MemoryLayer,
  allowanceTokens: number,
): { content: string; dropped: string[] } {
  const { preamble, entries } = parseMemory(layer.content);
  const withoutMarker = allowanceTokens - estimateTokens(preamble);
  const budget = withoutMarker - estimateTokens(TRUNCATION_MARKER);

  // Newest first: a newer note usually supersedes an older one, and
  // "the thing you just asked me to remember" must not be first to go.
  const pack = (limit: number): string[] => {
    const kept: string[] = [];
    let used = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const cost = estimateTokens(entries[i]) + 1;
      if (used + cost > limit) break;
      used += cost;
      kept.unshift(entries[i]);
    }
    return kept;
  };

  let kept = pack(budget);

  // Floor: if the marker's own cost is what squeezed everything out, keep
  // the newest entry anyway. A layer reduced to nothing but a marker is
  // strictly worse than one real entry (spec §9.4).
  if (kept.length === 0 && entries.length > 0) {
    kept = pack(withoutMarker).slice(-1);
  }

  const dropped = entries.slice(0, entries.length - kept.length);
  const parts = [preamble, ...kept];
  if (dropped.length > 0) parts.push(TRUNCATION_MARKER);

  return { content: parts.filter(Boolean).join("\n").trim(), dropped };
}

function previewOf(entry: string): string {
  const text = entry.replace(/^\s*-\s+/, "").replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function userMemoryPath(home?: string): string {
  return path.join(userConfigDir(home), USER_MEMORY_FILE);
}

/** Resolves the project layer's path, preferring AGENTS.md over TCODE.md. */
export function projectMemoryPath(root: string): string {
  for (const name of PROJECT_MEMORY_FILES) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return file;
  }
  return path.join(root, PROJECT_MEMORY_FILES[0]);
}

function readIfPresent(file: string): string | undefined {
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.trim() ? content.trim() : undefined;
  } catch {
    return undefined; // Missing or unreadable — both are normal.
  }
}

/**
 * Loads both layers. Order matters: user first, project second, because
 * the more specific layer wins on conflict (spec §9.1). Over the cap, the
 * user layer is trimmed first for the same reason.
 */
export function loadMemory(root: string, maxTokens: number, home?: string): LoadedMemory {
  const layers: MemoryLayer[] = [];

  const userFile = userMemoryPath(home);
  const userContent = readIfPresent(userFile);
  if (userContent) {
    layers.push({ scope: "user", file: userFile, label: "user memory (~/.tcode/AGENTS.md)", content: userContent });
  }

  const projectFile = projectMemoryPath(root);
  const projectContent = readIfPresent(projectFile);
  if (projectContent) {
    layers.push({
      scope: "project",
      file: projectFile,
      label: `project memory (${path.basename(projectFile)})`,
      content: projectContent,
    });
  }

  let tokens = layers.reduce((sum, layer) => sum + estimateTokens(layer.content), 0);
  const dropped: DroppedEntry[] = [];

  // Trim the user layer first — project conventions are more specific and
  // more likely to matter for the task at hand (spec §9.4).
  for (const layer of layers) {
    if (tokens <= maxTokens) break;
    const layerTokens = estimateTokens(layer.content);
    const others = tokens - layerTokens;
    const allowance = Math.max(0, maxTokens - others);
    if (allowance >= layerTokens) continue;

    const result = truncateLayer(layer, allowance);
    layer.content = result.content;
    tokens = others + estimateTokens(layer.content);
    for (const entry of result.dropped) {
      dropped.push({ scope: layer.scope, preview: previewOf(entry) });
    }
  }

  return { layers, truncated: dropped.length > 0, dropped, tokens };
}

/**
 * Appends one entry to a memory layer (spec §5.7/§9.2). Append-only: it
 * never rewrites what the user already put there.
 */
export function appendMemory(
  scope: MemoryScope,
  content: string,
  root: string,
  home?: string,
): string {
  const file = scope === "user" ? userMemoryPath(home) : projectMemoryPath(root);
  const entry = content.trim();

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const header = existing.trim() ? "" : `# ${scope === "user" ? "User" : "Project"} memory\n`;
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";

  fs.appendFileSync(file, `${separator}${header}\n- ${entry}\n`);
  return file;
}
