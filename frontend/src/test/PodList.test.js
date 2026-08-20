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
 *   - Owner column shows controller name or "-" for bare pods
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
// Import the store singleton that the component also uses - same module instance.
import { useStore } from "../store.js";

const { setConnection, setNamespace, setExperimental } = useStore();

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

beforeEach(() => {
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");
  setExperimental(false);
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

describe("PodList - rendering", () => {
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

  it("shows '-' in the Owner column for bare pods", async () => {
    const w = await mountPodList();
    const cells = w.findAll("td");
    const ownerCells = cells.filter((c) => c.text() === "-");
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

describe("PodList - action buttons", () => {
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

describe("PodList - delete pod", () => {
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

describe("PodList - filter and copy", () => {
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
      .find((b) => b.classes().includes("copy-inline"));
    await btn.trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("web-abc12");
    w.unmount();
  });
});

describe("PodList - namespace switch", () => {
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

describe("PodList - reload after reconnect", () => {
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

describe("PodList - refresh button", () => {
  it("reloads pods via the refresh button", async () => {
    const w = await mountPodList();
    api.listPods.mockClear();
    await findBtn(w, "Refresh pods").trigger("click");
    await nextTick();
    await nextTick();
    expect(api.listPods).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});

describe("PodList - network files (experimental submenu)", () => {
  // Experimental actions live behind the "Experimental" submenu so the main
  // Actions menu does not swell. Open it before clicking a submenu item.
  async function openExperimental(w) {
    await findBtn(w, "Experimental").trigger("click");
    await nextTick();
    await nextTick();
  }

  it("hides the Experimental submenu while the flag is off", async () => {
    const w = await mountPodList();
    await openActions(w);
    expect(findBtn(w, "Experimental")).toBeUndefined();
    expect(findBtn(w, "Network files")).toBeUndefined();
    w.unmount();
  });

  it("emits view-network-files for a single-container pod when the flag is on", async () => {
    setExperimental(true);
    const w = await mountPodList();
    await openActions(w);
    await openExperimental(w);
    await findBtn(w, "Network files").trigger("click");
    await flushPromises();
    expect(w.emitted("view-network-files")).toEqual([
      [{ pod: "web-abc12", container: "web" }],
    ]);
    w.unmount();
  });

  it("reveals a container chooser for multi-container pods", async () => {
    setExperimental(true);
    api.listPods.mockResolvedValue([MULTI_POD]);
    const w = mount(PodList, { attachTo: document.body });
    await nextTick();
    await nextTick();
    await openActions(w);
    await openExperimental(w);
    await findBtn(w, "Network files…").trigger("click");
    await nextTick();
    await nextTick();
    expect(w.find('[data-network-group="multi"]').exists()).toBe(true);

    await w.find('[data-network-group="multi"] button').trigger("click");
    await flushPromises();
    expect(w.emitted("view-network-files")).toEqual([
      [{ pod: "multi", container: "app" }],
    ]);
    w.unmount();
  });

  it("opens the submenu on ArrowRight and folds it on ArrowLeft", async () => {
    setExperimental(true);
    const w = await mountPodList();
    await openActions(w);
    const trigger = findBtn(w, "Experimental");
    expect(trigger.attributes("aria-haspopup")).toBe("menu");

    await trigger.trigger("keydown", { key: "ArrowRight" });
    await nextTick();
    await nextTick();
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(w.find('[role="menu"] [role="menu"]').exists()).toBe(true);
    // Focus lands on the first submenu item.
    expect(document.activeElement?.textContent).toContain("Network files");

    await document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await nextTick();
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger.element);
    w.unmount();
  });

  it("folds the submenu and returns focus to the trigger on Escape", async () => {
    setExperimental(true);
    const w = await mountPodList();
    await openActions(w);
    await openExperimental(w);
    expect(findBtn(w, "Experimental").attributes("aria-expanded")).toBe(
      "true",
    );

    await document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await nextTick();
    const trigger = findBtn(w, "Experimental");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger.element);
    expect(w.find('[role="menu"]').exists()).toBe(true); // menu itself stays open
    w.unmount();
  });

  it("closes the whole menu when Tab leaves the submenu", async () => {
    setExperimental(true);
    const w = await mountPodList();
    await openActions(w);
    await openExperimental(w);
    expect(w.find('[role="menu"]').exists()).toBe(true);

    await document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    await nextTick();
    expect(w.find('[role="menu"]').exists()).toBe(false);
    w.unmount();
  });

  it("folds the submenu before roving focus moves to a parent item", async () => {
    setExperimental(true);
    const w = await mountPodList();
    await openActions(w);
    await openExperimental(w);
    const trigger = findBtn(w, "Experimental");
    // Put focus on the trigger while the submenu is open (defensive state).
    trigger.element.focus();
    expect(trigger.attributes("aria-expanded")).toBe("true");

    await trigger.trigger("keydown", { key: "ArrowUp" });
    await nextTick();
    // The submenu folded and focus roved to the previous parent item.
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(document.activeElement?.textContent).toContain("Shell");
    w.unmount();
  });

  it("re-enters the open submenu on ArrowRight instead of closing it", async () => {
    setExperimental(true);
    const w = await mountPodList();
    await openActions(w);
    await openExperimental(w);
    const trigger = findBtn(w, "Experimental");
    trigger.element.focus(); // focus on the trigger while the submenu is open

    await trigger.trigger("keydown", { key: "ArrowRight" });
    await nextTick();
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toContain("Network files");
    w.unmount();
  });

  it("folds the submenu when the experimental flag is switched off", async () => {
    setExperimental(true);
    const w = await mountPodList();
    await openActions(w);
    await openExperimental(w);
    expect(findBtn(w, "Experimental").attributes("aria-expanded")).toBe(
      "true",
    );

    setExperimental(false);
    await nextTick();
    expect(findBtn(w, "Experimental")).toBeUndefined();

    // Re-enabling must not resurrect the stale open state.
    setExperimental(true);
    await nextTick();
    const trigger = findBtn(w, "Experimental");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    w.unmount();
  });

  it("closes the submenu and its container chooser when the namespace changes", async () => {
    setExperimental(true);
    api.listPods.mockResolvedValue([MULTI_POD]);
    const w = mount(PodList, { attachTo: document.body });
    await nextTick();
    await nextTick();
    await openActions(w);
    await openExperimental(w);
    expect(findBtn(w, "Experimental").attributes("aria-expanded")).toBe(
      "true",
    );

    await findBtn(w, "Network files…").trigger("click");
    await nextTick();
    await nextTick();
    expect(w.find('[data-network-group="multi"]').exists()).toBe(true);
    expect(w.find('[role="menu"]').exists()).toBe(false);

    setNamespace("other");
    await nextTick();
    await nextTick();
    expect(w.find('[data-network-group="multi"]').exists()).toBe(false);
    w.unmount();
  });
});
