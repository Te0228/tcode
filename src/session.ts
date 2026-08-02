import fs from "node:fs";
import path from "node:path";
import type { Message } from "./llm/types.js";

/** A cached summary of `messages[0, upToIndex)` (spec §3.1/§4). Pure
 * cache: the summarized messages are still in `messages`, so deleting a
 * compaction only costs a recomputation — it never loses history. */
export interface Compaction {
  upToIndex: number;
  summary: string;
  tokensBefore: number;
  createdAt: string;
}

/** Session shape persisted to disk (spec §4). `messages` is the
 * normalized internal format, never a provider's raw wire format, and is
 * never truncated — context trimming happens on a view (see context.ts). */
export interface Session {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  /** Optional: sessions written before compaction existed have none. */
  compactions?: Compaction[];
}

function sessionsDir(cwd: string): string {
  return path.join(cwd, ".tcode", "sessions");
}

function sessionPath(cwd: string, id: string): string {
  return path.join(sessionsDir(cwd), `${id}.json`);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function idTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
}

export function createSession(cwd: string, provider: string, model: string): Session {
  const now = new Date().toISOString();
  return {
    id: `${idTimestamp(new Date(now))}-${randomSuffix()}`,
    cwd,
    provider,
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
    compactions: [],
  };
}

export function saveSession(session: Session): void {
  session.updatedAt = new Date().toISOString();
  fs.mkdirSync(sessionsDir(session.cwd), { recursive: true });
  fs.writeFileSync(sessionPath(session.cwd, session.id), JSON.stringify(session, null, 2));
}

export function loadSession(cwd: string, id: string): Session {
  const file = sessionPath(cwd, id);
  if (!fs.existsSync(file)) {
    throw new Error(`no session found with id "${id}" in ${sessionsDir(cwd)}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as Session;
}

/** Returns the session with the most recent `updatedAt`, or undefined if
 * none exist yet (spec §4 `--continue`). */
export function findLatestSession(cwd: string): Session | undefined {
  const dir = sessionsDir(cwd);
  if (!fs.existsSync(dir)) return undefined;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  let latest: Session | undefined;
  for (const file of files) {
    const session = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Session;
    if (!latest || session.updatedAt > latest.updatedAt) {
      latest = session;
    }
  }
  return latest;
}
