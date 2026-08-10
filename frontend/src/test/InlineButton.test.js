import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import InlineButton from "../components/InlineButton.vue";

vi.mock("../store.js", () => {
  const announce = vi.fn();
  return {
    useStore: () => ({ announce }),
  };
});

const { useStore } = await import("../store.js");

describe("InlineButton", () => {
  let writeText;
  let announce;

  beforeEach(() => {
    writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    announce = useStore().announce;
    vi.clearAllMocks();
  });

  function mountButton(props = {}) {
    return mount(InlineButton, {
      props: { copyText: "hello", ...props },
    });
  }

  it("has no aria-label: the visible text is the accessible name", () => {
    const w = mountButton({ announce: "Pod web-abc12" });
    const btn = w.get("button");
    expect(btn.attributes("aria-label")).toBeUndefined();
    expect(btn.attributes("title")).toBeUndefined();
    // The icon is decorative; the text span is not aria-hidden, so the
    // screen reader announces "Copy button" — no per-row label noise.
    expect(btn.get("svg").attributes("aria-hidden")).toBe("true");
    expect(
      btn.get(".inline-button-text").attributes("aria-hidden"),
    ).toBeUndefined();
    expect(btn.get(".inline-button-text").text()).toBe("Copy");
    w.unmount();
  });

  it("lets callers add a hover tooltip", () => {
    const w = mountButton({
      announce: "Pod web-abc12",
      title: "Copy web-abc12",
    });
    expect(w.get("button").attributes("title")).toBe("Copy web-abc12");
    expect(w.get("button").attributes("aria-label")).toBeUndefined();
    w.unmount();
  });

  it("renders the text label (hidden by default) and a custom label when given", () => {
    const w = mountButton({ text: "Copy DNS" });
    expect(w.get(".inline-button-text").text()).toBe("Copy DNS");
    w.unmount();
  });

  it("copies the value and announces it on click", async () => {
    writeText.mockResolvedValue(undefined);
    const w = mountButton({ announce: "Event message" });
    await w.get("button").trigger("click");
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(announce).toHaveBeenCalledWith("Event message copied to clipboard.");
    w.unmount();
  });

  it("announces failure when the clipboard write rejects", async () => {
    writeText.mockRejectedValue(new Error("Denied"));
    const w = mountButton({ announce: "Value" });
    await w.get("button").trigger("click");
    expect(announce).toHaveBeenCalledWith("Copy failed.", "assertive");
    w.unmount();
  });

  it("defaults to the name-cell variant and switches to inline on request", () => {
    const cell = mountButton();
    expect(cell.get("button").classes()).toContain("copy-inline");
    expect(cell.get("button").classes()).not.toContain("copy-inline--inline");
    cell.unmount();

    const inline = mountButton({ variant: "inline" });
    expect(inline.get("button").classes()).toContain("copy-inline--inline");
    inline.unmount();
  });
});
