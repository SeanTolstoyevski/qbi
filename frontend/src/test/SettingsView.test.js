import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SettingsView from "../components/SettingsView.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: {
    getSettings: vi.fn(),
    setAutoRefresh: vi.fn(),
    setExperimental: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

const { state } = useStore();

const rAF = () => new Promise((r) => requestAnimationFrame(r));

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ welcomeSeen: true, autoRefresh: false });
  api.setAutoRefresh.mockResolvedValue(undefined);
  api.setExperimental.mockResolvedValue(undefined);
  useStore().setExperimental(false);
});

async function mountSettings() {
  const w = mount(SettingsView);
  await flushPromises();
  return w;
}

describe("SettingsView - loading", () => {
  it("seeds the switch from the saved settings", async () => {
    api.getSettings.mockResolvedValue({ autoRefresh: true });
    const w = await mountSettings();
    expect(w.find("#auto-refresh-toggle").element.checked).toBe(true);
    expect(w.text()).toContain("Enabled");
    w.unmount();
  });

  it("defaults to disabled when the saved setting is off", async () => {
    const w = await mountSettings();
    expect(w.find("#auto-refresh-toggle").element.checked).toBe(false);
    expect(w.text()).toContain("Disabled");
    w.unmount();
  });

  it("shows an error when settings cannot be loaded", async () => {
    api.getSettings.mockRejectedValue(new Error("storage unavailable"));
    const w = await mountSettings();
    expect(w.find('[role="alert"]').text()).toContain("storage unavailable");
    w.unmount();
  });
});

describe("SettingsView - dark mode", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-bs-theme");
    localStorage.removeItem("qba.theme");
  });

  it("starts from the persisted theme", async () => {
    localStorage.setItem("qba.theme", "dark");
    const w = await mountSettings();
    expect(w.find("#dark-mode-toggle").element.checked).toBe(true);
    expect(w.text()).toContain("Enabled");
    w.unmount();
  });

  it("enabling dark mode sets the theme attribute, persists and announces", async () => {
    const w = await mountSettings();
    await w.find("#dark-mode-toggle").setValue(true);
    await rAF();
    expect(document.documentElement.getAttribute("data-bs-theme")).toBe("dark");
    expect(localStorage.getItem("qba.theme")).toBe("dark");
    expect(state.status).toContain("Dark mode enabled.");
    w.unmount();
  });

  it("disabling dark mode removes the attribute and persists", async () => {
    localStorage.setItem("qba.theme", "dark");
    const w = await mountSettings();
    await w.find("#dark-mode-toggle").setValue(false);
    await rAF();
    expect(document.documentElement.hasAttribute("data-bs-theme")).toBe(false);
    expect(localStorage.getItem("qba.theme")).toBe("light");
    expect(state.status).toContain("Dark mode disabled.");
    w.unmount();
  });
});

describe("SettingsView - toggling auto-refresh", () => {
  it("enables auto-refresh, persists and announces", async () => {
    const w = await mountSettings();
    await w.find("#auto-refresh-toggle").setValue(true);
    await flushPromises();
    await rAF();
    expect(api.setAutoRefresh).toHaveBeenCalledWith(true);
    expect(state.autoRefresh).toBe(true);
    expect(w.text()).toContain("Enabled");
    expect(state.status).toContain("Auto-refresh enabled.");
    w.unmount();
  });

  it("disables auto-refresh and announces", async () => {
    api.getSettings.mockResolvedValue({ autoRefresh: true });
    const w = await mountSettings();
    await w.find("#auto-refresh-toggle").setValue(false);
    await flushPromises();
    await rAF();
    expect(api.setAutoRefresh).toHaveBeenCalledWith(false);
    expect(state.autoRefresh).toBe(false);
    expect(w.text()).toContain("Disabled");
    expect(state.status).toContain("Auto-refresh disabled.");
    w.unmount();
  });

  it("shows an error and keeps the old state when saving fails", async () => {
    api.setAutoRefresh.mockRejectedValue(new Error("save failed"));
    const w = await mountSettings();
    await w.find("#auto-refresh-toggle").setValue(true);
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("save failed");
    expect(state.autoRefresh).toBe(false);
    expect(w.text()).toContain("Disabled");
    w.unmount();
  });

  it("disables the switch while a save is in flight", async () => {
    let resolve;
    api.setAutoRefresh.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const w = await mountSettings();
    await w.find("#auto-refresh-toggle").setValue(true);
    await flushPromises();
    const toggle = w.find("#auto-refresh-toggle");
    expect(toggle.attributes("disabled")).toBeDefined();
    expect(w.text()).toContain("saving");
    resolve();
    await flushPromises();
    expect(toggle.attributes("disabled")).toBeUndefined();
    w.unmount();
  });
});

describe("SettingsView - toggling experimental features", () => {
  it("seeds the switch from the saved settings", async () => {
    api.getSettings.mockResolvedValue({ experimental: true });
    const w = await mountSettings();
    expect(w.find("#experimental-toggle").element.checked).toBe(true);
    w.unmount();
  });

  it("enables experimental features, persists and announces", async () => {
    const w = await mountSettings();
    await w.find("#experimental-toggle").setValue(true);
    await flushPromises();
    await rAF();
    expect(api.setExperimental).toHaveBeenCalledWith(true);
    expect(state.experimental).toBe(true);
    expect(state.status).toContain("Experimental features enabled.");
    w.unmount();
  });

  it("disables experimental features and announces", async () => {
    api.getSettings.mockResolvedValue({ experimental: true });
    const w = await mountSettings();
    await w.find("#experimental-toggle").setValue(false);
    await flushPromises();
    await rAF();
    expect(api.setExperimental).toHaveBeenCalledWith(false);
    expect(state.experimental).toBe(false);
    expect(state.status).toContain("Experimental features disabled.");
    w.unmount();
  });

  it("keeps the old state when saving fails", async () => {
    api.setExperimental.mockRejectedValue(new Error("save failed"));
    const w = await mountSettings();
    await w.find("#experimental-toggle").setValue(true);
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("save failed");
    expect(state.experimental).toBe(false);
    w.unmount();
  });
});
