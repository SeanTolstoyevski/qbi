import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ForwardsView from "../components/ForwardsView.vue";
import { api, onEvent } from "../api.js";
import { useStore } from "../store.js";

vi.mock("../api.js", () => ({
  api: {
    listPortForwards: vi.fn(),
    stopPortForward: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

let statusHandler = null;

const ACTIVE = {
  id: "pf-1",
  namespace: "default",
  pod: "web-abc12",
  localPort: 4242,
  remotePort: 8080,
  state: "active",
  error: "",
};

const OTHER = {
  ...ACTIVE,
  id: "pf-2",
  namespace: "prod",
  pod: "db-0",
  localPort: 5433,
  remotePort: 5432,
};

// Capture the event subscription at module scope: the composable subscribes
// once per test (after resetPortForwards), and the captured handler stays
// valid through the live `statusHandler` binding.
onEvent.mockImplementation((_name, handler) => {
  statusHandler = handler;
  return () => {};
});

async function mountView() {
  const w = mount(ForwardsView, { attachTo: document.body });
  await flushPromises();
  return w;
}

function emitStatus(status) {
  statusHandler?.(status);
}

async function flushAnnounce() {
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

beforeEach(async () => {
  vi.clearAllMocks();
  api.listPortForwards.mockResolvedValue([]);
  api.stopPortForward.mockResolvedValue(undefined);
  // Fresh singleton + fresh store state for each test; the next mount
  // re-subscribes and re-hydrates.
  const { resetPortForwards } = await import("../usePortForwards.js");
  resetPortForwards();
  const { setExperimental, announce } = useStore();
  setExperimental(false);
  announce("");
  await flushAnnounce();
});

describe("ForwardsView - empty states", () => {
  it("explains the experimental gate when the feature is off", async () => {
    const w = await mountView();
    expect(w.text()).toContain("experimental feature");
    expect(w.find("table").exists()).toBe(false);
    w.unmount();
  });

  it("shows the empty state when the feature is on but nothing runs", async () => {
    useStore().setExperimental(true);
    const w = await mountView();
    expect(w.find('[role="status"]').text()).toContain(
      "No active port forwards",
    );
    w.unmount();
  });
});

describe("ForwardsView - rows", () => {
  it("lists every forward across namespaces with actions", async () => {
    useStore().setExperimental(true);
    const w = await mountView();
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    emitStatus({ ...OTHER, state: "starting" });
    emitStatus(OTHER);
    await flushPromises();

    expect(w.text()).toContain("127.0.0.1:4242");
    expect(w.text()).toContain("web-abc12:8080");
    expect(w.text()).toContain("default");
    expect(w.text()).toContain("127.0.0.1:5433");
    expect(w.text()).toContain("db-0:5432");
    expect(w.text()).toContain("prod");
    expect(w.findAll("tbody tr")).toHaveLength(2);
    w.unmount();
  });

  it("hydrates existing forwards from the backend", async () => {
    useStore().setExperimental(true);
    api.listPortForwards.mockResolvedValue([ACTIVE]);
    const w = await mountView(); // subscription hydrates on mount
    expect(w.text()).toContain("127.0.0.1:4242");
    w.unmount();
  });

  it("does not resurrect a forward whose terminal event raced hydration", async () => {
    useStore().setExperimental(true);
    const w = await mountView();
    emitStatus({ ...ACTIVE, state: "failed", error: "boom" });
    // A stale hydrate result still lists it as active; the tombstone must win.
    api.listPortForwards.mockResolvedValue([ACTIVE]);
    const { usePortForwards } = await import("../usePortForwards.js");
    await usePortForwards().hydrate();
    await flushPromises();
    expect(usePortForwards().forwards.value).toHaveLength(0);
    w.unmount();
  });
});

describe("ForwardsView - stopping", () => {
  it("stops a forward on the button and removes the row on the event", async () => {
    useStore().setExperimental(true);
    const w = await mountView();
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    await flushPromises();

    await w
      .findAll("button")
      .find((b) => b.text().includes("Stop port forward"))
      .trigger("click");
    expect(api.stopPortForward).toHaveBeenCalledWith("pf-1");

    emitStatus({ ...ACTIVE, state: "stopped" });
    await flushPromises();
    expect(w.text()).toContain("No active port forwards");
    w.unmount();
  });

  it("announces a stop exactly once, wherever it was initiated", async () => {
    useStore().setExperimental(true);
    const { state } = useStore();
    const { usePortForwards } = await import("../usePortForwards.js");
    const w = await mountView();
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    // Initiated from the pod detail panel: it calls the same shared
    // stopForward, so the announcement is made here, exactly once.
    await usePortForwards().stopForward(ACTIVE);
    emitStatus({ ...ACTIVE, state: "stopped" });
    await flushAnnounce();
    expect(state.status).toContain("web-abc12:8080 stopped");
    // A raw stopped event without a stop request (clean end) stays silent.
    emitStatus({ ...OTHER, state: "starting" });
    emitStatus(OTHER);
    emitStatus({ ...OTHER, state: "stopped" });
    await flushAnnounce();
    expect(state.status).not.toContain("db-0:5432 stopped");
    w.unmount();
  });

  it("announces a failure assertively even when the pod detail is closed", async () => {
    useStore().setExperimental(true);
    const { state } = useStore();
    const w = await mountView();
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    emitStatus({ ...ACTIVE, state: "failed", error: "pod is not running" });
    await flushAnnounce();
    expect(w.text()).toContain("No active port forwards");
    expect(state.status).toContain("failed");
    expect(state.status).toContain("pod is not running");
    w.unmount();
  });
});

describe("ForwardsView - announcements", () => {
  it("announces a start once when the forward becomes active", async () => {
    useStore().setExperimental(true);
    const { state } = useStore();
    const w = await mountView();
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    await flushAnnounce();
    expect(state.status).toContain("Port forward started: 127.0.0.1:4242");
    // A duplicate active event must not re-announce.
    emitStatus(ACTIVE);
    await flushAnnounce();
    expect(state.status).toContain("Port forward started");
    w.unmount();
  });
});

describe("ForwardsView - reconnect", () => {
  it("drops stale rows after a reconnect", async () => {
    useStore().setExperimental(true);
    api.listPortForwards.mockResolvedValue([ACTIVE]);
    const w = await mountView();
    expect(w.text()).toContain("127.0.0.1:4242");

    // Reconnect: backend tears everything down; the registry is drained.
    api.listPortForwards.mockResolvedValue([]);
    useStore().setConnection({ name: "ctx" });
    await flushPromises();
    expect(w.text()).toContain("No active port forwards");
    w.unmount();
  });
});
