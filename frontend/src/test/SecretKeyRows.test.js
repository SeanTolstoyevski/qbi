import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import SecretKeyRows from "../components/SecretKeyRows.vue";

function row(over = {}) {
  return {
    id: 1,
    key: "username",
    value: "admin",
    isBinary: false,
    isNew: false,
    deleted: false,
    ...over,
  };
}

function mountRows(props) {
  return mount(SecretKeyRows, { props });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SecretKeyRows - rendering", () => {
  it("renders a row per entry with key, value and Remove button", () => {
    const w = mountRows({ rows: [row(), row({ id: 2, key: "password" })] });
    expect(w.findAll("input[type='text']")).toHaveLength(2);
    expect(w.findAll("textarea")).toHaveLength(2);
    expect(w.findAll("button")).toHaveLength(3); // Remove ×2 + Add key
    const inputs = w.findAll("input[type='text']");
    expect(inputs[0].element.value).toBe("username");
    expect(inputs[1].element.value).toBe("password");
    w.unmount();
  });

  it("uses the plain-text placeholder in transparent mode", () => {
    const w = mountRows({ rows: [row()] });
    expect(w.find("textarea").attributes("placeholder")).toBe(
      "plain text value",
    );
    w.unmount();
  });

  it("uses the base64 placeholder in base64 mode", () => {
    const w = mountRows({ rows: [row()], mode: "base64" });
    expect(w.find("textarea").attributes("placeholder")).toBe("base64 value");
    w.unmount();
  });

  it("shows the binary note instead of a textarea in transparent mode", () => {
    const w = mountRows({ rows: [row({ isBinary: true, value: "raw" })] });
    expect(w.find("textarea").exists()).toBe(false);
    expect(w.text()).toContain("binary value, preserved unchanged");
    w.unmount();
  });

  it("edits binary rows in base64 mode", () => {
    const w = mountRows({
      rows: [row({ isBinary: true })],
      mode: "base64",
    });
    expect(w.find("textarea").exists()).toBe(true);
    w.unmount();
  });
});

describe("SecretKeyRows - key row behaviour", () => {
  it("keeps keys readonly for existing rows in edit mode", () => {
    const w = mountRows({
      rows: [row(), row({ id: 2, isNew: true })],
      readonlyKeys: true,
    });
    const inputs = w.findAll("input[type='text']");
    expect(inputs[0].attributes("readonly")).toBeDefined();
    expect(inputs[1].attributes("readonly")).toBeUndefined();
    w.unmount();
  });

  it("keeps keys editable for existing rows when not readonly", () => {
    const w = mountRows({ rows: [row()], readonlyKeys: false });
    expect(w.find("input[type='text']").attributes("readonly")).toBeUndefined();
    w.unmount();
  });

  it("disables key and value inputs for deleted rows", () => {
    const w = mountRows({ rows: [row({ deleted: true })] });
    expect(w.find("input[type='text']").attributes("disabled")).toBeDefined();
    expect(w.find("textarea").attributes("disabled")).toBeDefined();
    w.unmount();
  });
});

describe("SecretKeyRows - events", () => {
  it("emits add when Add key is clicked", async () => {
    const w = mountRows({ rows: [row()] });
    await w
      .findAll("button")
      .find((b) => b.text() === "Add key")
      .trigger("click");
    expect(w.emitted("add")).toHaveLength(1);
    w.unmount();
  });

  it("emits toggle-delete with the row when Remove is clicked", async () => {
    const r = row();
    const w = mountRows({ rows: [r] });
    await w
      .findAll("button")
      .find((b) => b.text() === "Remove")
      .trigger("click");
    expect(w.emitted("toggle-delete")).toEqual([[r]]);
    w.unmount();
  });

  it("flips the button to Undo for deleted rows with aria-pressed", () => {
    const w = mountRows({ rows: [row({ deleted: true, key: "username" })] });
    const btn = w.findAll("button").find((b) => b.text() === "Undo");
    expect(btn.attributes("aria-pressed")).toBe("true");
    expect(btn.attributes("aria-label")).toBe("Restore key username");
    w.unmount();
  });
});
