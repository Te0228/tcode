import { describe, expect, it } from "vitest";
import { createPasteFilter } from "../../src/ui/paste.js";

const START = "[200~";
const END = "[201~";

function harness() {
  const data: string[] = [];
  const pastes: string[] = [];
  const feed = createPasteFilter({
    onData: (chunk) => data.push(chunk),
    onPaste: (text) => pastes.push(text),
  });
  return { feed, data, pastes, typed: () => data.join("") };
}

describe("bracketed paste (spec §15.1)", () => {
  it("keeps a multi-line paste as one piece — the data-loss regression lock", () => {
    // Five lines used to become five `line` events: the first started a
    // turn and the other four were dropped with no message at all.
    const { feed, pastes, typed } = harness();
    feed(`${START}a\nb\nc\nd\ne${END}`);
    expect(pastes).toEqual(["a\nb\nc\nd\ne"]);
    expect(typed()).toBe("");
  });

  it("never leaks a marker byte into the content", () => {
    // A stray escape at the end of the message is what the first working
    // version shipped, because the marker constants had lost their ESC.
    const { feed, pastes, typed } = harness();
    feed(`${START}hello${END}`);
    expect(pastes[0]).toBe("hello");
    expect(typed()).toBe("");
  });

  it("forwards ordinary keystrokes untouched", () => {
    const { feed, pastes, typed } = harness();
    feed("hel");
    feed("lo\n");
    expect(typed()).toBe("hello\n");
    expect(pastes).toEqual([]);
  });

  it("handles a marker split across chunks", () => {
    // Six bytes long, and the terminal can break a read anywhere in them.
    const { feed, pastes, typed } = harness();
    feed("[2");
    feed("00~pasted");
    feed("[201");
    feed("~");
    expect(pastes).toEqual(["pasted"]);
    expect(typed()).toBe("");
  });

  it("holds back a partial marker rather than echoing it", () => {
    const { feed, typed } = harness();
    feed("abc[2");
    expect(typed()).toBe("abc");
  });

  it("releases a false-alarm prefix once it cannot be a marker", () => {
    const { feed, pastes, typed } = harness();
    feed("abc[2");
    feed("Z");
    expect(typed()).toBe("abc[2Z");
    expect(pastes).toEqual([]);
  });

  it("emits nothing while a paste is still arriving", () => {
    const { feed, pastes, typed } = harness();
    feed(`${START}first line\nsecond`);
    expect(pastes).toEqual([]);
    expect(typed()).toBe("");
    feed(` line${END}`);
    expect(pastes).toEqual(["first line\nsecond line"]);
  });

  it("separates typing before and after a paste", () => {
    const { feed, pastes, typed } = harness();
    feed(`before${START}pasted${END}after`);
    expect(pastes).toEqual(["pasted"]);
    expect(typed()).toBe("beforeafter");
  });

  it("handles two pastes in one chunk", () => {
    const { feed, pastes } = harness();
    feed(`${START}one${END}${START}two${END}`);
    expect(pastes).toEqual(["one", "two"]);
  });
});
