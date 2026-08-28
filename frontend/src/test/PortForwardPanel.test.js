import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import PortForwardPanel from "../components/PortForwardPanel.vue";
import { api, onEvent } from "../api.js";
import { useStore } from "../store.js";

vi.mock("../api.js", () => ({
  api: {
    startPortForward: vi.fn(),
    stopPortForward: vi.fn(),
    listPortForwards: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

let statusHandler = null;

function mountPanel(props = {}) {
  return mount(PortForwardPanel, {
    props: { namespace: "default", pod: "web-abc12", ports: [8080, 8443], ...props },
    attachTo: document.body,
  });
}

const ACTIVE = {
  id: "pf-1",
  namespace: "default",
  pod: "web-abc12",
  localPort: 4242,
  remotePort: 8080,
  state: "active",
  error: "",
};

// Capture the event subscription at module scope: the composable subscribes
// once per test (after resetPortForwards), and the captured handler stays
// valid through the live `statusHandler` binding.
onEvent.mockImplementation((_name, handler) => {
  statusHandler = handler;
  return () => {};
});

beforeEach(async () => {
  vi.clearAllMocks();
  api.listPortForwards.mockResolvedValue([]);
  api.startPortForward.mockResolvedValue({ ...ACTIVE, state: "starting" });
  api.stopPortForward.mockResolvedValue(undefined);
  // Fresh singleton so each mount re-subscribes and re-hydrates.
  const { resetPortForwards } = await import("../usePortForwards.js");
  resetPortForwards();
  // Clear any announcement the previous test left in the shared store.
  const { announce } = useStore();
  announce("");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  // Clipboard stub for the copy action.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue() },
    configurable: true,
  });
});

function emitStatus(status) {
  statusHandler?.(status);
}

// announce() mirrors into the store's aria-live region on the next animation
// frame; await it so assertions see the message.
async function flushAnnounce() {
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

describe("PortForwardPanel - rendering", () => {
  it("shows the empty state and lists no forwards", async () => {
    const w = mountPanel();
    await flushPromises();
    expect(w.text()).toContain("No active port forwards for this pod.");
    expect(w.text()).toContain("Port forwarding");
    expect(api.listPortForwards).toHaveBeenCalledWith();
    w.unmount();
  });

  it("rehydrates active forwards for this pod on mount", async () => {
    api.listPortForwards.mockResolvedValue([
      ACTIVE,
      { ...ACTIVE, id: "pf-2", namespace: "other", pod: "x" },
      { ...ACTIVE, id: "pf-3", state: "failed", error: "boom" },
    ]);
    const w = mountPanel();
    await flushPromises();
    expect(w.text()).toContain("127.0.0.1:4242");
    expect(w.text()).toContain("web-abc12:8080");
    expect(w.text()).not.toContain("pf-2"); // other pod
    expect(w.text()).not.toContain("pf-3"); // terminal states are skipped
    w.unmount();
  });
});

describe("PortForwardPanel - starting a forward", () => {
  it("opens the form and starts a forward with a random local port", async () => {
    const w = mountPanel();
    await flushPromises();

    const toggle = w.findAll("button").find((b) => b.text().includes("Forward port"));
    await toggle.trigger("click");
    await flushPromises();
    expect(w.find('input[role="combobox"]').exists()).toBe(true);
    // Focus moves to the first field so keyboard users land inside the form.
    expect(document.activeElement).toBe(w.find('input[role="combobox"]').element);

    // Type a remote port; local port stays empty (auto).
    await w.find('input[role="combobox"]').setValue("8080");
    await w.find("form").trigger("submit");

    expect(api.startPortForward).toHaveBeenCalledWith("default", "web-abc12", 0, 8080);

    // The row appears via the "starting" event (the shared state owns rows).
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    await flushPromises();
    expect(w.text()).not.toContain("No active port forwards for this pod.");
    expect(w.text()).toContain("127.0.0.1:4242");
    w.unmount();
  });

  it("uses an explicit local port when given", async () => {
    const w = mountPanel();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Forward port")).trigger("click");
    await w.find('input[role="combobox"]').setValue("9090");
    await w.find("#pf-local-port").setValue("7000");
    await w.find("form").trigger("submit");
    expect(api.startPortForward).toHaveBeenCalledWith("default", "web-abc12", 7000, 9090);
    w.unmount();
  });

  it("rejects an out-of-range remote port without calling the backend", async () => {
    const w = mountPanel();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Forward port")).trigger("click");
    await w.find('input[role="combobox"]').setValue("70000");
    await w.find("form").trigger("submit");
    expect(api.startPortForward).not.toHaveBeenCalled();
    expect(w.find('[role="alert"]').text()).toContain("Remote port must be a number");
    w.unmount();
  });

  it("rejects an out-of-range explicit local port", async () => {
    const w = mountPanel();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Forward port")).trigger("click");
    await w.find('input[role="combobox"]').setValue("8080");
    await w.find("#pf-local-port").setValue("-2");
    await w.find("form").trigger("submit");
    expect(api.startPortForward).not.toHaveBeenCalled();
    expect(w.find('[role="alert"]').text()).toContain("Local port must be a number");
    w.unmount();
  });

  it("shows the backend error inline when starting fails", async () => {
    api.startPortForward.mockRejectedValue(new Error("already active"));
    const w = mountPanel();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Forward port")).trigger("click");
    await w.find('input[role="combobox"]').setValue("8080");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("already active");
    w.unmount();
  });
});

describe("PortForwardPanel - stopping and actions", () => {
  it("stops a forward on the Stop button and removes the row on the event", async () => {
    const w = mountPanel();
    await flushPromises();
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    await flushPromises();

    const stopBtn = w.findAll("button").find((b) => b.text().includes("Stop port forward"));
    await stopBtn.trigger("click");
    expect(api.stopPortForward).toHaveBeenCalledWith("pf-1");

    emitStatus({ ...ACTIVE, state: "stopped" });
    await flushPromises();
    expect(w.text()).toContain("No active port forwards for this pod.");
    w.unmount();
  });

  it("removes the row and announces assertively when a forward fails", async () => {
    const { state } = useStore();
    const w = mountPanel();
    await flushPromises();
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    await flushPromises();
    emitStatus({ ...ACTIVE, state: "failed", error: "pod is not running" });
    await flushAnnounce();
    expect(w.text()).toContain("No active port forwards for this pod.");
    expect(state.status).toContain("failed");
    expect(state.status).toContain("pod is not running");
    w.unmount();
  });

  it("does not resurrect a row whose terminal event raced ahead", async () => {
    let resolveStart;
    api.startPortForward.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const w = mountPanel();
    await flushPromises();
    await w
      .findAll("button")
      .find((b) => b.text().includes("Forward port"))
      .trigger("click");
    await w.find('input[role="combobox"]').setValue("8080");
    await w.find("form").trigger("submit");

    // While the backend call is in flight the forward fails…
    emitStatus({ ...ACTIVE, id: "pf-1", state: "failed", error: "pod is not running" });
    await flushPromises();
    expect(w.text()).toContain("No active port forwards for this pod.");

    // …and the stale "starting" response must not resurrect the row.
    resolveStart({ ...ACTIVE, id: "pf-1", state: "starting" });
    await flushPromises();
    expect(w.text()).toContain("No active port forwards for this pod.");
    w.unmount();
  });

  it("ignores status events for other pods", async () => {
    const w = mountPanel();
    await flushPromises();
    emitStatus({ ...ACTIVE, id: "pf-9", pod: "other-pod" });
    await flushPromises();
    expect(w.text()).toContain("No active port forwards for this pod.");
    w.unmount();
  });

  it("copies the local address", async () => {
    const w = mountPanel();
    await flushPromises();
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Copy")).trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("127.0.0.1:4242");
    w.unmount();
  });

  it("opens the local address in the default browser", async () => {
    const open = vi.fn();
    window.runtime.BrowserOpenURL = open;
    const w = mountPanel();
    await flushPromises();
    emitStatus({ ...ACTIVE, state: "starting" });
    emitStatus(ACTIVE);
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Open in browser")).trigger("click");
    expect(open).toHaveBeenCalledWith("http://127.0.0.1:4242");
    w.unmount();
  });
});
