/*
 * Tests for PodFilesView.vue (experimental "Network files" panel).
 *
 * We mock api.js so the panel renders without a cluster. We test:
 *   - Both file sections render their content.
 *   - A per-file error shows for one file without hiding the other.
 *   - A rejected api call shows the panel-level error.
 *   - The Copy button copies the section's content.
 *   - Escape closes the panel via the close event.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import PodFilesView from "../components/PodFilesView.vue";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { getPodNetworkFiles: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

const FILES = {
  container: "web",
  hosts: "127.0.0.1 localhost\n10.0.0.5 abc.ofb.local",
  hostsError: "",
  resolvConf: "nameserver 10.96.0.10",
  resolvConfError: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getPodNetworkFiles.mockResolvedValue(FILES);
});

function mountView() {
  return mount(PodFilesView, {
    props: { namespace: "default", pod: "web-abc12", container: "web" },
    attachTo: document.body,
  });
}

describe("PodFilesView - rendering", () => {
  it("shows both file sections with their content", async () => {
    const w = mountView();
    await flushPromises();
    const text = w.text();
    expect(text).toContain("Host records (/etc/hosts)");
    expect(text).toContain("10.0.0.5 abc.ofb.local");
    expect(text).toContain("DNS config (/etc/resolv.conf)");
    expect(text).toContain("nameserver 10.96.0.10");
    w.unmount();
  });

  it("shows a per-file error without hiding the other file", async () => {
    api.getPodNetworkFiles.mockResolvedValue({
      ...FILES,
      hostsError: "kubectl exec failed: container not found",
      hosts: "",
    });
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("container not found");
    expect(w.text()).toContain("nameserver 10.96.0.10");
    w.unmount();
  });

  it("shows the panel-level error when the api call fails", async () => {
    api.getPodNetworkFiles.mockRejectedValue(
      new Error("experimental features are disabled"),
    );
    const w = mountView();
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain(
      "experimental features are disabled",
    );
    w.unmount();
  });

  it("marks an empty file explicitly", async () => {
    api.getPodNetworkFiles.mockResolvedValue({
      ...FILES,
      resolvConf: "",
    });
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("File is empty.");
    w.unmount();
  });
});

describe("PodFilesView - actions", () => {
  it("copies the hosts content via its Copy button", async () => {
    const w = mountView();
    await flushPromises();
    const copyBtn = w
      .findAll("button")
      .find((b) => b.text().includes("Copy"));
    await copyBtn.trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(FILES.hosts);
    w.unmount();
  });

  it("closes on Escape", async () => {
    const w = mountView();
    await flushPromises();
    await w.find("section").trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toBeTruthy();
    w.unmount();
  });
});
