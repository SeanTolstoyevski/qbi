/*
 * Tests for App.vue — primary navigation and global keyboard shortcuts.
 *
 * App is the top-level shell: header, sidebar, primary nav tabs (Cluster /
 * Namespace / Settings / About), and the global keyboard shortcut layer.
 * Pod panel lifecycle tests live in PodsView.test.js.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick, defineComponent, h } from "vue";

const { nsFocusList } = vi.hoisted(() => ({
  nsFocusList: vi.fn(),
}));

vi.mock("../api.js", () => ({
  api: {
    setWatchNamespace: vi.fn(),
    version: vi.fn(),
    commit: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

import App from "../App.vue";
import { useStore } from "../store.js";

const { setConnection, setNamespace } = useStore();

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

// Every tab-panel child is stubbed — App only tests its own shell behaviour.
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
});

function mountApp() {
  return mount(App, { attachTo: document.body, global: { stubs } });
}

describe("App — primary navigation", () => {
  it("renders the four top-level screens and marks the active one", () => {
    const w = mountApp();
    const nav = w.find("nav.header-nav");
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
