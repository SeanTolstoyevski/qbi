/*
 * Tests for App.vue — the top-level pod panel lifecycle.
 *
 * App owns the open pod panels (logs / details / YAML). A panel is only valid
 * for the exact (context, namespace) it was opened from: switching namespaces
 * must close the panels instead of querying the same pod name in the new
 * namespace, where that pod does not exist (the "log screen stays open and
 * errors" regression).
 *
 * We cover:
 *   - Changing the namespace closes the log panel AND stops its stream
 *   - Changing the namespace never restarts the old stream for the new ns
 *   - Changing the namespace closes an open pod-detail panel
 *   - Changing the namespace closes an open pod-YAML panel
 *   - Changing the context still closes pod panels
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick, defineComponent, h } from "vue";

const { listeners, nsFocusList } = vi.hoisted(() => ({
  listeners: {},
  nsFocusList: vi.fn(),
}));

vi.mock("../api.js", () => ({
  api: {
    startLogStream: vi.fn(),
    stopLogStream: vi.fn(),
    saveLogs: vi.fn(),
    setWatchNamespace: vi.fn(),
    version: vi.fn(),
    commit: vi.fn(),
  },
  onEvent: (name, handler) => {
    listeners[name] = handler;
    return () => {
      delete listeners[name];
    };
  },
}));

import { api } from "../api.js";
import App from "../App.vue";
import LogViewer from "../components/LogViewer.vue";
import { useStore } from "../store.js";

const { setConnection, setNamespace } = useStore();

// PodList is the only child we interact with; a tiny stub lets us emit the
// panel-opening events exactly like the real component does.
const PodListStub = defineComponent({
  name: "PodListStub",
  emits: ["view-logs", "view-details", "view-yaml"],
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
      ]);
  },
});

// NamespaceList is stubbed as ready with a focusList spy so the Ctrl+E
// shortcut test can verify App asks the list to take focus.
const NamespaceListStub = defineComponent({
  name: "NamespaceListStub",
  setup() {
    return { listReady: true, focusList: nsFocusList };
  },
  render() {
    return h("div", { class: "ns-list-stub" }, "namespaces");
  },
});

// Everything else is irrelevant to these tests — stub it so App renders
// without pulling in cluster logic. LogViewer stays real so we can verify the
// stream cleanup that runs when its panel is closed.
const stubs = {
  ContextBar: true,
  NamespaceList: NamespaceListStub,
  PodList: PodListStub,
  PodDetail: true,
  SecretList: true,
  ConfigMapList: true,
  NetworkingView: true,
  EventsView: true,
  WorkloadsView: true,
  NodesView: true,
  YamlViewer: true,
  SettingsView: true,
  AboutView: true,
};

beforeAll(() => {
  // happy-dom lacks this; LogViewer relies on it while streaming.
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

function mountApp() {
  return mount(App, { attachTo: document.body, global: { stubs } });
}

// Click one of the PodList stub's panel-opening buttons by its visible label.
function openPanel(w, label) {
  const btn = w
    .findAll(".pod-list-stub button")
    .find((b) => b.text() === label);
  return btn.trigger("click");
}

describe("App — pod panels close on namespace switch", () => {
  it("closes the log panel and stops its stream when the namespace changes", async () => {
    const w = mountApp();
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
    const w = mountApp();
    await openPanel(w, "open details");
    await nextTick();
    expect(w.find("pod-detail-stub").exists()).toBe(true);

    setNamespace("other");
    await nextTick();
    expect(w.find("pod-detail-stub").exists()).toBe(false);
    w.unmount();
  });

  it("closes an open pod-YAML panel when the namespace changes", async () => {
    const w = mountApp();
    await openPanel(w, "open yaml");
    await nextTick();
    expect(w.find("yaml-viewer-stub").exists()).toBe(true);

    setNamespace("other");
    await nextTick();
    expect(w.find("yaml-viewer-stub").exists()).toBe(false);
    w.unmount();
  });

  it("still closes pod panels when the context changes", async () => {
    const w = mountApp();
    await openPanel(w, "open logs");
    await flushPromises();
    expect(w.findComponent(LogViewer).exists()).toBe(true);

    // Reconnecting to another cluster changes the context name.
    setConnection({ name: "other-ctx", namespace: "kube-system" });
    await nextTick();
    await flushPromises();

    expect(w.findComponent(LogViewer).exists()).toBe(false);
    expect(api.stopLogStream).toHaveBeenCalledWith("stream-1");
    w.unmount();
  });
});

describe("App — primary navigation", () => {
  it("renders the four top-level screens and marks the active one", () => {
    const w = mountApp();
    const nav = w.find("nav[aria-label='Primary']");
    expect(nav.exists()).toBe(true);
    // Labels are lowercase in the DOM (text-capitalize styles them visually),
    // matching the namespace sub-tab convention.
    expect(nav.findAll("button").map((b) => b.text())).toEqual([
      "cluster",
      "namespace",
      "settings",
      "about",
    ]);
    // Namespace is the default section, so it carries the current marker.
    const active = nav
      .findAll("button")
      .find((b) => b.text() === "namespace");
    expect(active.attributes("aria-current")).toBe("page");
    w.unmount();
  });

  it("switches screens on click, updates the marker and moves focus", async () => {
    const w = mountApp();
    const about = w
      .find("nav[aria-label='Primary']")
      .findAll("button")
      .find((b) => b.text() === "about");
    await about.trigger("click");
    await nextTick();

    expect(about.attributes("aria-current")).toBe("page");
    expect(w.find("#section-heading-about").isVisible()).toBe(true);
    expect(w.find("#section-heading-namespace").isVisible()).toBe(false);
    // View changes move focus to the revealed section heading.
    expect(document.activeElement).toBe(
      w.find("#section-heading-about").element,
    );
    w.unmount();
  });
});

describe("App — screen shortcuts", () => {
  it("Ctrl+1 switches to the Cluster section", async () => {
    const w = mountApp();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", ctrlKey: true }),
    );
    await nextTick();
    expect(w.find("#section-heading-cluster").isVisible()).toBe(true);
    expect(w.find("#section-heading-namespace").isVisible()).toBe(false);
    w.unmount();
  });

  it("Ctrl+4 switches to the About section", async () => {
    const w = mountApp();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "4", ctrlKey: true }),
    );
    await nextTick();
    expect(w.find("#section-heading-about").isVisible()).toBe(true);
    w.unmount();
  });

  it("ignores Ctrl+number combinations without a mapped section", async () => {
    const w = mountApp();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "9", ctrlKey: true }),
    );
    await nextTick();
    // The default section (namespace) is untouched.
    expect(w.find("#section-heading-namespace").isVisible()).toBe(true);
    w.unmount();
  });

  it("Ctrl+E asks the namespace list to take focus when it is ready", async () => {
    const w = mountApp();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "e", ctrlKey: true }),
    );
    expect(nsFocusList).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});
