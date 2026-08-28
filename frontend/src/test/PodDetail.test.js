import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import PodDetail from "../components/PodDetail.vue";
import { api } from "../api.js";
import { useStore } from "../store.js";

vi.mock("../api.js", () => ({
  api: {
    getPod: vi.fn(),
    getPodMetrics: vi.fn(),
    listPortForwards: vi.fn().mockResolvedValue([]),
    startPortForward: vi.fn(),
    stopPortForward: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

const POD = {
  name: "web-abc12",
  phase: "Running",
  podIP: "10.0.0.5",
  node: "node-1",
  hostIP: "192.168.1.10",
  serviceAccount: "default",
  qosClass: "Burstable",
  age: "3h",
  containers: [
    {
      name: "app",
      ready: true,
      state: "Running",
      stateReason: "",
      stateMessage: "",
      image: "nginx:1.27",
      restartCount: 1,
    },
    {
      name: "sidecar",
      ready: false,
      state: "Waiting",
      stateReason: "CrashLoopBackOff",
      stateMessage: "back-off 5m0s restarting",
      image: "busybox",
      restartCount: 7,
    },
  ],
  conditions: [
    { type: "Ready", status: "True", reason: "PodReady" },
    { type: "Initialized", status: "True", reason: "" },
  ],
  labels: { app: "web", tier: "frontend" },
};

const METRICS = {
  cpu: "25m",
  cpuRequest: "10m",
  cpuLimit: "100m",
  memory: "50Mi",
  memoryRequest: "20Mi",
  memoryLimit: "128Mi",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getPod.mockResolvedValue(POD);
  api.getPodMetrics.mockResolvedValue(METRICS);
});

async function mountDetail(props = {}) {
  const w = mount(PodDetail, {
    props: { namespace: "default", pod: "web-abc12", ...props },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

describe("PodDetail - rendering", () => {
  it("renders the detail fields and live metrics", async () => {
    const w = await mountDetail();
    expect(w.text()).toContain("Running");
    expect(w.text()).toContain("10.0.0.5");
    expect(w.text()).toContain("node-1");
    expect(w.text()).toContain("192.168.1.10");
    expect(w.text()).toContain("default");
    expect(w.text()).toContain("Burstable");
    expect(w.text()).toContain("25m");
    expect(w.text()).toContain("(request 10m, limit 100m)");
    expect(w.text()).toContain("50Mi");
    w.unmount();
  });

  it("renders container cards with health details", async () => {
    const w = await mountDetail();
    const cards = w.findAll(".border.rounded.p-2.mb-2");
    expect(cards).toHaveLength(2);
    // Unhealthy container carries the danger border and the crash reason.
    expect(cards[1].classes()).toContain("border-danger");
    expect(cards[1].text()).toContain("not ready");
    expect(cards[1].text()).toContain("CrashLoopBackOff");
    expect(cards[1].text()).toContain("back-off 5m0s restarting");
    expect(cards[0].classes()).not.toContain("border-danger");
    expect(cards[0].text()).toContain("ready");
    w.unmount();
  });

  it("renders conditions and labels when present", async () => {
    const w = await mountDetail();
    expect(w.text()).toContain("Conditions");
    expect(w.text()).toContain("PodReady");
    expect(w.text()).toContain("Labels");
    expect(w.text()).toContain("app=web");
    expect(w.text()).toContain("tier=frontend");
    w.unmount();
  });

  it("omits conditions and labels sections when empty", async () => {
    api.getPod.mockResolvedValue({ ...POD, conditions: [], labels: {} });
    const w = await mountDetail();
    await w.setProps({ pod: "other" });
    await flushPromises();
    expect(w.text()).not.toContain("Conditions");
    expect(w.text()).not.toContain("Labels");
    w.unmount();
  });

  it("degrades gracefully when metrics are unavailable", async () => {
    api.getPodMetrics.mockRejectedValue(new Error("metrics-server missing"));
    const w = await mountDetail();
    expect(w.text()).toContain("metrics unavailable");
    expect(w.text()).toContain("10.0.0.5"); // detail still rendered
    w.unmount();
  });

  it("shows an error when the pod detail cannot be loaded", async () => {
    api.getPod.mockRejectedValue(new Error("pod not found"));
    const w = await mountDetail();
    expect(w.find('[role="alert"]').text()).toContain("pod not found");
    expect(w.find("dl").exists()).toBe(false);
    w.unmount();
  });

  it("shows loading while fetching", async () => {
    let resolve;
    api.getPod.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const w = mount(PodDetail, {
      props: { namespace: "default", pod: "web-abc12" },
    });
    await flushPromises();
    expect(w.find('[role="status"]').text()).toContain("Loading");
    resolve(POD);
    await flushPromises();
    expect(w.find('[role="status"]').exists()).toBe(false);
    w.unmount();
  });
});

describe("PodDetail - actions", () => {
  it("reloads detail and metrics via the refresh button", async () => {
    const w = await mountDetail();
    const refresh = w
      .findAll("button")
      .find((b) => b.text().includes("Refresh pod details"));
    await refresh.trigger("click");
    await flushPromises();
    expect(api.getPod).toHaveBeenCalledTimes(2);
    expect(api.getPodMetrics).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it("emits close from the Close button and on Escape", async () => {
    const w = await mountDetail();
    const closeBtn = w.findAll("button").find((b) => b.text() === "Close");
    await closeBtn.trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    await w.trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toHaveLength(2);
    w.unmount();
  });

  it("reloads when the pod prop changes", async () => {
    const w = await mountDetail();
    await w.setProps({ pod: "web-xyz78" });
    await flushPromises();
    expect(api.getPod).toHaveBeenLastCalledWith("default", "web-xyz78");
    expect(api.getPodMetrics).toHaveBeenLastCalledWith("default", "web-xyz78");
    w.unmount();
  });
});

describe("PodDetail - port forwarding", () => {
  it("hides the port-forward panel while experimental features are off", async () => {
    const w = await mountDetail();
    expect(w.text()).not.toContain("Port forwarding");
    w.unmount();
  });

  it("shows the port-forward panel when experimental features are on", async () => {
    const { setExperimental } = useStore();
    setExperimental(true);
    let w;
    try {
      w = await mountDetail();
      expect(w.text()).toContain("Port forwarding");
      expect(api.listPortForwards).toHaveBeenCalled();
      // The form is collapsed by default; the panel heading is visible.
      expect(w.find('input[role="combobox"]').exists()).toBe(false);
    } finally {
      setExperimental(false);
      w?.unmount();
    }
  });
});
