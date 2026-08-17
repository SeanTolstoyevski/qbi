import { describe, it, expect, vi, beforeAll } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import YamlPreview from "../components/YamlPreview.vue";

const YAML = "kind: Service\nmetadata:\n  name: web";

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe("YamlPreview", () => {
  it("renders nothing while closed", () => {
    const w = mount(YamlPreview, { props: { yaml: YAML, open: false } });
    expect(w.find("pre").exists()).toBe(false);
    expect(w.find("button").exists()).toBe(false);
    w.unmount();
  });

  it("renders the manifest with a Copy button when open", () => {
    const w = mount(YamlPreview, { props: { yaml: YAML, open: true } });
    expect(w.text()).toContain("Preview YAML");
    expect(w.find("pre").text()).toBe(YAML);
    w.unmount();
  });

  it("copies the manifest via the Copy button", async () => {
    const w = mount(YamlPreview, { props: { yaml: YAML, open: true } });
    await w.find("button").trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(YAML);
    w.unmount();
  });
});
