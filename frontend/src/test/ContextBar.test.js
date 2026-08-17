import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ContextBar from "../components/ContextBar.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: {
    kubeconfig: vi.fn(),
    selectKubeconfig: vi.fn(),
    listContexts: vi.fn(),
    connect: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

const { state } = useStore();

const KUBECONFIG = {
  path: "C:\\Users\\me\\.kube\\config",
  source: "default",
  exists: true,
};

const CONTEXTS = [
  { name: "prod", current: true },
  { name: "staging", current: false },
];

const rAF = () => new Promise((r) => requestAnimationFrame(r));

beforeEach(() => {
  vi.clearAllMocks();
  api.kubeconfig.mockResolvedValue(KUBECONFIG);
  api.listContexts.mockResolvedValue(CONTEXTS);
});

async function mountBar() {
  const w = mount(ContextBar, { attachTo: document.body });
  await flushPromises();
  return w;
}

describe("ContextBar - kubeconfig status", () => {
  it("shows the kubeconfig path and source label", async () => {
    const w = await mountBar();
    expect(w.text()).toContain("C:\\Users\\me\\.kube\\config");
    expect(w.text()).toContain("default (~/.kube/config)");
    w.unmount();
  });

  it("loads contexts automatically when the kubeconfig exists and preselects the current one", async () => {
    const w = await mountBar();
    expect(api.listContexts).toHaveBeenCalledTimes(1);
    const select = w.find("#context-select");
    expect(select.element.value).toBe("prod");
    const labels = w.findAll("#context-select option").map((o) => o.text());
    expect(labels).toContain("prod (current)");
    expect(labels).toContain("staging");
    w.unmount();
  });

  it("shows the unreadable state on mount without a form", async () => {
    api.kubeconfig.mockResolvedValue({
      path: "C:\\missing.yml",
      source: "explicit",
      exists: false,
    });
    const w = await mountBar();
    expect(w.text()).toContain("not found");
    expect(w.text()).toContain("No readable kubeconfig yet");
    expect(w.find("#context-select").exists()).toBe(false);
    expect(api.listContexts).not.toHaveBeenCalled();
    w.unmount();
  });

  it("shows no contexts found and disables the connect button", async () => {
    api.listContexts.mockResolvedValue([]);
    const w = await mountBar();
    expect(w.text()).toContain("No contexts found");
    expect(
      w.find('button[type="submit"]').attributes("disabled"),
    ).toBeDefined();
    w.unmount();
  });

  it("disables the select and shows the spinner while contexts load", async () => {
    let resolve;
    api.listContexts.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const w = mount(ContextBar, { attachTo: document.body });
    await flushPromises();
    const select = w.find("#context-select");
    expect(select.attributes("disabled")).toBeDefined();
    expect(
      w.find('button[type="submit"]').attributes("disabled"),
    ).toBeDefined();
    expect(w.find(".spinner-border").exists()).toBe(true);
    resolve(CONTEXTS);
    await flushPromises();
    expect(select.attributes("disabled")).toBeUndefined();
    w.unmount();
  });
});

describe("ContextBar - picking a kubeconfig file", () => {
  it("reloads contexts when the picked file is readable", async () => {
    api.selectKubeconfig.mockResolvedValue({
      path: "C:\\new.yml",
      source: "explicit",
      exists: true,
    });
    const w = await mountBar();
    const openBtn = w
      .findAll("button")
      .find((b) => b.text().includes("Open kubeconfig file"));
    await openBtn.trigger("click");
    await flushPromises();
    expect(api.selectKubeconfig).toHaveBeenCalledTimes(1);
    expect(api.listContexts).toHaveBeenCalledTimes(2);
    expect(w.find("#context-select").element.value).toBe("prod");
    w.unmount();
  });

  it("announces and hides the form when the picked file cannot be read", async () => {
    api.selectKubeconfig.mockResolvedValue({
      path: "C:\\broken.yml",
      source: "explicit",
      exists: false,
    });
    const w = await mountBar();
    expect(w.find("#context-select").exists()).toBe(true);
    const openBtn = w
      .findAll("button")
      .find((b) => b.text().includes("Open kubeconfig file"));
    await openBtn.trigger("click");
    await flushPromises();
    await rAF();
    expect(w.find("#context-select").exists()).toBe(false);
    expect(w.text()).toContain("No readable kubeconfig yet");
    expect(state.status).toContain("could not be read");
    w.unmount();
  });

  it("shows the error when kubeconfig selection fails", async () => {
    api.selectKubeconfig.mockRejectedValue(new Error("picker exploded"));
    const w = await mountBar();
    const openBtn = w
      .findAll("button")
      .find((b) => b.text().includes("Open kubeconfig file"));
    await openBtn.trigger("click");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("picker exploded");
    w.unmount();
  });
});

describe("ContextBar - refresh and connect", () => {
  it("reloads the context list via the refresh button", async () => {
    const w = await mountBar();
    await w
      .findAll("button")
      .find((b) => b.text() === "Refresh contexts")
      .trigger("click");
    await flushPromises();
    expect(api.listContexts).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it("does not connect without a selected context", async () => {
    api.listContexts.mockResolvedValue([]);
    const w = await mountBar();
    await w.find("form").trigger("submit");
    expect(api.connect).not.toHaveBeenCalled();
    w.unmount();
  });

  it("shows the error when connecting fails", async () => {
    api.connect.mockRejectedValue(new Error("unauthorized"));
    const w = await mountBar();
    await w.find('button[type="submit"]').trigger("click");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("unauthorized");
    expect(state.connected).toBe(false);
    w.unmount();
  });

  it("connects with the selected context, announces and flips the button to Reconnect", async () => {
    api.connect.mockResolvedValue({ name: "staging" });
    const w = await mountBar();
    await w.find("#context-select").setValue("staging");
    await w.find('button[type="submit"]').trigger("click");
    await flushPromises();
    await rAF();
    expect(api.connect).toHaveBeenCalledWith("staging");
    expect(state.connected).toBe(true);
    expect(state.context).toEqual({ name: "staging" });
    expect(w.text()).toContain("Connected to staging");
    expect(w.text()).toContain("Reconnect");
    expect(state.status).toContain("Connected to staging");
    w.unmount();
  });

  it("tears down a previous connection when a reconnect fails", async () => {
    localStorage.setItem(
      "qba.lastNamespace",
      JSON.stringify({ staging: "dev" }),
    );
    try {
      const w = await mountBar();
      api.connect.mockResolvedValue({ name: "staging" });
      await w.find("#context-select").setValue("staging");
      await w.find('button[type="submit"]').trigger("click");
      await flushPromises();
      expect(state.connected).toBe(true);
      expect(state.namespace).toBe("dev");

      // The cluster goes away (e.g. Wi-Fi drops) and the reconnect fails:
      // nothing may stay clickable on the dead connection.
      api.connect.mockRejectedValue(new Error("dial tcp: no route to host"));
      await w.find('button[type="submit"]').trigger("click");
      await flushPromises();
      expect(w.find('[role="alert"]').text()).toContain("dial tcp");
      expect(state.connected).toBe(false);
      expect(state.context).toBeNull();
      expect(state.namespace).toBeNull();
      expect(w.text()).not.toContain("Connected to staging");
      w.unmount();
    } finally {
      localStorage.removeItem("qba.lastNamespace");
    }
  });
});
