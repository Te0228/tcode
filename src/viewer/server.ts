/**
 * Local viewer server (spec §13.4). Node's built-in http, no dependencies.
 * Read-only: it serves the page and streams the trace, and offers no way
 * to modify a session or start a conversation.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { readTrace, tracePath } from "../trace.js";
import { renderPage } from "./page.js";

export interface ViewerOptions {
  cwd: string;
  sessionId: string;
  /** 0 lets the OS pick a free port — avoids "address in use" entirely. */
  port?: number;
  open?: boolean;
}

/** Polling beats fs.watch here: it is portable, and a trace append is
 * cheap to detect by size. */
const POLL_MS = 400;

export function createViewerServer(options: ViewerOptions): http.Server {
  const file = tracePath(options.cwd, options.sessionId);

  return http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/" || url.startsWith("/?")) {
      const body = renderPage(options.sessionId);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    if (url.startsWith("/events")) {
      streamEvents(res, options, file);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

function streamEvents(res: http.ServerResponse, options: ViewerOptions, file: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let sent = 0;
  const flush = () => {
    const events = readTrace(options.cwd, options.sessionId);
    for (const event of events.slice(sent)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    sent = events.length;
  };

  flush();

  // Re-read only when the file grew; a session with no activity costs a
  // stat() per tick and nothing else.
  let lastSize = safeSize(file);
  const timer = setInterval(() => {
    const size = safeSize(file);
    if (size !== lastSize) {
      lastSize = size;
      flush();
    }
  }, POLL_MS);

  res.on("close", () => clearInterval(timer));
}

function safeSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    // Detached and ignored: the browser must not keep the CLI alive, and
    // its stderr must not pollute the terminal.
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Headless box or no handler — the URL is printed anyway.
  }
}

export async function startViewer(options: ViewerOptions): Promise<string> {
  const server = createViewerServer(options);

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://127.0.0.1:${port}/`;

  if (options.open !== false) openBrowser(url);
  return url;
}
