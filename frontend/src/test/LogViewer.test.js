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
    getLogTemplateSettings: vi
      .fn()
      .mockResolvedValue({ templates: [], activeId: "" }),
    setActiveLogTemplate: vi.fn().mockResolvedValue(undefined),
    saveLogTemplate: vi.fn().mockResolvedValue({ id: "t1", name: "App" }),
    deleteLogTemplate: vi.fn().mockResolvedValue(undefined),
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
import { useStore } from "../store.js";

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
  useStore().setExperimental(false);
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

describe("LogViewer - log format templates (experimental)", () => {
  const TEMPLATES = [
    { id: "t1", name: "App", fieldOrder: ["msg", "ts"] },
    { id: "t2", name: "Other", fieldOrder: ["level"] },
  ];

  async function mountExperimental() {
    useStore().setExperimental(true);
    api.getLogTemplateSettings.mockResolvedValue({
      templates: TEMPLATES,
      activeId: "",
    });
    const w = await mountLogViewer();
    await settle();
    return w;
  }

  // Drive the readonly Format combobox like a keyboard user: ArrowDown opens
  // it, ArrowDown moves the highlight, Enter picks.
  async function pickFormat(w, steps) {
    const box = w.find("#opt-format");
    await box.trigger("keydown", { key: "ArrowDown" }); // open
    for (let i = 0; i < steps; i++) {
      await box.trigger("keydown", { key: "ArrowDown" });
    }
    await box.trigger("keydown", { key: "Enter" });
    await settle();
  }

  function formatStatus(w) {
    return w.find("#format-status").exists()
      ? w.find("#format-status").text()
      : "";
  }

  it("hides the Format control while experimental features are off", async () => {
    const w = await mountLogViewer();
    expect(w.find("#opt-format").exists()).toBe(false);
    expect(api.getLogTemplateSettings).not.toHaveBeenCalled();
    w.unmount();
  });

  it("lists None, the saved templates and Manage in the Format dropdown", async () => {
    const w = await mountExperimental();
    const box = w.find("#opt-format");
    expect(box.element.value).toBe("None (raw)");

    await box.trigger("keydown", { key: "ArrowDown" });
    const options = [
      ...box.element
        .closest(".qba-combobox")
        .querySelectorAll('[role="option"]'),
    ].map((o) => o.textContent.trim());
    expect(options).toEqual([
      "None (raw)",
      "App",
      "Other",
      "Manage templates…",
    ]);
    w.unmount();
  });

  it("reorders existing lines when a template is selected and keeps copy raw", async () => {
    const w = await mountExperimental();
    await pushLines('{"ts":1,"msg":"hello"}', "plain text");

    await pickFormat(w, 1); // None → App
    expect(api.setActiveLogTemplate).toHaveBeenCalledWith("t1");

    await settleUntil(
      w,
      (w) =>
        w.findAll(".log-line").length > 0 &&
        w.findAll(".log-line")[0].text().includes('"msg":"hello"'),
    );
    const lines = w.findAll(".log-line");
    expect(lines[0].text()).toBe('{"msg":"hello", "ts":1}');
    expect(lines[1].text()).toBe("plain text");

    // The passive status counts lines the template could not format.
    await settleUntil(w, (w) =>
      formatStatus(w).includes("1 line isn't a JSON object"),
    );
    expect(formatStatus(w)).not.toContain("don't match");

    // Copy/Save still export the RAW lines, never the reordered display.
    await w
      .findAll("button")
      .find((b) => b.text() === "Copy")
      .trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '{"ts":1,"msg":"hello"}\nplain text',
    );
    w.unmount();
  });

  it("announces the applied format once", async () => {
    const w = await mountExperimental();
    await pushLines('{"ts":1,"msg":"x"}');
    await pickFormat(w, 1); // None → App
    await settleUntil(w, () =>
      useStore().state.status.includes("Format: App applied."),
    );
    w.unmount();
  });

  it("counts lines whose JSON has none of the template's fields", async () => {
    const w = await mountExperimental();
    await pushLines('{"a":1,"b":2}', '{"msg":"x"}');
    await pickFormat(w, 1); // None → App (msg, ts)
    await settleUntil(w, (w) =>
      formatStatus(w).includes("1 line doesn't match"),
    );
    expect(formatStatus(w)).not.toContain("aren't JSON");
    // The unmatched JSON line stays raw; the matched one is reordered.
    const lines = w.findAll(".log-line");
    expect(lines[0].text()).toBe('{"a":1,"b":2}');
    expect(lines[1].text()).toBe('{"msg":"x"}');
    w.unmount();
  });

  it("returns to raw display when None is selected", async () => {
    const w = await mountExperimental();
    await pushLines('{"ts":1,"msg":"x"}');
    await pickFormat(w, 1); // None → App
    await settleUntil(
      w,
      (w) => w.findAll(".log-line")[0]?.text() === '{"msg":"x", "ts":1}',
    );

    const box = w.find("#opt-format");
    await box.trigger("keydown", { key: "ArrowDown" }); // opens on App (current)
    await box.trigger("keydown", { key: "ArrowUp" }); // None
    await box.trigger("keydown", { key: "Enter" });
    await settleUntil(
      w,
      (w) => w.findAll(".log-line")[0]?.text() === '{"ts":1,"msg":"x"}',
    );
    expect(api.setActiveLogTemplate).toHaveBeenLastCalledWith("");
    w.unmount();
  });

  it("opens the template manager from Manage templates… and closes on Escape", async () => {
    const w = await mountExperimental();
    const box = w.find("#opt-format");
    await box.trigger("keydown", { key: "ArrowDown" }); // open
    await box.trigger("keydown", { key: "ArrowDown" }); // App
    await box.trigger("keydown", { key: "ArrowDown" }); // Other
    await box.trigger("keydown", { key: "ArrowDown" }); // Manage…
    await box.trigger("keydown", { key: "Enter" });
    await settle();

    const dialog = w.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("Log templates");
    // The combobox keeps showing the real selection, not "Manage".
    expect(box.element.value).toBe("None (raw)");

    await dialog.trigger("keydown", { key: "Escape" });
    await settle();
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    // The underlying log viewer must stay open: Escape stopped at the dialog.
    expect(w.find(".log-view").exists()).toBe(true);
    w.unmount();
  });

  it("applies the persisted active template without any user action", async () => {
    useStore().setExperimental(true);
    api.getLogTemplateSettings.mockResolvedValue({
      templates: TEMPLATES,
      activeId: "t1",
    });
    const w = await mountLogViewer();
    await settle(); // initial template load
    await pushLines('{"ts":1,"msg":"auto"}');
    const lines = w.findAll(".log-line");
    expect(lines[0].text()).toBe('{"msg":"auto", "ts":1}');
    expect(w.find("#opt-format").element.value).toBe("App");
    w.unmount();
  });

  it("reverts to raw display when experimental features are disabled live", async () => {
    useStore().setExperimental(true);
    api.getLogTemplateSettings.mockResolvedValue({
      templates: TEMPLATES,
      activeId: "t1",
    });
    const w = await mountLogViewer();
    await settle();
    await pushLines('{"ts":1,"msg":"x"}');
    expect(w.findAll(".log-line")[0].text()).toBe('{"msg":"x", "ts":1}');

    useStore().setExperimental(false);
    await settleUntil(
      w,
      (w) => w.findAll(".log-line")[0]?.text() === '{"ts":1,"msg":"x"}',
    );
    expect(w.find("#opt-format").exists()).toBe(false);
    w.unmount();
  });

  it("does not call the backend again when the same format is re-picked", async () => {
    const w = await mountExperimental();
    await pushLines('{"ts":1,"msg":"x"}');
    await pickFormat(w, 1); // None → App
    expect(api.setActiveLogTemplate).toHaveBeenCalledTimes(1);

    // Re-pick App: the list opens on the current value, Enter re-picks it.
    const box = w.find("#opt-format");
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "Enter" });
    await settle();
    expect(api.setActiveLogTemplate).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("keeps the display unchanged and reports when persisting the format fails", async () => {
    const w = await mountExperimental();
    await pushLines('{"ts":1,"msg":"x"}');
    api.setActiveLogTemplate.mockRejectedValueOnce(new Error("disk full"));

    await pickFormat(w, 1); // None → App
    await settleUntil(w, () => useStore().state.statusKind === "assertive");
    expect(useStore().state.status).toContain("Failed to change log format");
    // No rebuild happened: the line still reads raw and the dropdown shows
    // the real (unchanged) selection.
    expect(w.findAll(".log-line")[0].text()).toBe('{"ts":1,"msg":"x"}');
    expect(w.find("#opt-format").element.value).toBe("None (raw)");
    w.unmount();
  });

  it("searches the displayed (reordered) text", async () => {
    const w = await mountExperimental();
    await pushLines('{"ts":1,"msg":"needle"}');
    await pickFormat(w, 1); // None → App
    await settleUntil(
      w,
      (w) => w.findAll(".log-line")[0]?.text() === '{"msg":"needle", "ts":1}',
    );
    await w.find("#log-search").setValue("needle");
    await settleUntil(w, (w) => statusText(w).includes("1 matching"));
    expect(w.find(".log-mark").text()).toBe("needle");
    w.unmount();
  });

  it("keeps the passive counters correct when the buffer cap evicts lines", async () => {
    const w = await mountExperimental();
    // Half the lines overlap the template (msg), half don't (a/b only).
    const many = [];
    for (let i = 0; i < 20010; i++) {
      many.push(i % 2 === 0 ? `{"msg":${i}}` : `{"a":${i},"b":1}`);
    }
    await pickFormat(w, 1); // None → App
    await pushLines(...many);
    // 20010 lines arrive, 10 are evicted: 5 of each category.
    await settleUntil(w, (w) =>
      formatStatus(w).includes("10000 lines don't match"),
    );
    expect(formatStatus(w)).not.toContain("aren't JSON");
    w.unmount();
  });

  it("applies rapid format picks in order even when an earlier persist is slow", async () => {
    const w = await mountExperimental();
    await pushLines('{"ts":1,"msg":"x"}');

    const pending = [];
    api.setActiveLogTemplate.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );

    const box = w.find("#opt-format");
    // Pick App (t1): its persist hangs.
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "Enter" });
    await settle();
    // Pick Other (t2) while t1 is still in flight: the combobox already
    // shows the optimistic App pick, so the list reopens on App and one
    // ArrowDown reaches Other.
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "Enter" });
    await settle();

    // The second persist must wait for the first: serialized, in pick order.
    expect(api.setActiveLogTemplate).toHaveBeenCalledTimes(1);
    expect(api.setActiveLogTemplate).toHaveBeenLastCalledWith("t1");

    pending[0]();
    await settleUntil(w, (w) => w.find("#opt-format").element.value === "App");
    expect(api.setActiveLogTemplate).toHaveBeenCalledTimes(2);
    expect(api.setActiveLogTemplate).toHaveBeenLastCalledWith("t2");

    pending[1]();
    await settleUntil(
      w,
      (w) => w.find("#opt-format").element.value === "Other",
    );
    // The last pick wins: "Other" (fields: level) has no overlap with the
    // line, so the display is raw again and the counter says so.
    await settleUntil(
      w,
      (w) =>
        w.findAll(".log-line")[0]?.text() === '{"ts":1,"msg":"x"}' &&
        formatStatus(w).includes("1 line doesn't match"),
    );
    api.setActiveLogTemplate.mockResolvedValue(undefined);
    w.unmount();
  });

  it("lets a newer pick decide when an earlier persist fails", async () => {
    const w = await mountExperimental();
    await pushLines('{"ts":1,"msg":"x"}');

    const pending = [];
    api.setActiveLogTemplate.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    const before = useStore().state.status;

    const box = w.find("#opt-format");
    // Pick App (t1): its persist hangs.
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "Enter" });
    await settle();
    // Pick Other (t2) while t1 is still in flight.
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "ArrowDown" });
    await box.trigger("keydown", { key: "Enter" });
    await settle();
    expect(api.setActiveLogTemplate).toHaveBeenCalledTimes(1);

    // Now fail the FIRST persist: it is superseded by the t2 pick and must
    // stay completely silent (no failure announce, no revert). The combobox
    // optimistically shows the newest pick ("Other") via v-model; a buggy
    // revert would flip it back to "None (raw)".
    pending[0].reject(new Error("boom"));
    await settle();
    expect(useStore().state.status).toBe(before);
    expect(w.find("#opt-format").element.value).toBe("Other");

    // The queued second persist runs and wins.
    expect(api.setActiveLogTemplate).toHaveBeenCalledTimes(2);
    pending[1].resolve();
    await settleUntil(
      w,
      (w) => w.find("#opt-format").element.value === "Other",
    );
    await settleUntil(w, () =>
      useStore().state.status.includes("Format: Other applied."),
    );
    expect(useStore().state.status).not.toContain(
      "Failed to change log format",
    );
    api.setActiveLogTemplate.mockResolvedValue(undefined);
    w.unmount();
  });
});
