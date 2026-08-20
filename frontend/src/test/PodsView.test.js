/*
 * Tests for PodsView.vue - the pod list with its side panels.
 *
 * PodsView owns the open pod panels (logs / details / YAML). A panel is only
 * valid for the exact (context, namespace) it was opened from: switching
 * namespaces must close the panels instead of querying the same pod name in
 * the new namespace, where that pod does not exist (the "log screen stays
 * open and errors" regression).
 *
 * We cover:
 *   - Changing the namespace closes the log panel AND stops its stream
 *   - Changing the namespace never restarts the old stream for the new ns
 *   - Changing the namespace closes an open pod-detail panel
 *   - Changing the namespace closes an open pod-YAML panel
 *   - Changing the context still closes pod panels
 *   - Reconnecting to the same context restarts an open log stream
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick, defineComponent, h } from "vue";

const { listeners } = vi.hoisted(() => ({
  listeners: {},
}));

vi.mock("../api.js", () => ({
  api: {
    startLogStream: vi.fn(),
    stopLogStream: vi.fn(),
    saveLogs: vi.fn(),
    setWatchNamespace: vi.fn(),
  },
  onEvent: (name, handler) => {
    listeners[name] = handler;
    return () => {
      delete listeners[name];
    };
  },
}));

import { api } from "../api.js";
import PodsView from "../components/PodsView.vue";
import LogViewer from "../components/LogViewer.vue";
import { useStore } from "../store.js";

const { setConnection, setNamespace } = useStore();

// PodList is the only child we interact with; a tiny stub lets us emit the
// panel-opening events exactly like the real component does.
const PodListStub = defineComponent({
  name: "PodListStub",
  emits: ["view-logs", "view-details", "view-yaml", "view-network-files"],
  setup(_, { emit }) {
    return () =>
      h("div", { class: "pod-list-stub" }, [
        h(
          "button",
          {
            onClick: () => emit("view-logs", { pod: "web", container: "app" }),
          },
          "open logs",
        ),
        h(
          "button",
          { onClick: () => emit("view-details", "web") },
          "open details",
        ),
        h("button", { onClick: () => emit("view-yaml", "web") }, "open yaml"),
        h(
          "button",
          {
            onClick: () =>
              emit("view-network-files", { pod: "web", container: "app" }),
          },
          "open files",
        ),
      ]);
  },
});

const stubs = {
  PodList: PodListStub,
  PodDetail: true,
  YamlViewer: true,
  PodFilesView: true,
};

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  vi.clearAllMocks();
  api.startLogStream.mockResolvedValue("stream-1");
  api.stopLogStream.mockResolvedValue(undefined);
  api.saveLogs.mockResolvedValue(null);
});

function mountView() {
  return mount(PodsView, { attachTo: document.body, global: { stubs } });
}

// Click one of the PodList stub's panel-opening buttons by its visible label.
function openPanel(w, label) {
  const btn = w
    .findAll(".pod-list-stub button")
    .find((b) => b.text() === label);
  return btn.trigger("click");
}

describe("PodsView - pod panels close on namespace switch", () => {
  it("closes the log panel and stops its stream when the namespace changes", async () => {
    const w = mountView();
    await openPanel(w, "open logs");
    await flushPromises(); // LogViewer mounts and starts the stream

    expect(w.findComponent(LogViewer).exists()).toBe(true);
    expect(api.startLogStream).toHaveBeenCalledWith(
      "default",
      "web",
      "app",
      expect.anything(),
    );

    setNamespace("other");
    await nextTick();
    await flushPromises();

    expect(w.findComponent(LogViewer).exists()).toBe(false);
    // The old stream is torn down instead of being restarted for the new ns.
    expect(api.stopLogStream).toHaveBeenCalledWith("stream-1");
    expect(api.startLogStream).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("closes an open pod-detail panel when the namespace changes", async () => {
    const w = mountView();
    await openPanel(w, "open details");
    await nextTick();
    expect(w.find("pod-detail-stub").exists()).toBe(true);

    setNamespace("other");
    await nextTick();
    expect(w.find("pod-detail-stub").exists()).toBe(false);
    w.unmount();
  });

  it("closes an open pod-YAML panel when the namespace changes", async () => {
    const w = mountView();
    await openPanel(w, "open yaml");
    await nextTick();
    expect(w.find("yaml-viewer-stub").exists()).toBe(true);

    setNamespace("other");
    await nextTick();
    expect(w.find("yaml-viewer-stub").exists()).toBe(false);
    w.unmount();
  });

  it("opening network files closes the other panels", async () => {
    const w = mountView();
    await openPanel(w, "open details");
    await nextTick();
    expect(w.find("pod-detail-stub").exists()).toBe(true);

    await openPanel(w, "open files");
    await nextTick();
    expect(w.find("pod-files-view-stub").exists()).toBe(true);

    expect(w.find("pod-detail-stub").exists()).toBe(false);
    w.unmount();
  });

  it("still closes pod panels when the context changes", async () => {
    const w = mountView();
    await openPanel(w, "open logs");
    await flushPromises();
    expect(w.findComponent(LogViewer).exists()).toBe(true);

    setConnection({ name: "other-ctx", namespace: "kube-system" });
    await nextTick();
    await flushPromises();

    expect(w.findComponent(LogViewer).exists()).toBe(false);
    expect(api.stopLogStream).toHaveBeenCalledWith("stream-1");
    w.unmount();
  });
});

describe("PodsView - reconnect reloads open pod panels", () => {
  it("restarts an open log stream when reconnecting to the same context", async () => {
    const w = mountView();
    await openPanel(w, "open logs");
    await flushPromises(); // LogViewer mounts and starts the stream
    expect(api.startLogStream).toHaveBeenCalledTimes(1);

    setConnection({ name: "test-ctx", namespace: "default" });
    await nextTick();
    await flushPromises();

    expect(api.stopLogStream).toHaveBeenCalledWith("stream-1");
    expect(api.startLogStream).toHaveBeenCalledTimes(2);
    expect(w.findComponent(LogViewer).exists()).toBe(true);
    w.unmount();
  });
});
