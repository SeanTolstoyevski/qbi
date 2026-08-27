import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";

// Handlers registered via onEvent, keyed by event name. Declared through
// vi.hoisted so the mock factory (hoisted above imports) can close over it.
const { listeners } = vi.hoisted(() => ({ listeners: {} }));

vi.mock("../api.js", () => ({
  api: {
    startLogStream: vi.fn().mockResolvedValue("stream-1"),
    followLogStream: vi.fn().mockResolvedValue(undefined),
    stopLogStream: vi.fn().mockResolvedValue(undefined),
    saveLogs: vi.fn().mockResolvedValue(null),
  },
  onEvent: (name, handler) => {
    listeners[name] = handler;
    return () => {
      delete listeners[name];
    };
  },
}));

import LogViewer from "../components/LogViewer.vue";
import { api } from "../api.js";

const LINES = ["first line", "second line", "third line"];

beforeAll(() => {
  // happy-dom lacks these; the component relies on them during navigation.
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

beforeEach(() => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  vi.clearAllMocks();
});

async function mountLogViewer() {
  const w = mount(LogViewer, {
    props: { namespace: "default", pod: "web", container: "app" },
    attachTo: document.body,
  });
  await flushPromises(); // start() resolves, stream handlers register
  return w;
}

// Let happy-dom's RAF mock (setImmediate) and Vue's render queue run.
async function settle(times = 2) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 10));
    await nextTick();
  }
}

// Poll until a predicate on the wrapper holds (chunked rebuilds need a few
// frames to finish).
async function settleUntil(w, predicate, tries = 50) {
  for (let i = 0; i < tries; i++) {
    await settle(1);
    if (predicate(w)) return;
  }
  throw new Error("condition not reached within the settle window");
}

// Push raw log lines through the mocked stream event, batched like the
// backend: one event whose payload is the lines joined with "\n".
async function pushLines(...texts) {
  listeners["log:batch:stream-1"]?.(texts.join("\n"));
  await settle();
}

async function mountWithLines() {
  const w = await mountLogViewer();
  await pushLines(...LINES);
  return w;
}

function lineAt(w, i) {
  return w.findAll(".log-line")[i];
}

function keydown(w, key, extra = {}) {
  return w.find(".log-view").trigger("keydown", { key, ...extra });
}

function statusText(w) {
  return w.find("#match-status").text();
}

describe("LogViewer - line navigation", () => {
  it("gives the log region roving tabindex: no line is tabbable until navigated", async () => {
    const w = await mountWithLines();
    const lines = w.findAll(".log-line");
    expect(lines).toHaveLength(LINES.length);
    lines.forEach((l) => expect(l.attributes("tabindex")).toBe("-1"));
    expect(w.find(".log-view").attributes("tabindex")).toBe("0");
    w.unmount();
  });

  it("ArrowDown moves focus to the first line, then to each next line", async () => {
    const w = await mountWithLines();
    await keydown(w, "ArrowDown");
    await nextTick();
    expect(lineAt(w, 0).attributes("tabindex")).toBe("0");
    expect(lineAt(w, 0).element).toBe(document.activeElement);

    await keydown(w, "ArrowDown");
    await nextTick();
    expect(lineAt(w, 1).attributes("tabindex")).toBe("0");
    expect(lineAt(w, 1).element).toBe(document.activeElement);
    w.unmount();
  });

  it("ArrowUp moves back towards the top", async () => {
    const w = await mountWithLines();
    await keydown(w, "ArrowDown"); // line 0
    await keydown(w, "ArrowDown"); // line 1
    await keydown(w, "ArrowUp"); // back to line 0
    await nextTick();
    expect(lineAt(w, 0).attributes("tabindex")).toBe("0");
    expect(lineAt(w, 0).element).toBe(document.activeElement);
    w.unmount();
  });

  it("Home jumps to the first line and End to the last", async () => {
    const w = await mountWithLines();
    await keydown(w, "ArrowDown");
    await keydown(w, "End");
    await nextTick();
    expect(lineAt(w, LINES.length - 1).element).toBe(document.activeElement);

    await keydown(w, "Home");
    await nextTick();
    expect(lineAt(w, 0).element).toBe(document.activeElement);
    w.unmount();
  });

  it("clamps at the boundaries instead of wrapping", async () => {
    const w = await mountWithLines();
    await keydown(w, "Home");
    await keydown(w, "ArrowUp"); // before the first line
    await nextTick();
    expect(lineAt(w, 0).element).toBe(document.activeElement);

    await keydown(w, "End");
    await keydown(w, "ArrowDown"); // past the last line
    await nextTick();
    expect(lineAt(w, LINES.length - 1).element).toBe(document.activeElement);
    w.unmount();
  });
});

describe("LogViewer - copying", () => {
  it("Ctrl+C copies the focused line", async () => {
    const w = await mountWithLines();
    await keydown(w, "ArrowDown");
    await keydown(w, "ArrowDown"); // focus "second line"
    await keydown(w, "c", { ctrlKey: true });
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("second line");
    w.unmount();
  });

  it("Ctrl+C with no focused line copies the whole log", async () => {
    const w = await mountWithLines();
    await keydown(w, "c", { ctrlKey: true });
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      LINES.join("\n"),
    );
    w.unmount();
  });

  it("Ctrl+A copies the whole log", async () => {
    const w = await mountWithLines();
    await keydown(w, "a", { ctrlKey: true });
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      LINES.join("\n"),
    );
    w.unmount();
  });
});

describe("LogViewer - copy button", () => {
  it("copies the whole log via the Copy button", async () => {
    const w = await mountWithLines();
    await w
      .findAll("button")
      .find((b) => b.text() === "Copy")
      .trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      LINES.join("\n"),
    );
    w.unmount();
  });
});

describe("LogViewer - search", () => {
  it("subscribes to stream events before starting to follow", async () => {
    const w = await mountLogViewer();
    expect(api.startLogStream).toHaveBeenCalled();
    expect(api.followLogStream).toHaveBeenCalledWith("stream-1");
    // The component registers the handlers synchronously between the two
    // backend calls; following starts only afterwards, so the first batch
    // of history lines can never arrive before the listeners exist.
    const startOrder = api.startLogStream.mock.invocationCallOrder[0];
    const followOrder = api.followLogStream.mock.invocationCallOrder[0];
    expect(followOrder).toBeGreaterThan(startOrder);
    expect(listeners["log:batch:stream-1"]).toBeTypeOf("function");
    expect(listeners["log:end:stream-1"]).toBeTypeOf("function");
    w.unmount();
  });

  it("highlights plain-text matches without regex mode", async () => {
    const w = await mountWithLines();
    await w.find("#log-search").setValue("line");
    await settle();
    const marks = w.findAll(".log-mark").map((m) => m.text());
    expect(marks).toEqual(["line", "line", "line"]);
    expect(statusText(w)).toContain("3 matching lines");
    w.unmount();
  });

  it("plain search is literal: regex metacharacters match themselves", async () => {
    const w = await mountLogViewer();
    await pushLines("value (a+)+b here", "other");
    await w.find("#log-search").setValue("(a+)+b");
    await settle();
    expect(statusText(w)).toContain("1 matching lines");
    expect(w.find(".log-mark").text()).toBe("(a+)+b");
    w.unmount();
  });

  it("matches case-insensitively by default and case-sensitively with Match case", async () => {
    const w = await mountLogViewer();
    await pushLines("Error here", "no problem");
    await w.find("#log-search").setValue("error");
    await settle();
    expect(statusText(w)).toContain("1 matching lines");

    await w.find("#opt-case").setValue(true);
    await settle();
    expect(statusText(w)).toContain("0 matching lines");
    w.unmount();
  });

  it("highlights matches when case folding changes string length (İ)", async () => {
    const w = await mountLogViewer();
    await pushLines("İ line here", "no match");
    await w.find("#log-search").setValue("i");
    await settle();
    expect(statusText(w)).toContain("1 matching lines");
    expect(w.find(".log-mark").text()).toBe("İ");
    w.unmount();
  });

  it("only matches filters the rendered lines and the export", async () => {
    const w = await mountWithLines();
    await w.find("#log-search").setValue("second");
    await settle();
    await w.find("#opt-only").setValue(true);
    await settle();
    const texts = w.findAll(".log-line").map((l) => l.text());
    expect(texts).toEqual(["second line"]);

    await w
      .findAll("button")
      .find((b) => b.text() === "Copy")
      .trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("second line");
    w.unmount();
  });

  it("keeps the match count live as matching lines stream in", async () => {
    const w = await mountLogViewer();
    await w.find("#log-search").setValue("err");
    await settleUntil(w, (w) => statusText(w).includes("0 matching"));
    await pushLines("err one", "ok two", "err three");
    expect(statusText(w)).toContain("2 matching lines");
    w.unmount();
  });

  it("navigates between matches with Enter and Shift+Enter", async () => {
    const w = await mountLogViewer();
    await pushLines("noise", "err one", "ok", "err two");
    await w.find("#log-search").setValue("err");
    await settle();

    const search = w.find("#log-search");
    await search.trigger("keydown.enter");
    await nextTick();
    // The first match is highlighted…
    let current = w.find(".log-line-current");
    expect(current.exists()).toBe(true);
    expect(current.text()).toBe("err one");

    await search.trigger("keydown.enter");
    await nextTick();
    current = w.find(".log-line-current");
    expect(current.text()).toBe("err two");

    await search.trigger("keydown.enter", { shiftKey: true });
    await nextTick();
    current = w.find(".log-line-current");
    expect(current.text()).toBe("err one");
    w.unmount();
  });
});

describe("LogViewer - large buffer stays non-blocking", () => {
  // Regression guard for the reported freeze: searching a full buffer while
  // the stream keeps appending must never run the whole scan synchronously.
  it("rebuilds the filter asynchronously in chunks instead of blocking", async () => {
    const w = await mountLogViewer();
    const many = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    await pushLines(...many);
    expect(w.findAll(".log-line")).toHaveLength(5000);

    await w.find("#log-search").setValue("line");
    await nextTick();
    // Right after the keystroke the rebuild is still in flight: proving the
    // scan is chunked across frames, not one synchronous pass.
    expect(statusText(w)).toContain("Filtering");

    await settleUntil(w, (w) => statusText(w).includes("5000 matching"));
    expect(w.findAll(".log-line")).toHaveLength(5000);
    w.unmount();
  });

  it("applies lines that arrive mid-rebuild once the rebuild finishes", async () => {
    const w = await mountLogViewer();
    const many = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    await pushLines(...many);
    await w.find("#log-search").setValue("line");
    await nextTick();
    // Rebuild is in flight; this line must be queued, not lost.
    listeners["log:batch:stream-1"]?.("line 5000");
    await settleUntil(w, (w) => statusText(w).includes("5001 matching"));
    const texts = w.findAll(".log-line").map((l) => l.text());
    expect(texts[texts.length - 1]).toBe("line 5000");
    w.unmount();
  });

  it("caps the raw buffer at 20000 lines and evicts from the filtered view too", async () => {
    const w = await mountLogViewer();
    await w.find("#log-search").setValue("keep");
    await settle();
    await w.find("#opt-only").setValue(true);
    await settle();

    const many = [];
    for (let i = 0; i < 20010; i++) {
      many.push(i % 100 === 0 ? `keep ${i}` : `noise ${i}`);
    }
    await pushLines(...many);

    const texts = w.findAll(".log-line").map((l) => l.text());
    // The first 10 raw lines (including "keep 0") were evicted by the cap.
    expect(texts).toHaveLength(200);
    expect(texts[0]).toBe("keep 100");
    expect(texts[texts.length - 1]).toBe("keep 20000");
    expect(statusText(w)).toContain("200 matching lines");
    w.unmount();
  });

  it("keeps focus inside the log region when the focused line is evicted", async () => {
    const w = await mountLogViewer();
    await w.find("#log-search").setValue("keep");
    await settle();
    await w.find("#opt-only").setValue(true);
    await settle();
    await pushLines("keep 0", "noise 1");
    await keydown(w, "ArrowDown");
    await nextTick();
    expect(document.activeElement?.textContent).toBe("keep 0");

    const many = [];
    for (let i = 0; i < 20010; i++) {
      many.push(i % 100 === 0 ? `keep ${i}` : `noise ${i}`);
    }
    await pushLines(...many);

    const active = document.activeElement;
    expect(active?.classList.contains("log-line")).toBe(true);
    expect(active.textContent).toBe("keep 100");
    w.unmount();
  });
});

describe("LogViewer - ReDoS protection", () => {
  it("shows error for regex with nested quantifiers like (a+)+", async () => {
    const w = await mountLogViewer();
    const search = w.find("#log-search");
    const regexCheckbox = w.find("#opt-regex");

    await regexCheckbox.setValue(true);
    await search.setValue("(a+)+b");

    await nextTick();
    await flushPromises();

    const status = w.find("#match-status");
    expect(status.text()).toContain("Invalid pattern");
    expect(status.text()).toContain("hang");

    expect(search.classes()).toContain("is-invalid");

    w.unmount();
  });

  it("shows error for regex exceeding 500 characters", async () => {
    const w = await mountLogViewer();
    const search = w.find("#log-search");
    const regexCheckbox = w.find("#opt-regex");

    await regexCheckbox.setValue(true);
    await search.setValue("a".repeat(501));

    await nextTick();
    await flushPromises();

    const status = w.find("#match-status");
    expect(status.text()).toContain("Invalid pattern");
    expect(status.text()).toContain("500");

    w.unmount();
  });

  it("does not block valid regex patterns", async () => {
    const w = await mountLogViewer();
    const search = w.find("#log-search");
    const regexCheckbox = w.find("#opt-regex");

    await regexCheckbox.setValue(true);
    // A valid regex: match lines with "error" or "warn"
    await search.setValue("error|warn");

    await nextTick();
    await flushPromises();

    // Should NOT show an error
    const status = w.find("#match-status");
    expect(status.text()).not.toContain("Invalid pattern");
    expect(status.text()).not.toContain("hang");

    // Search input should NOT have the invalid class
    expect(search.classes()).not.toContain("is-invalid");

    w.unmount();
  });

  it("allows any pattern when regex mode is off (literal search)", async () => {
    const w = await mountLogViewer();
    const search = w.find("#log-search");

    // Do NOT enable regex mode - this is a literal search
    await search.setValue("(a+)+b");

    await nextTick();
    await flushPromises();

    // Literal search never treats the pattern as a regex; no error expected
    const status = w.find("#match-status");
    expect(status.text()).not.toContain("Invalid pattern");
    expect(search.classes()).not.toContain("is-invalid");

    w.unmount();
  });
});

describe("LogViewer - partial lines", () => {
  it("reassembles a long line arriving as part events", async () => {
    const w = await mountLogViewer();
    listeners["log:part:stream-1"]?.("abcdef");
    listeners["log:part:stream-1"]?.("ghijkl");
    listeners["log:batch:stream-1"]?.("rest");
    await settle();
    const lines = w.findAll(".log-line");
    expect(lines).toHaveLength(1);
    expect(lines[0].text()).toBe("abcdefghijklrest");
    w.unmount();
  });

  it("keeps complete lines separate from partial pieces", async () => {
    const w = await mountLogViewer();
    await pushLines("first");
    listeners["log:part:stream-1"]?.("part1-");
    listeners["log:batch:stream-1"]?.("part2");
    await pushLines("third");
    const texts = w.findAll(".log-line").map((l) => l.text());
    expect(texts).toEqual(["first", "part1-part2", "third"]);
    w.unmount();
  });

  it("flushes an unfinished partial line when the stream ends", async () => {
    const w = await mountLogViewer();
    listeners["log:part:stream-1"]?.("dangling");
    listeners["log:end:stream-1"]?.();
    await settle();
    const texts = w.findAll(".log-line").map((l) => l.text());
    expect(texts).toEqual(["dangling"]);
    w.unmount();
  });

  it("bounds memory when a line never ends", async () => {
    const w = await mountLogViewer();
    const huge = "x".repeat(1024 * 1024 + 10); // MAX_PARTIAL + slack
    listeners["log:part:stream-1"]?.(huge);
    listeners["log:part:stream-1"]?.("more");
    listeners["log:batch:stream-1"]?.("tail");
    await settle();
    const texts = w.findAll(".log-line").map((l) => l.text());
    expect(texts).toHaveLength(2);
    expect(texts[0].length).toBe(1024 * 1024 + 10);
    expect(texts[1]).toBe("moretail");
    w.unmount();
  });

  it("clearing resets the partial buffer", async () => {
    const w = await mountLogViewer();
    listeners["log:part:stream-1"]?.("stale");
    await nextTick();
    await w
      .findAll("button")
      .find((b) => b.text() === "Clear")
      .trigger("click");
    await pushLines("fresh");
    const texts = w.findAll(".log-line").map((l) => l.text());
    expect(texts).toEqual(["fresh"]);
    w.unmount();
  });

  it("resets the partial buffer when the stream restarts", async () => {
    const w = await mountLogViewer();
    listeners["log:part:stream-1"]?.("leftover");
    await nextTick();
    // Stop then Restart via the toolbar: start() → stop() clears the partial
    // buffer before the new stream registers.
    await w
      .findAll("button")
      .find((b) => b.text() === "Stop")
      .trigger("click");
    await flushPromises();
    await w
      .findAll("button")
      .find((b) => b.text() === "Restart")
      .trigger("click");
    await flushPromises();
    await pushLines("fresh");
    const texts = w.findAll(".log-line").map((l) => l.text());
    expect(texts).toEqual(["fresh"]);
    w.unmount();
  });
});
