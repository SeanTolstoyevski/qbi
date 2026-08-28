import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ActivePortForwards from "../components/ActivePortForwards.vue";
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
  pod: "db-0",
  localPort: 5433,
  remotePort: 5432,
};

async function mountChip() {
  const w = mount(ActivePortForwards, { attachTo: document.body });
  await flushPromises();
  return w;
}

function emitStatus(status) {
  statusHandler?.(status);
}

function chipButton(w) {
  return w.find("button");
}

beforeEach(async () => {
  vi.clearAllMocks();
  statusHandler = null;
  api.listPortForwards.mockResolvedValue([]);
  api.stopPortForward.mockResolvedValue(undefined);
  onEvent.mockImplementation((_name, handler) => {
    statusHandler = handler;
    return () => {};
  });
  // Clear any announcement the previous test left in the shared store.
  useStore().announce("");
  await new Promise((resolve) => requestAnimationFrame(resolve));
});

describe("ActivePortForwards - visibility", () => {
  it("renders nothing while no forward is active", async () => {
    const w = await mountChip();
    expect(w.text()).toBe("");
    w.unmount();
  });

  it("renders the chip only when at least one forward is active", async () => {
    api.listPortForwards.mockResolvedValue([ACTIVE]);
    const w = await mountChip();
    expect(w.text()).toContain("Port forwards");
    w.unmount();
  });
});

describe("ActivePortForwards - list", () => {
  it("shows every active forward with address, target and namespace", async () => {
    api.listPortForwards.mockResolvedValue([ACTIVE, OTHER]);
    const w = await mountChip();
    await chipButton(w).trigger("click");

    expect(w.text()).toContain("127.0.0.1:4242");
    expect(w.text()).toContain("web-abc12:8080");
    expect(w.text()).toContain("default");
    expect(w.text()).toContain("127.0.0.1:5433");
    expect(w.text()).toContain("db-0:5432");
    w.unmount();
  });

  it("skips terminal states during hydration", async () => {
    api.listPortForwards.mockResolvedValue([
      ACTIVE,
      { ...ACTIVE, id: "pf-9", state: "failed", error: "boom" },
      { ...ACTIVE, id: "pf-8", state: "stopped" },
    ]);
    const w = await mountChip();
    expect(w.text()).toContain("Port forwards");
    await chipButton(w).trigger("click");
    expect(w.text()).not.toContain("pf-9");
    expect(w.text()).not.toContain("pf-8");
    w.unmount();
  });

  it("adds a row when a forward starts elsewhere", async () => {
    const w = await mountChip();
    expect(w.text()).toBe("");
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    await flushPromises();
    expect(w.text()).toContain("Port forwards");
    await chipButton(w).trigger("click");
    expect(w.text()).toContain("127.0.0.1:4242");
    w.unmount();
  });

  it("closes the list on Escape", async () => {
    api.listPortForwards.mockResolvedValue([ACTIVE]);
    const w = await mountChip();
    await chipButton(w).trigger("click");
    expect(chipButton(w).attributes("aria-expanded")).toBe("true");
    await w.find("ul").trigger("keydown", { key: "Escape" });
    expect(chipButton(w).attributes("aria-expanded")).toBe("false");
    expect(w.find("ul").exists()).toBe(false);
    w.unmount();
  });
});

describe("ActivePortForwards - stopping", () => {
  it("stops a forward and announces it", async () => {
    const { state } = useStore();
    api.listPortForwards.mockResolvedValue([ACTIVE]);
    const w = await mountChip();
    await chipButton(w).trigger("click");

    await w
      .findAll("button")
      .find((b) => b.text().includes("Stop port forward"))
      .trigger("click");
    // The row disappears when the stopped event arrives.
    emitStatus({ ...ACTIVE, state: "stopped" });
    await flushPromises();

    expect(api.stopPortForward).toHaveBeenCalledWith("pf-1");
    expect(w.text()).toBe("");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(state.status).toContain("stopped");
    w.unmount();
  });

  it("does not announce stops it did not initiate", async () => {
    const { state } = useStore();
    api.listPortForwards.mockResolvedValue([ACTIVE]);
    const w = await mountChip();
    // The stop was requested from the pod detail panel, not from here.
    emitStatus({ ...ACTIVE, state: "stopped" });
    await flushPromises();
    expect(w.text()).toBe("");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(state.status).not.toContain("stopped");
    w.unmount();
  });

  it("removes a failed row silently (the pod panel owns failure announcements)", async () => {
    api.listPortForwards.mockResolvedValue([ACTIVE]);
    const w = await mountChip();
    emitStatus({ ...ACTIVE, state: "failed", error: "pod is not running" });
    await flushPromises();
    expect(w.text()).toBe("");
    w.unmount();
  });
});

describe("ActivePortForwards - reconnect", () => {
  it("rehydrates after a reconnect so stale rows disappear", async () => {
    api.listPortForwards.mockResolvedValueOnce([ACTIVE]);
    const w = await mountChip();
    expect(w.text()).toContain("Port forwards");

    // Reconnect: the backend tears down every forward without events and the
    // registry is drained.
    api.listPortForwards.mockResolvedValueOnce([]);
    useStore().setConnection({ name: "ctx" });
    await flushPromises();
    expect(w.text()).toBe("");
    w.unmount();
  });
});
