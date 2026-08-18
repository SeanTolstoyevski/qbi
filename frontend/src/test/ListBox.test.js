import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ListBox from "../components/ListBox.vue";

const OPTIONS = [
  { value: "default", label: "default" },
  { value: "kube-system", label: "kube-system" },
  { value: "monitoring", label: "monitoring" },
  { value: "logging", label: "logging" },
];

function mountListBox(overrides = {}) {
  return mount(ListBox, {
    props: {
      options: OPTIONS,
      modelValue: null,
      ariaLabel: "Namespaces",
      ...overrides,
    },
    attachTo: document.body,
  });
}

describe("ListBox - ARIA structure", () => {
  it("renders a ul with role=listbox and aria-label", () => {
    const w = mountListBox();
    const ul = w.find("ul");
    expect(ul.attributes("role")).toBe("listbox");
    expect(ul.attributes("aria-label")).toBe("Namespaces");
    w.unmount();
  });

  it("renders every option with role=option", () => {
    const w = mountListBox();
    const items = w.findAll("[role=option]");
    expect(items).toHaveLength(OPTIONS.length);
    w.unmount();
  });

  it("marks the selected option as aria-selected=true, others false", () => {
    const w = mountListBox({ modelValue: "monitoring" });
    const items = w.findAll("[role=option]");
    expect(items[2].attributes("aria-selected")).toBe("true");
    expect(items[0].attributes("aria-selected")).toBe("false");
    w.unmount();
  });

  it("gives tabindex=0 only to the active (focused) option", () => {
    const w = mountListBox({ modelValue: "kube-system" });
    // modelValue='kube-system' is index 1 → should have tabindex=0
    const items = w.findAll("[role=option]");
    expect(items[1].attributes("tabindex")).toBe("0");
    expect(items[0].attributes("tabindex")).toBe("-1");
    w.unmount();
  });
});

describe("ListBox - keyboard navigation", () => {
  it("ArrowDown moves focus to the next option", async () => {
    const w = mountListBox();
    await w.find("ul").trigger("keydown", { key: "ArrowDown" });
    // activeIndex advances from 0 → 1, so item[1] gets tabindex=0
    expect(w.findAll("[role=option]")[1].attributes("tabindex")).toBe("0");
    w.unmount();
  });

  it("ArrowUp does not go below index 0", async () => {
    const w = mountListBox();
    await w.find("ul").trigger("keydown", { key: "ArrowUp" });
    // Already at 0; should stay at 0
    expect(w.findAll("[role=option]")[0].attributes("tabindex")).toBe("0");
    w.unmount();
  });

  it("End jumps to the last option", async () => {
    const w = mountListBox();
    await w.find("ul").trigger("keydown", { key: "End" });
    const items = w.findAll("[role=option]");
    expect(items[items.length - 1].attributes("tabindex")).toBe("0");
    w.unmount();
  });

  it("Home jumps back to the first option", async () => {
    const w = mountListBox();
    await w.find("ul").trigger("keydown", { key: "End" });
    await w.find("ul").trigger("keydown", { key: "Home" });
    expect(w.findAll("[role=option]")[0].attributes("tabindex")).toBe("0");
    w.unmount();
  });

  it("ArrowDown + ArrowDown chains correctly", async () => {
    const w = mountListBox();
    await w.find("ul").trigger("keydown", { key: "ArrowDown" });
    await w.find("ul").trigger("keydown", { key: "ArrowDown" });
    expect(w.findAll("[role=option]")[2].attributes("tabindex")).toBe("0");
    w.unmount();
  });
});

describe("ListBox - selection", () => {
  it("Enter emits 'select' with the focused option value", async () => {
    const w = mountListBox();
    await w.find("ul").trigger("keydown", { key: "ArrowDown" });
    await w.find("ul").trigger("keydown", { key: "Enter" });
    expect(w.emitted("select")).toEqual([["kube-system"]]);
    w.unmount();
  });

  it("Space emits 'select'", async () => {
    const w = mountListBox();
    await w.find("ul").trigger("keydown", { key: " " });
    expect(w.emitted("select")).toEqual([["default"]]);
    w.unmount();
  });

  it("click emits 'select' with the clicked option value", async () => {
    const w = mountListBox();
    await w.findAll("[role=option]")[2].trigger("click");
    expect(w.emitted("select")).toEqual([["monitoring"]]);
    w.unmount();
  });

  it("moving focus does NOT emit 'select' (selection does not follow focus)", async () => {
    const w = mountListBox();
    await w.find("ul").trigger("keydown", { key: "ArrowDown" });
    await w.find("ul").trigger("keydown", { key: "ArrowDown" });
    await w.find("ul").trigger("keydown", { key: "ArrowDown" });
    expect(w.emitted("select")).toBeUndefined();
    w.unmount();
  });
});

describe("ListBox - type-ahead", () => {
  it("jumps to the first option starting with the typed letter", async () => {
    const w = mountListBox();
    await w.find("ul").trigger("keydown", { key: "m" });
    // 'monitoring' is index 2
    expect(w.findAll("[role=option]")[2].attributes("tabindex")).toBe("0");
    w.unmount();
  });

  it("cycles to the next match on repeated key press", async () => {
    const w = mountListBox();
    // 'l' should match 'logging' at index 3
    await w.find("ul").trigger("keydown", { key: "l" });
    expect(w.findAll("[role=option]")[3].attributes("tabindex")).toBe("0");
    w.unmount();
  });
});

describe("ListBox - option list changes", () => {
  it("clamps active index when options shrink below it", async () => {
    const w = mountListBox();
    // Move to last item (index 3)
    await w.find("ul").trigger("keydown", { key: "End" });
    // Shrink options to 2 items
    await w.setProps({ options: OPTIONS.slice(0, 2) });
    await nextTick();
    // Active index should be clamped to 1 (last valid)
    expect(w.findAll("[role=option]")[1].attributes("tabindex")).toBe("0");
    w.unmount();
  });
});
