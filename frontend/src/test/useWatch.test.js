/*
 * Tests for useWatch.js — the watch-event coalescing composable.
 *
 * We cover:
 *   - Subscribes to the event on mount, unsubscribes on unmount
 *   - A burst of events within the batch window produces ONE reload
 *   - The whole batch is handed to the summarize callback
 *   - The batch resets after each flush (no stale events)
 *   - watchAnnouncement builds "1 Pod x added" / "3 pods added" messages
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import { useWatch, watchAnnouncement } from "../useWatch.js";

// Handlers registered through the mocked api module, keyed by event name.
const { listeners } = vi.hoisted(() => ({ listeners: {} }));

vi.mock("../api.js", () => ({
  onEvent: (name, handler) => {
    listeners[name] = handler;
    return () => {
      delete listeners[name];
    };
  },
}));

function makeHost({ eventName = "watch:pods", reload = vi.fn(), summarize = vi.fn() } = {}) {
  return defineComponent({
    setup() {
      useWatch(eventName, { reload, summarize });
      return {};
    },
    template: "<div />",
  });
}

async function mountHost(opts) {
  const w = mount(makeHost(opts));
  await nextTick();
  return w;
}

beforeEach(() => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  vi.clearAllMocks();
});

describe("useWatch — lifecycle", () => {
  it("subscribes to the event on mount", async () => {
    const w = await mountHost();
    expect(listeners["watch:pods"]).toBeTypeOf("function");
    w.unmount();
  });

  it("unsubscribes on unmount", async () => {
    const w = await mountHost();
    w.unmount();
    await nextTick();
    expect(listeners["watch:pods"]).toBeUndefined();
  });
});

describe("useWatch — coalescing", () => {
  it("does not reload until the batch window elapses", async () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      const w = await mountHost({ reload });
      const emit = listeners["watch:pods"];
      emit({ type: "ADDED", name: "a" });
      vi.advanceTimersByTime(299);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(reload).toHaveBeenCalledOnce();
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a burst of events into a single reload", async () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      const w = await mountHost({ reload });
      const emit = listeners["watch:pods"];
      emit({ type: "ADDED", name: "a" });
      emit({ type: "ADDED", name: "b" });
      emit({ type: "DELETED", name: "c" });
      vi.advanceTimersByTime(300);
      expect(reload).toHaveBeenCalledOnce();
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the whole batch to summarize", async () => {
    vi.useFakeTimers();
    try {
      const summarize = vi.fn();
      const w = await mountHost({ summarize });
      const emit = listeners["watch:pods"];
      emit({ type: "ADDED", name: "a" });
      emit({ type: "DELETED", name: "b" });
      vi.advanceTimersByTime(300);
      expect(summarize).toHaveBeenCalledOnce();
      const batch = summarize.mock.calls[0][0];
      expect(batch).toHaveLength(2);
      expect(batch.map((e) => e.name)).toEqual(["a", "b"]);
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the batch after each flush", async () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      const w = await mountHost({ reload });
      const emit = listeners["watch:pods"];
      emit({ type: "ADDED", name: "a" });
      vi.advanceTimersByTime(300);
      emit({ type: "ADDED", name: "b" });
      vi.advanceTimersByTime(300);
      expect(reload).toHaveBeenCalledTimes(2);
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchAnnouncement", () => {
  it("announces a single add by name", () => {
    expect(watchAnnouncement("Pod", "pods", [{ type: "ADDED", name: "web-1" }])).toBe(
      "Pod web-1 added."
    );
  });

  it("announces a single delete by name", () => {
    expect(watchAnnouncement("Secret", "secrets", [{ type: "DELETED", name: "s1" }])).toBe(
      "Secret s1 deleted."
    );
  });

  it("counts multiple adds", () => {
    const batch = [
      { type: "ADDED", name: "a" },
      { type: "ADDED", name: "b" },
      { type: "ADDED", name: "c" },
    ];
    expect(watchAnnouncement("Pod", "pods", batch)).toBe("3 pods added.");
  });

  it("combines adds and deletes in one message", () => {
    const batch = [
      { type: "ADDED", name: "a" },
      { type: "DELETED", name: "b" },
    ];
    expect(watchAnnouncement("Service", "services", batch)).toBe(
      "Service a added. Service b deleted."
    );
  });

  it("returns an empty string for an irrelevant batch", () => {
    expect(watchAnnouncement("Pod", "pods", [{ type: "MODIFIED", name: "a" }])).toBe("");
  });
});
