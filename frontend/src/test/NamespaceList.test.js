import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import NamespaceList from "../components/NamespaceList.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { listNamespaces: vi.fn(), deleteNamespace: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

const { setConnection } = useStore();

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
    // The selected namespace carries the roving-tabindex focus target.
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
