import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick, defineComponent, h } from "vue";

const { nsFocusList } = vi.hoisted(() => ({
  nsFocusList: vi.fn(),
}));

vi.mock("../api.js", () => ({
  api: {
    setWatchNamespace: vi.fn(),
    buildInfo: vi.fn(),
    getSettings: vi.fn(),
    acknowledgeWelcome: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

import App from "../App.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

const { setConnection, setNamespace } = useStore();

const NamespaceListStub = defineComponent({
  name: "NamespaceListStub",
  setup() {
    return { listReady: true, focusList: nsFocusList };
  },
  render() {
    return h("div", { class: "ns-list-stub" }, "namespaces");
  },
});

const stubs = {
  ContextBar: true,
  NamespaceList: NamespaceListStub,
  PodsView: true,
  SecretList: true,
  ConfigMapList: true,
  NetworkingView: true,
  EventsView: true,
  WorkloadsView: true,
  NodesView: true,
  SettingsView: true,
  AboutView: true,
};

beforeEach(() => {
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ autoRefresh: false, welcomeSeen: true });
  api.acknowledgeWelcome.mockResolvedValue();
});

function mountApp() {
  return mount(App, { attachTo: document.body, global: { stubs } });
}

describe("App - primary navigation", () => {
  it("renders the four top-level screens and marks the active one", () => {
    const w = mountApp();
    const nav = w.find("nav.header-nav");
    expect(nav.exists()).toBe(true);

    expect(nav.findAll("button").map((b) => b.text())).toEqual([
      "cluster",
      "namespace",
      "settings",
      "about",
    ]);

    const active = nav.findAll("button").find((b) => b.text() === "namespace");
    expect(active.attributes("aria-current")).toBe("page");
    w.unmount();
  });

  it("switches screens on click, updates the marker and moves focus", async () => {
    const w = mountApp();
    const about = w
      .find("nav.header-nav")
      .findAll("button")
      .find((b) => b.text() === "about");
    await about.trigger("click");
    await nextTick();

    expect(about.attributes("aria-current")).toBe("page");
    expect(w.find("#section-heading-about").isVisible()).toBe(true);
    expect(w.find("#section-heading-namespace").isVisible()).toBe(false);

    expect(document.activeElement).toBe(
      w.find("#section-heading-about").element,
    );
    w.unmount();
  });
});

describe("App - screen shortcuts", () => {
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

describe("App - welcome wizard", () => {
  function wizardButton(w, text) {
    return w.findAll("button").find((b) => b.text() === text);
  }

  async function completeWizard(w) {
    await wizardButton(w, "Next").trigger("click");
    await wizardButton(w, "Next").trigger("click");
    await w.find("#welcome-acknowledge").setValue(true);
    await wizardButton(w, "Get started").trigger("click");
    await flushPromises();
  }

  it("shows the wizard on first launch and makes the app behind it inert", async () => {
    api.getSettings.mockResolvedValue({
      autoRefresh: false,
      welcomeSeen: false,
    });
    const w = mountApp();
    await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(true);

    expect(w.find(".app-root").attributes("inert")).toBeDefined();
    expect(w.find(".app-root").attributes("aria-hidden")).toBe("true");
    w.unmount();
  });

  it("completing the wizard persists the acknowledgment and reveals the app", async () => {
    api.getSettings.mockResolvedValue({
      autoRefresh: false,
      welcomeSeen: false,
    });
    const w = mountApp();
    await flushPromises();
    await completeWizard(w);

    expect(api.acknowledgeWelcome).toHaveBeenCalledTimes(1);
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    expect(w.find(".app-root").attributes("inert")).toBeUndefined();

    expect(document.activeElement).toBe(
      w.find("#section-heading-namespace").element,
    );
    w.unmount();
  });

  it("dismissing hides the wizard for this session without persisting", async () => {
    api.getSettings.mockResolvedValue({
      autoRefresh: false,
      welcomeSeen: false,
    });
    const w = mountApp();
    await flushPromises();
    await w.find(".btn-close").trigger("click");
    await flushPromises();

    expect(w.find('[role="dialog"]').exists()).toBe(false);
    expect(api.acknowledgeWelcome).not.toHaveBeenCalled();
    expect(w.find(".app-root").attributes("inert")).toBeUndefined();
    w.unmount();
  });

  it("keeps the wizard open and shows the error when saving the acknowledgment fails", async () => {
    api.getSettings.mockResolvedValue({
      autoRefresh: false,
      welcomeSeen: false,
    });
    api.acknowledgeWelcome.mockRejectedValue(new Error("save failed"));
    const w = mountApp();
    await flushPromises();
    await completeWizard(w);

    expect(w.find('[role="dialog"]').exists()).toBe(true);
    expect(w.find('[role="alert"]').text()).toContain("save failed");
    w.unmount();
  });

  it("does not show the wizard after it has been acknowledged", async () => {
    api.getSettings.mockResolvedValue({
      autoRefresh: false,
      welcomeSeen: true,
    });
    const w = mountApp();
    await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    w.unmount();
  });

  it("shows the wizard when settings cannot be read", async () => {
    api.getSettings.mockRejectedValue(new Error("bindings unavailable"));
    const w = mountApp();
    await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(true);
    w.unmount();
  });

  it("ignores global screen shortcuts while the wizard is open", async () => {
    api.getSettings.mockResolvedValue({
      autoRefresh: false,
      welcomeSeen: false,
    });
    const w = mountApp();
    await flushPromises();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", ctrlKey: true }),
    );
    await nextTick();

    expect(w.find("#section-heading-cluster").isVisible()).toBe(false);
    expect(w.find("#section-heading-namespace").isVisible()).toBe(true);
    expect(w.find('[role="dialog"]').exists()).toBe(true);
    w.unmount();
  });
});
