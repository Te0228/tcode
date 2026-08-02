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
  return listSessions(cwd)[0]?.session;
}

/** One row of `tcode sessions` (spec §4). */
export interface SessionSummary {
  session: Session;
  /** First thing the user typed — the only human-readable handle on a
   * session whose id is a timestamp and a random suffix. */
  firstInput: string;
  /** User + assistant messages, excluding the tool_result carriers, so the
   * number reads as "how much conversation" rather than "how much plumbing". */
  exchanges: number;
}

/**
 * Every session in `cwd`, newest first (spec §4).
 *
 * Unreadable or half-written files are skipped rather than thrown on: one
 * corrupt file must not make the whole list — or `--continue`, which is
 * built on this — unusable.
 */
export function listSessions(cwd: string): SessionSummary[] {
  const dir = sessionsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const summaries: SessionSummary[] = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    let session: Session;
    try {
      session = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Session;
    } catch {
      continue;
    }
    if (!Array.isArray(session.messages)) continue;
    summaries.push({
      session,
      firstInput: firstUserTextOf(session),
      exchanges: session.messages.filter(
        (message) => !message.content.some((block) => block.type === "tool_result"),
      ).length,
    });
  }

  return summaries.sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
}

function firstUserTextOf(session: Session): string {
  for (const message of session.messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) return block.text.trim();
    }
  }
  return "";
}
