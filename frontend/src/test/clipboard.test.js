import { describe, it, expect, vi, beforeEach } from "vitest";
import { copyToClipboard } from "../clipboard.js";

vi.mock("../store.js", () => {
  const announce = vi.fn();
  const flash = vi.fn();
  return {
    useStore: () => ({ announce, flash }),
  };
});

const { useStore } = await import("../store.js");

describe("copyToClipboard", () => {
  let writeText;
  let announce;
  let flash;

  beforeEach(() => {
    writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    announce = useStore().announce;
    flash = useStore().flash;
    vi.clearAllMocks();
  });

  it("writes text to the clipboard and announces success", async () => {
    writeText.mockResolvedValue(undefined);

    await copyToClipboard("hello", "Greeting");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(announce).toHaveBeenCalledWith("Greeting copied to clipboard.");
    expect(flash).toHaveBeenCalledWith("Greeting copied.");
  });

  it("announces the label in the success message", async () => {
    writeText.mockResolvedValue(undefined);

    await copyToClipboard("yaml content", "YAML preview");

    expect(announce).toHaveBeenCalledWith("YAML preview copied to clipboard.");
  });

  it("announces failure when clipboard write rejects", async () => {
    writeText.mockRejectedValue(new Error("Denied"));

    await copyToClipboard("x", "Stuff");

    expect(announce).toHaveBeenCalledWith("Copy failed.", "assertive");
    expect(flash).toHaveBeenCalledWith("Copy failed.");
  });

  it("can copy an empty string", async () => {
    writeText.mockResolvedValue(undefined);

    await copyToClipboard("", "Empty");

    expect(writeText).toHaveBeenCalledWith("");
    expect(announce).toHaveBeenCalledWith("Empty copied to clipboard.");
  });

  it("can copy a very long string", async () => {
    writeText.mockResolvedValue(undefined);
    const long = "x".repeat(100_000);

    await copyToClipboard(long, "Big text");

    expect(writeText).toHaveBeenCalledWith(long);
  });
});
