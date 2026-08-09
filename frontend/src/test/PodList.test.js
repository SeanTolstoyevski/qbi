/*
 * Tests for PodList.vue
 *
 * PodList is the most action-dense component: it renders pods, emits events
 * to open detail/logs/YAML panels, and calls api.deletePod. We mock api.js
 * entirely so tests run without a Kubernetes cluster.
 *
 * We test:
 *   - Renders pods returned by api.listPods
 *   - Shows loading and error states
 *   - "Details", "YAML", "Logs" buttons emit the correct events
 *   - Delete button calls api.deletePod and reloads on success
 *   - Delete button shows a spinner and is disabled while in-flight
 *   - Cancel (api.deletePod returns false) does not reload
 *   - Owner column shows controller name or "—" for bare pods
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";

// Mock api.js BEFORE importing anything that depends on it.
vi.mock("../api.js", () => ({
  api: {
    listPods: vi.fn(),
    deletePod: vi.fn(),
  },
  // PodList subscribes to "watch:pods" on mount; provide a no-op subscriber.
  onEvent: vi.fn(() => () => {}),
}));

import { api } from "../api.js";
import PodList from "../components/PodList.vue";
// Import the store singleton that the component also uses — same module instance.
import { useStore } from "../store.js";

const { setConnection, setNamespace } = useStore();

beforeAll(() => {
  // The copy-pod-name action writes to the clipboard.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

// Seed the store with a connected + namespace state before every test.
beforeEach(() => {
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");
});

const PODS = [
  {
    name: "web-abc12",
    namespace: "default",
    phase: "Running",
    ready: "1/1",
    restarts: 0,
    age: "2d",
    node: "node-1",
    owner: "ReplicaSet/web-7f9b",
    containers: ["web"],
  },
  {
    name: "bare-pod",
    namespace: "default",
    phase: "Running",
    ready: "1/1",
    restarts: 3,
    age: "5m",
    node: "node-1",
    owner: "",
    containers: ["app"],
  },
];

// Multi-container pod: opening logs/shell reveals an inline container chooser.
const MULTI_POD = {
  name: "multi",
  namespace: "default",
  phase: "Running",
  ready: "2/2",
  restarts: 0,
  age: "1h",
  node: "node-1",
  owner: "",
  containers: ["app", "sidecar"],
};

// Helper: mount with pods loaded.
async function mountPodList() {
  api.listPods.mockResolvedValue(PODS);
  const wrapper = mount(PodList, { attachTo: document.body });
  await nextTick();
  await nextTick();
  return wrapper;
}

// Button text includes visually-hidden spans ("Details for pod web-abc12"),
// so use `includes` to find by visible label.
function findBtn(wrapper, label) {
  return wrapper.findAll("button").find((b) => b.text().includes(label));
}

// Actions live behind an "Actions" dropdown button; open it before clicking a
// menu item. PodList only renders the menu for the pod whose button was clicked.
async function openActions(wrapper) {
  await findBtn(wrapper, "Actions").trigger("click");
  await nextTick();
}

describe("PodList — rendering", () => {
  it("shows a row for every pod returned by the API", async () => {
    const w = await mountPodList();
    const rows = w.findAll("tbody tr");
    expect(rows.length).toBeGreaterThanOrEqual(PODS.length);
    w.unmount();
  });

  it("displays pod name, phase badge and owner", async () => {
    const w = await mountPodList();
    const text = w.text();
    expect(text).toContain("web-abc12");
    expect(text).toContain("Running");
    expect(text).toContain("ReplicaSet/web-7f9b");
    w.unmount();
  });

  it("shows '—' in the Owner column for bare pods", async () => {
    const w = await mountPodList();
    const cells = w.findAll("td");
    const ownerCells = cells.filter((c) => c.text() === "—");
    expect(ownerCells.length).toBeGreaterThanOrEqual(1);
    w.unmount();
  });

  it("shows loading text while fetching", async () => {
    api.listPods.mockReturnValue(new Promise(() => {})); // never resolves
    const w = mount(PodList);
    await nextTick();
    expect(w.text()).toContain("Loading");
    w.unmount();
  });

  it("shows error text when the API rejects", async () => {
    api.listPods.mockRejectedValue(new Error("unauthorized"));
    const w = mount(PodList);
    await nextTick();
    await nextTick();
    expect(w.text()).toContain("unauthorized");
    w.unmount();
  });
});

describe("PodList — action buttons", () => {
  it("clicking Details emits view-details with the pod name", async () => {
    const w = await mountPodList();
    await openActions(w);
    await findBtn(w, "Details").trigger("click");
    await flushPromises(); // the emit is deferred to a nextTick via focusTriggerAndAct
    expect(w.emitted("view-details")).toEqual([["web-abc12"]]);
    w.unmount();
  });

  it("clicking YAML emits view-yaml with the pod name", async () => {
    const w = await mountPodList();
    await openActions(w);
    await findBtn(w, "YAML").trigger("click");
    await flushPromises();
    expect(w.emitted("view-yaml")).toEqual([["web-abc12"]]);
    w.unmount();
  });

  it("clicking Logs emits view-logs for a single-container pod", async () => {
    const w = await mountPodList();
    await openActions(w);
    await findBtn(w, "Logs").trigger("click");
    await flushPromises();
    expect(w.emitted("view-logs")).toEqual([
      [{ pod: "web-abc12", container: "web" }],
    ]);
    w.unmount();
  });
});

describe("PodList — delete pod", () => {
  it("calls api.deletePod with the correct namespace and pod name", async () => {
    api.deletePod.mockResolvedValue(true);
    const w = await mountPodList();
    await openActions(w);
    await findBtn(w, "Delete").trigger("click");
    await flushPromises();
    expect(api.deletePod).toHaveBeenCalledWith("default", "web-abc12");
    w.unmount();
  });

  it("reloads the pod list after a successful delete", async () => {
    api.deletePod.mockResolvedValue(true);
    const w = await mountPodList();
    api.listPods.mockClear();
    api.listPods.mockResolvedValue(PODS);
    await openActions(w);
    await findBtn(w, "Delete").trigger("click");
    await flushPromises();
    expect(api.listPods).toHaveBeenCalledOnce();
    w.unmount();
  });

  it("does NOT reload when the user cancels the confirm dialog (returns false)", async () => {
    api.deletePod.mockResolvedValue(false);
    const w = await mountPodList();
    api.listPods.mockClear();
    await openActions(w);
    await findBtn(w, "Delete").trigger("click");
    await flushPromises();
    expect(api.listPods).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe("PodList — filter and copy", () => {
  it("filters pods by name", async () => {
    const w = await mountPodList();
    await w.find("#pod-filter").setValue("bare-pod");
    const rows = w.findAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(w.text()).toContain("bare-pod");
    w.unmount();
  });

  it("filters pods by owner", async () => {
    const w = await mountPodList();
    await w.find("#pod-filter").setValue("ReplicaSet");
    expect(w.findAll("tbody tr")).toHaveLength(1);
    w.unmount();
  });

  it("shows a no-match message when nothing matches", async () => {
    const w = await mountPodList();
    await w.find("#pod-filter").setValue("zzz-none");
    expect(w.text()).toContain("No pods match");
    w.unmount();
  });

  it("copy button copies the pod name", async () => {
    const w = await mountPodList();
    const btn = w
      .findAll("button")
      .find((b) => b.attributes("aria-label")?.includes("Copy pod name"));
    await btn.trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("web-abc12");
    w.unmount();
  });
});

describe("PodList — namespace switch", () => {
  // Per-pod UI (container choosers, action menus) names pods that no longer
  // exist once the namespace changes, so it must close instead of pointing at
  // stale rows from the previous namespace.
  it("closes an open log container chooser when the namespace changes", async () => {
    api.listPods.mockResolvedValue([MULTI_POD]);
    const w = mount(PodList, { attachTo: document.body });
    await nextTick();
    await nextTick();
    await openActions(w);
    await findBtn(w, "Logs…").trigger("click");
    await nextTick();
    await nextTick();
    expect(w.find('[data-container-group="multi"]').exists()).toBe(true);

    setNamespace("other");
    await nextTick();
    await nextTick();
    expect(w.find('[data-container-group="multi"]').exists()).toBe(false);
    w.unmount();
  });

  it("closes an open shell container chooser when the namespace changes", async () => {
    api.listPods.mockResolvedValue([MULTI_POD]);
    const w = mount(PodList, { attachTo: document.body });
    await nextTick();
    await nextTick();
    await openActions(w);
    await findBtn(w, "Shell…").trigger("click");
    await nextTick();
    await nextTick();
    expect(w.find('[data-shell-group="multi"]').exists()).toBe(true);

    setNamespace("other");
    await nextTick();
    await nextTick();
    expect(w.find('[data-shell-group="multi"]').exists()).toBe(false);
    w.unmount();
  });

  it("closes an open action menu when the namespace changes", async () => {
    const w = await mountPodList();
    await openActions(w);
    expect(w.find('[role="menu"]').exists()).toBe(true);

    setNamespace("other");
    await nextTick();
    await nextTick();
    expect(w.find('[role="menu"]').exists()).toBe(false);
    w.unmount();
  });
});

describe("PodList — reload after reconnect", () => {
  it("reloads pods when reconnecting to the same context", async () => {
    api.listPods.mockClear();
    const w = await mountPodList();
    expect(api.listPods).toHaveBeenCalledTimes(1);

    // Successful retry after a failed attempt: same context, same namespace.
    setConnection({ name: "test-ctx", namespace: "default" });
    await nextTick();
    await nextTick();

    expect(api.listPods).toHaveBeenCalledTimes(2);
    w.unmount();
  });
});
