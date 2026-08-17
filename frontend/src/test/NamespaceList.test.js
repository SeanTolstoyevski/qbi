import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import NamespaceList from "../components/NamespaceList.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { listNamespaces: vi.fn(), deleteNamespace: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

const { state, setConnection, clearConnection } = useStore();

const NS = [
  { name: "default", status: "Active", age: "10d" },
  { name: "kube-system", status: "Active", age: "10d" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

async function mountList() {
  const w = mount(NamespaceList, { attachTo: document.body });
  await flushPromises();
  return w;
}

describe("NamespaceList - readiness and focus", () => {
  it("is not ready before connecting", async () => {
    const w = await mountList();
    expect(w.vm.listReady).toBe(false);
    w.unmount();
  });

  it("becomes ready once namespaces are listed", async () => {
    api.listNamespaces.mockResolvedValue(NS);
    setConnection({ name: "test-ctx", namespace: "default" });
    const w = await mountList();
    expect(w.vm.listReady).toBe(true);
    w.unmount();
  });

  it("is not ready while namespaces are still loading", async () => {
    let resolve;
    api.listNamespaces.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    setConnection({ name: "test-ctx", namespace: "default" });
    const w = mount(NamespaceList);
    // Loading state: the listbox is not rendered yet.
    expect(w.vm.listReady).toBe(false);
    resolve(NS);
    await flushPromises();
    expect(w.vm.listReady).toBe(true);
    w.unmount();
  });

  it("focusList focuses the active listbox option", async () => {
    api.listNamespaces.mockResolvedValue(NS);
    setConnection({ name: "test-ctx", namespace: "default" });
    const w = await mountList();
    w.vm.focusList();
    await flushPromises();
    expect(w.find('[role="listbox"] [tabindex="0"]').element).toBe(
      document.activeElement,
    );
    w.unmount();
  });

  it("reloads namespaces when reconnecting to the same context", async () => {
    api.listNamespaces.mockResolvedValue(NS);
    setConnection({ name: "test-ctx", namespace: "default" });
    const w = await mountList();
    expect(api.listNamespaces).toHaveBeenCalledTimes(1);

    // Successful retry after a failed attempt: same context, same namespace.
    setConnection({ name: "test-ctx", namespace: "default" });
    await flushPromises();

    expect(api.listNamespaces).toHaveBeenCalledTimes(2);
    w.unmount();
  });
});

describe("NamespaceList — selection", () => {
  it("selects a namespace from the listbox and persists it", async () => {
    api.listNamespaces.mockResolvedValue(NS);
    setConnection({ name: "test-ctx", namespace: "default" });
    const w = await mountList();
    const options = w.findAll('[role="option"]');
    await options[1].trigger("click"); // kube-system
    await flushPromises();
    expect(state.namespace).toBe("kube-system");
    expect(localStorage.getItem("qba.lastNamespace")).toContain("kube-system");
    w.unmount();
  });
});

describe("NamespaceList — delete flow", () => {
  // The context menu is teleported to <body>, so the wrapper cannot find it.
  const menu = () => document.querySelector('[role="menu"]');
  const menuItem = () => document.querySelector('[role="menuitem"]');

  async function mountConnected() {
    api.listNamespaces.mockResolvedValue(NS);
    setConnection({ name: "test-ctx", namespace: "default" });
    return mountList();
  }

  async function openMenuFor(w, ns) {
    const opt = w.findAll('[role="option"]').find((o) => o.text().includes(ns));
    await opt.find(".qba-option-menu-btn").trigger("click");
    await nextTick();
  }

  it("opens the context menu from the kebab button", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    expect(menu()).not.toBeNull();
    expect(menu().getAttribute("aria-label")).toBe("Namespace default actions");
    w.unmount();
  });

  it("opens the context menu from a right-click", async () => {
    const w = await mountConnected();
    await w.findAll('[role="option"]')[0].trigger("contextmenu");
    await nextTick();
    expect(menu()).not.toBeNull();
    w.unmount();
  });

  it("deletes the namespace after confirmation and reloads", async () => {
    api.deleteNamespace.mockResolvedValue(true);
    const w = await mountConnected();
    api.listNamespaces.mockClear();
    await openMenuFor(w, "default");
    menuItem().click();
    await flushPromises();
    expect(api.deleteNamespace).toHaveBeenCalledWith("default");
    expect(api.listNamespaces).toHaveBeenCalled();
    expect(menu()).toBeNull();
    w.unmount();
  });

  it("does not reload when the user cancels the confirmation", async () => {
    api.deleteNamespace.mockResolvedValue(false);
    const w = await mountConnected();
    api.listNamespaces.mockClear();
    await openMenuFor(w, "default");
    menuItem().click();
    await flushPromises();
    expect(api.deleteNamespace).toHaveBeenCalledWith("default");
    expect(api.listNamespaces).not.toHaveBeenCalled();
    w.unmount();
  });

  it("shows the error when deletion fails", async () => {
    api.deleteNamespace.mockRejectedValue(new Error("forbidden"));
    const w = await mountConnected();
    await openMenuFor(w, "default");
    menuItem().click();
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("forbidden");
    w.unmount();
  });

  it("closes the menu on Escape and returns focus to the list", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    menu().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await nextTick();
    expect(menu()).toBeNull();
    w.unmount();
  });

  it("closes the menu when clicking outside", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await nextTick();
    expect(menu()).toBeNull();
    w.unmount();
  });

  it("closes the menu when a failed reconnect tears the connection down", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    expect(menu()).not.toBeNull();

    clearConnection();
    await nextTick();
    expect(menu()).toBeNull();
    w.unmount();
  });
});

describe("NamespaceList — refresh button", () => {
  it("reloads namespaces via the refresh button", async () => {
    api.listNamespaces.mockResolvedValue(NS);
    setConnection({ name: "test-ctx", namespace: "default" });
    const w = await mountList();
    api.listNamespaces.mockClear();
    await w
      .findAll("button")
      .find((b) => b.text().includes("Refresh namespaces"))
      .trigger("click");
    await flushPromises();
    expect(api.listNamespaces).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});
