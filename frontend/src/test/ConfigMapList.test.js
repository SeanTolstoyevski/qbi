import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ConfigMapList from "../components/ConfigMapList.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { listConfigMaps: vi.fn(), getConfigMap: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

const { setConnection, setNamespace } = useStore();

const CONFIGMAPS = [
  { name: "app-config", keys: ["app.properties", "config.json"], age: "2d" },
  { name: "logging", keys: ["log.conf"], age: "5h" },
];

const DETAIL = {
  name: "app-config",
  entries: [
    { key: "app.properties", value: "debug=true\nport=8080", isBinary: false },
    { key: "logo.bin", value: "\u0001\u0002\u0003", isBinary: true },
  ],
};

beforeEach(() => {
  localStorage.clear();
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");
  vi.clearAllMocks();
  api.listConfigMaps.mockResolvedValue(CONFIGMAPS);
  api.getConfigMap.mockResolvedValue(DETAIL);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue() },
    configurable: true,
  });
});

async function mountList() {
  const w = mount(ConfigMapList, { attachTo: document.body });
  await flushPromises();
  return w;
}

function option(w, name) {
  return w.findAll('[role="option"]').find((o) => o.text().includes(name));
}

describe("ConfigMapList - list rendering", () => {
  it("renders every config map as a listbox option with key count and age", async () => {
    const w = await mountList();
    expect(w.findAll('[role="option"]')).toHaveLength(2);
    expect(w.text()).toContain("2 keys · 2d");
    expect(w.text()).toContain("1 keys · 5h");
    w.unmount();
  });

  it("filters options by name and shows a no-match message", async () => {
    const w = await mountList();
    await w.find("#cm-filter").setValue("logging");
    expect(w.findAll('[role="option"]')).toHaveLength(1);
    await w.find("#cm-filter").setValue("nope");
    expect(w.findAll('[role="option"]')).toHaveLength(0);
    expect(w.text()).toContain("No config maps match");
    w.unmount();
  });

  it("shows an honest empty state", async () => {
    api.listConfigMaps.mockResolvedValue([]);
    const w = await mountList();
    expect(w.text()).toContain("No config maps found.");
    w.unmount();
  });

  it("shows the error when listing fails", async () => {
    api.listConfigMaps.mockRejectedValue(new Error("forbidden"));
    const w = await mountList();
    expect(w.find('[role="alert"]').text()).toContain("forbidden");
    w.unmount();
  });

  it("prompts for a namespace and disables refresh without one", async () => {
    setNamespace(null);
    api.listConfigMaps.mockClear();
    const w = mount(ConfigMapList);
    await flushPromises();
    expect(w.text()).toContain("Select a namespace to list its config maps.");
    expect(api.listConfigMaps).not.toHaveBeenCalled();
    expect(w.find("button").attributes("disabled")).toBeDefined();
    w.unmount();
  });
});

describe("ConfigMapList - detail panel", () => {
  it("opens the detail for the selected config map and renders entries", async () => {
    const w = await mountList();
    await option(w, "app-config").trigger("click");
    await flushPromises();
    expect(api.getConfigMap).toHaveBeenCalledWith("default", "app-config");
    expect(w.text()).toContain("app-config");
    expect(w.find("pre").text()).toBe("debug=true\nport=8080");
    expect(w.text()).toContain("logo.bin");
    w.unmount();
  });

  it("shows loading while the detail is fetched", async () => {
    let resolve;
    api.getConfigMap.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const w = await mountList();
    await option(w, "app-config").trigger("click");
    await flushPromises();
    // The list is loaded; the only role=status left is the detail loader.
    const loader = w.find('[role="status"]');
    expect(loader.exists()).toBe(true);
    expect(loader.text()).toContain("Loading");
    resolve(DETAIL);
    await flushPromises();
    expect(w.text()).toContain("debug=true");
    w.unmount();
  });

  it("copies text values but hides the copy button for binary entries", async () => {
    const w = await mountList();
    await option(w, "app-config").trigger("click");
    await flushPromises();
    const copyButtons = w.findAll(".copy-inline");
    expect(copyButtons).toHaveLength(1); // binary entry has none
    await copyButtons[0].trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "debug=true\nport=8080",
    );
    w.unmount();
  });

  it("shows the error when opening fails and replaces the detail area", async () => {
    api.getConfigMap.mockRejectedValue(new Error("config map gone"));
    const w = await mountList();
    await option(w, "app-config").trigger("click");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("config map gone");
    // The component's state machine swaps the whole body for the error alert.
    expect(w.findAll('[role="option"]')).toHaveLength(0);
    w.unmount();
  });
});

describe("ConfigMapList - refresh", () => {
  it("reloads the list via the refresh button", async () => {
    const w = await mountList();
    await w.find("button").trigger("click");
    await flushPromises();
    expect(api.listConfigMaps).toHaveBeenCalledTimes(2);
    w.unmount();
  });
});
