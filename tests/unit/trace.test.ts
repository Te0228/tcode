import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOOP_TRACER,
  createFileTracer,
  readTrace,
  tracePath,
  tracingEnabled,
} from "../../src/trace.js";

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tcode-trace-test-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

const tracer = (warn?: (m: string) => void) =>
  createFileTracer({ cwd, sessionId: "s1", warn });

describe("createFileTracer", () => {
  it("writes one JSON object per line", () => {
    const t = tracer();
    t.emit("turn_start", { input: "hi" });
    t.emit("turn_end", { outcome: "finished" });

    const lines = fs.readFileSync(tracePath(cwd, "s1"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ type: "turn_start", input: "hi", depth: 0 });
  });

  it("stamps a monotonic seq so the viewer has a total order", () => {
    const t = tracer();
    for (let i = 0; i < 5; i++) t.emit("tick");

    expect(readTrace(cwd, "s1").map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("continues the sequence when reopening an existing trace", () => {
    tracer().emit("first");
    const reopened = tracer();
    reopened.emit("second");

    const events = readTrace(cwd, "s1");
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events.map((e) => e.type)).toEqual(["first", "second"]);
  });

  it("appends rather than overwriting on --continue", () => {
    tracer().emit("turn_start", { input: "one" });
    tracer().emit("turn_start", { input: "two" });

    expect(readTrace(cwd, "s1")).toHaveLength(2);
  });
});

describe("child tracers", () => {
  it("writes subagent events into the same file one level deeper", () => {
    const t = tracer();
    t.emit("subagent_start", { role: "explore" });
    const child = t.child();
    child.emit("tool_call", { name: "bash" });
    t.emit("subagent_end", { role: "explore" });

    expect(readTrace(cwd, "s1").map((e) => e.depth)).toEqual([0, 1, 0]);
  });

  it("shares one sequence across depths so ordering stays total", () => {
    const t = tracer();
    t.emit("a");
    t.child().emit("b");
    t.child().child().emit("c");
    t.emit("d");

    const events = readTrace(cwd, "s1");
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events.map((e) => e.depth)).toEqual([0, 1, 2, 0]);
  });
});

describe("failure handling", () => {
  it("warns once and then goes quiet when writes fail", () => {
    const warn = vi.fn();
    const t = tracer(warn);

    // Replace the trace file with a directory: appends now fail.
    fs.rmSync(tracePath(cwd, "s1"), { force: true });
    fs.mkdirSync(tracePath(cwd, "s1"));

    for (let i = 0; i < 5; i++) t.emit("tick");

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/tracing disabled/);
  });

  it("never throws out of emit — tracing must not kill a turn", () => {
    const t = tracer(() => {});
    fs.rmSync(tracePath(cwd, "s1"), { force: true });
    fs.mkdirSync(tracePath(cwd, "s1"));

    expect(() => t.emit("tick")).not.toThrow();
  });
});

describe("readTrace", () => {
  it("returns an empty list when no trace exists", () => {
    expect(readTrace(cwd, "missing")).toEqual([]);
  });

  it("skips a half-written final line instead of failing the whole read", () => {
    const t = tracer();
    t.emit("good");
    fs.appendFileSync(tracePath(cwd, "s1"), '{"seq":1,"type":"trunc');

    const events = readTrace(cwd, "s1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("good");
  });
});

describe("tracingEnabled", () => {
  it.each([
    [undefined, true],
    ["on", true],
    ["", true],
    ["off", false],
    ["OFF", false],
    [" off ", false],
  ])("TRACE=%s -> %s", (value, expected) => {
    expect(tracingEnabled(value === undefined ? {} : { TRACE: value })).toBe(expected);
  });
});

describe("NOOP_TRACER", () => {
  it("swallows everything and keeps returning itself", () => {
    expect(() => NOOP_TRACER.emit("x", { a: 1 })).not.toThrow();
    expect(NOOP_TRACER.child().child()).toBe(NOOP_TRACER);
  });
});
