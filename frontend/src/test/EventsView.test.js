/*
 * Tests for EventsView.vue  the namespace events table with filters.
 *
 * We cover:
 *   - Renders every event returned by the API
 *   - Warnings-only toggle narrows to Warning events
 *   - Text filter matches reason / message / object
 *   - A no-match message appears when the filter matches nothing
 *   - The copy button copies an event message
 *   - The honest empty state explains the ~1h retention window
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import EventsView from "../components/EventsView.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { listEvents: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

const { setConnection, setNamespace } = useStore();

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

beforeEach(() => {
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");
  vi.clearAllMocks();
});

const EVENTS = [
  {
    type: "Warning",
    reason: "FailedScheduling",
    object: "Pod/web-1",
    message: "0/1 nodes are available",
    count: 3,
    lastSeen: "2m",
  },
  {
    type: "Normal",
    reason: "Scheduled",
    object: "Pod/web-1",
    message: "Successfully assigned",
    count: 1,
    lastSeen: "2m",
  },
  {
    type: "Warning",
    reason: "BackOff",
    object: "Pod/db-1",
    message: "Back-off restarting failed container",
    count: 5,
    lastSeen: "1m",
  },
];

async function mountEvents() {
  api.listEvents.mockResolvedValue(EVENTS);
  const w = mount(EventsView, { attachTo: document.body });
  await flushPromises();
  return w;
}

describe("EventsView  rendering", () => {
  it("renders every event", async () => {
    const w = await mountEvents();
    expect(w.findAll("tbody tr")).toHaveLength(3);
    w.unmount();
  });
});

describe("EventsView  filters", () => {
  it("warnings-only narrows to warning events", async () => {
    const w = await mountEvents();
    await w.find("#warnings-only").setValue(true);
    expect(w.findAll("tbody tr")).toHaveLength(2);
    w.unmount();
  });

  it("text filter matches reason and message", async () => {
    const w = await mountEvents();
    await w.find("#event-filter").setValue("backoff");
    expect(w.findAll("tbody tr")).toHaveLength(1);
    expect(w.text()).toContain("BackOff");
    w.unmount();
  });

  it("text filter matches the object field", async () => {
    const w = await mountEvents();
    await w.find("#event-filter").setValue("pod/web-1");
    expect(w.findAll("tbody tr")).toHaveLength(2);
    w.unmount();
  });

  it("shows a no-match message when nothing matches", async () => {
    const w = await mountEvents();
    await w.find("#event-filter").setValue("zzz-none");
    expect(w.text()).toContain("No events match");
    w.unmount();
  });
});

describe("EventsView  copy", () => {
  it("copies an event message", async () => {
    const w = await mountEvents();
    const btn = w.findAll("button").find((b) => b.text().includes("Copy"));
    await btn.trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "0/1 nodes are available",
    );
    w.unmount();
  });
});

describe("EventsView  empty events window", () => {
  it("explains the retention window instead of looking broken", async () => {
    // No events at all  the exact "screen looks empty" case.
    api.listEvents.mockResolvedValue([]);
    const w = mount(EventsView, { attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain("No events in the last hour");
    w.unmount();
  });
});

describe("EventsView  refresh button", () => {
  it("reloads events via the refresh button", async () => {
    const w = await mountEvents();
    api.listEvents.mockClear();
    await w
      .findAll("button")
      .find((b) => b.text().includes("Refresh activity"))
      .trigger("click");
    await flushPromises();
    expect(api.listEvents).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});
