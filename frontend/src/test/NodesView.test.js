import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import NodesView from "../components/NodesView.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: {
    listNodes: vi.fn(),
    listNodeMetrics: vi.fn(),
    getResourceYaml: vi.fn().mockResolvedValue("apiVersion: v1\nkind: Node\n"),
  },
  onEvent: vi.fn(() => () => {}),
}));

const { setConnection } = useStore();

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

beforeEach(() => {
  setConnection({ name: "test-ctx", namespace: "default" });
  vi.clearAllMocks();
});

const NODES = [
  {
    name: "node-a",
    status: "Ready",
    roles: ["control-plane"],
    version: "v1.36",
    cpu: "8",
    memory: "16Gi",
    pods: "110",
    age: "10d",
    internalIP: "10.0.0.1",
    schedulable: true,
  },
  {
    name: "node-b",
    status: "Ready",
    roles: ["worker"],
    version: "v1.36",
    cpu: "16",
    memory: "32Gi",
    pods: "110",
    age: "10d",
    internalIP: "10.0.0.2",
    schedulable: true,
  },
];

const METRICS = {
  nodes: [
    {
      name: "node-a",
      cpuUsage: "2",
      cpuAllocatable: "8",
      cpuPercent: 25,
      memoryUsage: "4Gi",
      memoryAllocatable: "16Gi",
      memoryPercent: 25,
    },
  ],
  cluster: {
    nodes: 2,
    cpuUsage: "2",
    cpuAllocatable: "24",
    cpuPercent: 8.3,
    memoryUsage: "4Gi",
    memoryAllocatable: "48Gi",
    memoryPercent: 8.3,
  },
  metricsAvailable: true,
};

async function mountNodes(metrics = METRICS) {
  api.listNodes.mockResolvedValue(NODES);
  api.listNodeMetrics.mockResolvedValue(metrics);
  const w = mount(NodesView, { attachTo: document.body });
  await flushPromises();
  return w;
}

describe("NodesView - rendering", () => {
  it("renders every node", async () => {
    const w = await mountNodes();
    expect(w.findAll("tbody tr")).toHaveLength(2);
    w.unmount();
  });

  it("shows the cluster resources card when metrics are available", async () => {
    const w = await mountNodes();
    expect(w.text()).toContain("Cluster resources");
    expect(w.text()).toContain("8.3%");
    w.unmount();
  });

  it("degrades gracefully when metrics are unavailable", async () => {
    api.listNodes.mockResolvedValue(NODES);
    api.listNodeMetrics.mockRejectedValue(
      new Error("metrics not available yet"),
    );
    const w = mount(NodesView, { attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain("Live CPU/memory usage unavailable");
    expect(w.text()).toContain("node-a"); // nodes are still shown
    w.unmount();
  });
});

describe("NodesView - filter", () => {
  it("filters nodes by name", async () => {
    const w = await mountNodes();
    await w.find("#node-filter").setValue("node-b");
    expect(w.findAll("tbody tr")).toHaveLength(1);
    expect(w.text()).toContain("node-b");
    w.unmount();
  });

  it("filters nodes by role", async () => {
    const w = await mountNodes();
    await w.find("#node-filter").setValue("worker");
    expect(w.findAll("tbody tr")).toHaveLength(1);
    expect(w.text()).toContain("node-b");
    w.unmount();
  });

  it("shows a no-match message when nothing matches", async () => {
    const w = await mountNodes();
    await w.find("#node-filter").setValue("zzz");
    expect(w.text()).toContain("No nodes match");
    w.unmount();
  });
});

describe("NodesView - copy", () => {
  it("copies the node name", async () => {
    const w = await mountNodes();
    const btn = w
      .findAll("button")
      .find((b) => b.classes().includes("copy-inline"));
    await btn.trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("node-a");
    w.unmount();
  });
});

describe("NodesView - reload after reconnect", () => {
  it("reloads nodes when reconnecting to the same context", async () => {
    const w = await mountNodes();
    expect(api.listNodes).toHaveBeenCalledTimes(1);

    setConnection({ name: "test-ctx", namespace: "default" });
    await flushPromises();

    expect(api.listNodes).toHaveBeenCalledTimes(2);
    w.unmount();
  });
});

describe("NodesView - refresh button", () => {
  it("reloads nodes and metrics via the refresh button", async () => {
    const w = await mountNodes();
    api.listNodes.mockClear();
    api.listNodeMetrics.mockClear();
    const btn = w
      .findAll("button")
      .find((b) => b.text().includes("Refresh nodes"));
    await btn.trigger("click");
    await flushPromises();
    expect(api.listNodes).toHaveBeenCalledTimes(1);
    expect(api.listNodeMetrics).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});

describe("NodesView - YAML panel focus", () => {
  it("returns focus to the row YAML button when the panel closes", async () => {
    const w = await mountNodes();
    const yamlBtn = w.findAll("button").find((b) => b.text().includes("YAML"));
    await yamlBtn.trigger("click");
    await flushPromises();
    const closeBtn = w.findAll("button").find((b) => b.text() === "Close");
    await closeBtn.trigger("click");
    await nextTick();
    expect(document.activeElement).toBe(yamlBtn.element);
    w.unmount();
  });
});
