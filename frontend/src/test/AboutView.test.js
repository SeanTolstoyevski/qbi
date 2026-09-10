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

function infoRows(w) {
  const terms = w.findAll("dt").map((n) => n.text());
  const values = w.findAll("dd").map((n) => n.text());
  return Object.fromEntries(terms.map((t, i) => [t, values[i]]));
}

function utcStamp(raw) {
  const stamp = new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(raw));
  return `${stamp} UTC`;
}

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

  it("lists version, commit and build time in separate fields", async () => {
    api.buildInfo.mockResolvedValue({
      version: "0.2.0-beta.1",
      channel: "beta",
      commit: "a1b2c3d",
      buildTime: "2026-06-18T12:34:56Z",
    });
    const w = mount(AboutView);
    await flushPromises();

    const rows = infoRows(w);
    expect(Object.keys(rows)).toEqual(["Version", "Commit", "Build"]);
    expect(rows.Version).toBe("0.2.0-beta.1");
    expect(rows.Commit).toBe("a1b2c3d");
    expect(rows.Build).toBe(utcStamp("2026-06-18T12:34:56Z"));
    expect(rows.Build).not.toContain("a1b2c3d");
    w.unmount();
  });

  it("renders the build time in UTC", async () => {
    api.buildInfo.mockResolvedValue({
      version: "dev",
      commit: "unknown",
      buildTime: "2026-06-18T12:34:56Z",
    });
    const w = mount(AboutView);
    await flushPromises();

    const built = infoRows(w).Build;
    expect(built).toContain("UTC");
    expect(built).toBe(utcStamp("2026-06-18T12:34:56Z"));
    w.unmount();
  });

  it("renders an offset build time as the same UTC instant", async () => {
    api.buildInfo.mockResolvedValue({
      version: "dev",
      commit: "unknown",
      buildTime: "2026-06-18T15:34:56+03:00",
    });
    const w = mount(AboutView);
    await flushPromises();
    expect(infoRows(w).Build).toBe(utcStamp("2026-06-18T12:34:56Z"));
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
    expect(infoRows(w).Build).toBe("…");
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
