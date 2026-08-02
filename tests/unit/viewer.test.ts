import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileTracer } from "../../src/trace.js";
import { createViewerServer } from "../../src/viewer/server.js";
import { renderPage } from "../../src/viewer/page.js";

let cwd: string;
let server: http.Server;
let base: string;

beforeEach(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-viewer-test-"));
  const tracer = createFileTracer({ cwd, sessionId: "s1", warn: () => {} });
  tracer.emit("session_start", { provider: "deepseek", model: "deepseek-chat", root: cwd });
  tracer.emit("turn_start", { input: "hello" });

  server = createViewerServer({ cwd, sessionId: "s1" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("viewer server", () => {
  it("serves the page at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("404s anything else — the viewer exposes no other surface", async () => {
    expect((await fetch(`${base}/../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/api/send`)).status).toBe(404);
  });

  it("replays the existing trace over SSE", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, { signal: controller.signal });

    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    let buffer = "";
    while (buffer.split("\n\n").filter(Boolean).length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
    }
    controller.abort();

    const events = buffer
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
    expect(events.map((e) => e.type)).toEqual(["session_start", "turn_start"]);
  });
});

describe("viewer page", () => {
  const html = renderPage("s1");

  it("is fully self-contained — no external requests (spec §13.4)", () => {
    // A strict check: any absolute http(s) URL other than a local one
    // would mean the page breaks offline.
    const external = html.match(/https?:\/\/(?!127\.0\.0\.1)[^\s"')]+/g) ?? [];
    expect(external).toEqual([]);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });

  it("has syntactically valid inline JS", () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it("escapes the session id instead of interpolating it raw", () => {
    const nasty = renderPage('<img src=x onerror="alert(1)">');
    expect(nasty).not.toContain("<img src=x");
    expect(nasty).toContain("&lt;img");
  });

  it("supports both light and dark themes", () => {
    expect(html).toContain("prefers-color-scheme: dark");
  });
});
