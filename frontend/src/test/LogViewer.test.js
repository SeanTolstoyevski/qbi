/*
 * Tests for LogViewer.vue — desktop-style log navigation.
 *
 * We cover:
 *   - Roving tabindex: only the active line is in the tab order
 *   - Arrow keys move the focused line
 *   - Home/End jump to first/last
 *   - Ctrl+C copies the focused line
 *   - Ctrl+C with nothing focused falls back to copying all
 *   - Ctrl+A copies all logs
 *
 * The log stream is simulated by capturing the onEvent handlers from the
 * mocked api module and pushing lines through them.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";

// Handlers registered via onEvent, keyed by event name. Declared through
// vi.hoisted so the mock factory (hoisted above imports) can close over it.
const { listeners } = vi.hoisted(() => ({ listeners: {} }));

vi.mock("../api.js", () => ({
  api: {
    startLogStream: vi.fn().mockResolvedValue("stream-1"),
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

// Push a raw log line through the mocked stream event.
async function pushLine(text) {
  listeners["log:stream-1"]?.(text);
  await nextTick();
  await nextTick();
}

async function mountWithLines() {
  const w = await mountLogViewer();
  for (const t of LINES) await pushLine(t);
  return w;
}

function lineAt(w, i) {
  return w.findAll(".log-line")[i];
}

function keydown(w, key, extra = {}) {
  return w.find(".log-view").trigger("keydown", { key, ...extra });
}

describe("LogViewer — line navigation", () => {
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

describe("LogViewer — copying", () => {
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
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(LINES.join("\n"));
    w.unmount();
  });

  it("Ctrl+A copies the whole log", async () => {
    const w = await mountWithLines();
    await keydown(w, "a", { ctrlKey: true });
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(LINES.join("\n"));
    w.unmount();
  });
});
