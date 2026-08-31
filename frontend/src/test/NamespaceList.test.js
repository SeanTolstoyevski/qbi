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

vi.mock("bootstrap", () => {
  class FakeModal {
    constructor(el) {
      this.el = el;
    }
    show() {
      this.el.dispatchEvent(new Event("shown.bs.modal"));
    }
    hide() {
      this.el.dispatchEvent(new Event("hidden.bs.modal"));
    }
    dispose() {}
  }
  return { Modal: FakeModal };
});

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

describe("NamespaceList - selection", () => {
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

describe("NamespaceList - delete flow", () => {
  // The context menu is teleported to <body>, so the wrapper cannot find it.
  const menu = () => document.querySelector('[role="menu"]');
  // "Copy name" is now the first menuitem; target the destructive one.
  const menuItem = () =>
    [...document.querySelectorAll('[role="menuitem"]')].find((b) =>
      b.textContent.includes("Delete namespace"),
    );

  const modal = () => document.querySelector(".modal");
  const modalInput = () => document.querySelector("#ns-delete-confirm");
  const modalButton = (label) =>
    [...document.querySelectorAll(".modal-footer button")].find((b) =>
      b.textContent.includes(label),
    );

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

  async function openDeleteModal(w, ns = "default") {
    await openMenuFor(w, ns);
    menuItem().click();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(modalInput());
    });
  }

  // v-model listens for input events; setting .value + dispatching input is
  // the happy-dom equivalent of typing.
  function typePhrase(text) {
    modalInput().value = text;
    modalInput().dispatchEvent(new Event("input"));
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

  it("asks for the exact phrase in the delete modal", async () => {
    const w = await mountConnected();
    await openDeleteModal(w);
    expect(modal()).not.toBeNull();
    expect(modal().textContent).toContain("default, yes");
    w.unmount();
  });

  it("moves focus into the confirmation input when the modal opens", async () => {
    const w = await mountConnected();
    await openDeleteModal(w);
    expect(document.activeElement).toBe(modalInput());
    w.unmount();
  });

  it("deletes the namespace after typing the phrase and reloads", async () => {
    api.deleteNamespace.mockResolvedValue(true);
    const w = await mountConnected();
    api.listNamespaces.mockClear();
    await openDeleteModal(w);
    typePhrase("default, yes");
    modalButton("Delete namespace").click();
    await flushPromises();
    expect(api.deleteNamespace).toHaveBeenCalledWith("default");
    expect(api.listNamespaces).toHaveBeenCalled();
    expect(menu()).toBeNull();
    expect(modal()).toBeNull();
    w.unmount();
  });

  it("aborts the deletion when the typed phrase does not match", async () => {
    api.deleteNamespace.mockResolvedValue(true);
    const w = await mountConnected();
    await openDeleteModal(w);
    typePhrase("default, no");
    modalButton("Delete namespace").click();
    await flushPromises();
    expect(api.deleteNamespace).not.toHaveBeenCalled();
    expect(modal()).toBeNull();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(state.status).toContain("Deletion cancelled");
    expect(document.activeElement).toBe(
      document.querySelector('[role="option"][tabindex="0"]'),
    );
    w.unmount();
  });

  it("cancels the modal without deleting", async () => {
    api.deleteNamespace.mockResolvedValue(true);
    const w = await mountConnected();
    await openDeleteModal(w);
    modalButton("Cancel").click();
    await flushPromises();
    expect(api.deleteNamespace).not.toHaveBeenCalled();
    expect(modal()).toBeNull();
    w.unmount();
  });

  it("closes the modal on Escape without deleting", async () => {
    api.deleteNamespace.mockResolvedValue(true);
    const w = await mountConnected();
    await openDeleteModal(w);
    modalInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flushPromises();
    expect(api.deleteNamespace).not.toHaveBeenCalled();
    expect(modal()).toBeNull();
    w.unmount();
  });

  it("prevents pasting into the confirmation input", async () => {
    const w = await mountConnected();
    await openDeleteModal(w);
    const ev = new Event("paste", { cancelable: true });
    modalInput().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    w.unmount();
  });

  it("does not reload when the user cancels the native confirmation", async () => {
    api.deleteNamespace.mockResolvedValue(false);
    const w = await mountConnected();
    api.listNamespaces.mockClear();
    await openDeleteModal(w);
    typePhrase("default, yes");
    modalButton("Delete namespace").click();
    await flushPromises();
    expect(api.deleteNamespace).toHaveBeenCalledWith("default");
    expect(api.listNamespaces).not.toHaveBeenCalled();
    expect(modal()).toBeNull();
    w.unmount();
  });

  it("shows the error when deletion fails", async () => {
    api.deleteNamespace.mockRejectedValue(new Error("forbidden"));
    const w = await mountConnected();
    await openDeleteModal(w);
    typePhrase("default, yes");
    modalButton("Delete namespace").click();
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

    expect(document.activeElement).toBe(
      document.querySelector('[role="option"][tabindex="0"]'),
    );
    w.unmount();
  });

  it("closes the menu when clicking outside", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

describe("NamespaceList - menu keyboard navigation", () => {
  const menu = () => document.querySelector('[role="menu"]');
  const items = () =>
    [...document.querySelectorAll('[role="menuitem"]:not(:disabled)')].map(
      (b) => {
        // The visually-hidden namespace name is a11y-only; strip it.
        const clone = b.cloneNode(true);
        clone.querySelectorAll(".visually-hidden").forEach((n) => n.remove());
        return clone.textContent.trim();
      },
    );
  const key = (k, opts = {}) =>
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts }),
    );

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

  it("offers both actions and focuses the first on open", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    expect(items()).toEqual(["Copy name", "Delete namespace"]);
    expect(document.activeElement.textContent).toContain("Copy name");
    w.unmount();
  });

  it("ArrowDown moves focus to the next action", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    key("ArrowDown");
    expect(document.activeElement.textContent).toContain("Delete namespace");
    w.unmount();
  });

  it("ArrowDown wraps from the last action back to the first", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    key("ArrowDown");
    key("ArrowDown");
    expect(document.activeElement.textContent).toContain("Copy name");
    w.unmount();
  });

  it("ArrowUp moves to the previous action and wraps", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    key("ArrowUp"); // wraps: last action
    expect(document.activeElement.textContent).toContain("Delete namespace");
    key("ArrowUp");
    expect(document.activeElement.textContent).toContain("Copy name");
    w.unmount();
  });

  it("End jumps to the last action and Home back to the first", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    key("End");
    expect(document.activeElement.textContent).toContain("Delete namespace");
    key("Home");
    expect(document.activeElement.textContent).toContain("Copy name");
    w.unmount();
  });

  it("Tab closes the menu without returning focus", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    key("Tab");
    await nextTick();
    expect(menu()).toBeNull();
    w.unmount();
  });
});

describe("NamespaceList - copy", () => {
  const menu = () => document.querySelector('[role="menu"]');
  const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')];
  const copyItem = () =>
    menuItems().find((b) => b.textContent.includes("Copy name"));

  let writeText;

  beforeEach(() => {
    writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
  });

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

  it("offers Copy name in the context menu before the destructive action", async () => {
    const w = await mountConnected();
    await openMenuFor(w, "default");
    expect(copyItem()).not.toBeUndefined();
    expect(copyItem().textContent).toContain("default");
    // Initial focus lands on the safe action, not Delete.
    expect(document.activeElement).toBe(copyItem());
    w.unmount();
  });

  it("copies the namespace name from the context menu and closes it", async () => {
    writeText.mockResolvedValue(undefined);
    const w = await mountConnected();
    await openMenuFor(w, "kube-system");
    copyItem().click();
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("kube-system");
    expect(menu()).toBeNull();
    w.unmount();
  });

  it("copies the focused namespace name on Ctrl+C", async () => {
    writeText.mockResolvedValue(undefined);
    const w = await mountConnected();
    // Focus starts aligned with the selected namespace ("default").
    await w
      .find('[role="listbox"]')
      .trigger("keydown", { key: "c", ctrlKey: true });
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("default");
    w.unmount();
  });

  it("copies the option under focus after moving, not the selection", async () => {
    writeText.mockResolvedValue(undefined);
    const w = await mountConnected();
    await w.find('[role="listbox"]').trigger("keydown", { key: "ArrowDown" });
    await w
      .find('[role="listbox"]')
      .trigger("keydown", { key: "c", ctrlKey: true });
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("kube-system");
    expect(state.namespace).toBe("default"); // selection unchanged
    w.unmount();
  });
});

describe("NamespaceList - refresh button", () => {
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
