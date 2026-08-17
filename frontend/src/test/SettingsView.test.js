import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SettingsView from "../components/SettingsView.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { getSettings: vi.fn(), setAutoRefresh: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

const { state } = useStore();

const rAF = () => new Promise((r) => requestAnimationFrame(r));

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ welcomeSeen: true, autoRefresh: false });
  api.setAutoRefresh.mockResolvedValue(undefined);
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
