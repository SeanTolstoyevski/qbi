import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AboutView from "../components/AboutView.vue";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { version: vi.fn(), commit: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AboutView — version info", () => {
  it("renders the version and commit", async () => {
    api.version.mockResolvedValue("0.2.0");
    api.commit.mockResolvedValue("a1b2c3d");
    const w = mount(AboutView);
    await flushPromises();
    expect(w.text()).toContain("0.2.0");
    expect(w.text()).toContain("a1b2c3d");
    w.unmount();
  });

  it("shows an error when version info cannot be loaded", async () => {
    api.version.mockRejectedValue(new Error("bindings unavailable"));
    const w = mount(AboutView);
    await flushPromises();
    expect(w.text()).toContain("bindings unavailable");
    w.unmount();
  });
});

describe("AboutView — GitHub link", () => {
  it("links to the project repository", async () => {
    const w = mount(AboutView);
    await flushPromises();
    const link = w.find("a");
    expect(link.attributes("href")).toBe(
      "https://github.com/SeanTolstoyevski/qbi",
    );
    expect(link.text()).toContain("SeanTolstoyevski/qbi");
    w.unmount();
  });

  it("opens the repository through the Wails runtime when available", async () => {
    const open = vi.fn();
    window.runtime.BrowserOpenURL = open;
    const w = mount(AboutView);
    await flushPromises();
    await w.find("a").trigger("click");
    expect(open).toHaveBeenCalledWith(
      "https://github.com/SeanTolstoyevski/qbi",
    );
    w.unmount();
  });
});
