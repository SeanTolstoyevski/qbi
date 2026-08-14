import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import YamlViewer from "../components/YamlViewer.vue";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { getResourceYaml: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

const MANIFEST = `apiVersion: v1
kind: Pod
metadata:
  name: web-abc12
spec:
  containers:
    - name: app
      image: nginx
`;

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getResourceYaml.mockResolvedValue(MANIFEST);
});

async function mountViewer() {
  const w = mount(YamlViewer, {
    props: { namespace: "default", kind: "pod", name: "web-abc12" },
  });
  await flushPromises();
  return w;
}

describe("YamlViewer", () => {
  it("loads and renders the manifest", async () => {
    const w = await mountViewer();
    expect(api.getResourceYaml).toHaveBeenCalledWith(
      "default",
      "pod",
      "web-abc12",
    );
    expect(w.find("pre").text()).toContain("kind: Pod");
    w.unmount();
  });

  it("copies the manifest to the clipboard", async () => {
    const w = await mountViewer();
    await w
      .findAll("button")
      .find((b) => b.text() === "Copy")
      .trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(MANIFEST);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith("undefined");
    w.unmount();
  });

  it("reports load errors", async () => {
    api.getResourceYaml.mockRejectedValue(new Error("boom"));
    const w = await mountViewer();
    expect(w.find('[role="alert"]').text()).toContain("boom");
    w.unmount();
  });
});
