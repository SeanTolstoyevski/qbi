import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AboutView from "../components/AboutView.vue";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { buildInfo: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AboutView - version info", () => {
  it("renders the keyboard shortcuts reference", async () => {
    api.buildInfo.mockResolvedValue({
      version: "dev",
      commit: "unknown",
      buildTime: "unknown",
    });
    const w = mount(AboutView);
    await flushPromises();
    expect(w.text()).toContain("Keyboard shortcuts");
    expect(w.text()).toContain("Ctrl+E");
    expect(w.text()).toContain("focus the namespace list");
    w.unmount();
  });

  it("renders the version and commit", async () => {
    api.buildInfo.mockResolvedValue({
      version: "0.2.0",
      commit: "a1b2c3d",
      buildTime: "unknown",
    });
    const w = mount(AboutView);
    await flushPromises();
    expect(w.text()).toContain("0.2.0");
    expect(w.text()).toContain("a1b2c3d");
    w.unmount();
  });

  it("renders the build time in the user's locale", async () => {
    api.buildInfo.mockResolvedValue({
      version: "dev",
      commit: "unknown",
      buildTime: "2026-06-18T12:34:56Z",
    });
    const w = mount(AboutView);
    await flushPromises();
    expect(w.text()).toContain("Built");

    const expected = new Date("2026-06-18T12:34:56Z").toLocaleString();
    expect(w.text()).toContain(expected);
    w.unmount();
  });

  it("shows a placeholder when the build time was not stamped", async () => {
    api.buildInfo.mockResolvedValue({
      version: "dev",
      commit: "unknown",
      buildTime: "unknown",
    });
    const w = mount(AboutView);
    await flushPromises();

    const dds = w.findAll("dd");
    expect(dds[dds.length - 1].text()).toBe("…");
    w.unmount();
  });

  it("shows the open-source tagline", async () => {
    const w = mount(AboutView);
    await flushPromises();
    expect(w.find("p.lead").text()).toBe(
      "QBI is a lightweight Kubernetes inspector: 100% open source & 100% accessible.",
    );
    w.unmount();
  });

  it("shows an error when version info cannot be loaded", async () => {
    api.buildInfo.mockRejectedValue(new Error("bindings unavailable"));
    const w = mount(AboutView);
    await flushPromises();
    expect(w.text()).toContain("bindings unavailable");
    w.unmount();
  });
});

describe("AboutView - GitHub link", () => {
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
