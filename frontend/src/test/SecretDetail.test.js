/*
 * Tests for SecretDetail.vue — the open-secret panel (view / edit / YAML).
 *
 * We cover:
 *   - view: masked values, per-row reveal + copy, reveal-all, base64 display
 *   - binary values: readable only in base64 mode
 *   - edit: seeded rows, change review, mode-aware save, validation errors,
 *     re-seeding when the global value mode flips
 *   - YAML: mode-aware rendering and replace-from-YAML
 *   - delete (with the cancelled path) and Escape behaviour
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SecretDetail from "../components/SecretDetail.vue";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: {
    getSecret: vi.fn(),
    updateSecret: vi.fn(),
    deleteSecret: vi.fn(),
    getSecretYaml: vi.fn(),
    updateSecretFromYaml: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

const DETAIL = {
  name: "api-token",
  type: "Opaque",
  entries: [
    { key: "username", value: "admin", base64: "YWRtaW4=", isBinary: false },
    { key: "password", value: "s3cret", base64: "czNjcmV0", isBinary: false },
    { key: "cert", value: "<11 bytes of binary data>", base64: "aGVsbG8gd29ybGQ=", isBinary: true },
  ],
};

const YAML_MANIFEST = `apiVersion: v1
kind: Secret
metadata:
  name: api-token
type: Opaque
stringData:
  username: admin
`;

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getSecret.mockResolvedValue(DETAIL);
  api.updateSecret.mockResolvedValue({ ...DETAIL });
  api.deleteSecret.mockResolvedValue(true);
  api.getSecretYaml.mockResolvedValue(YAML_MANIFEST);
  api.updateSecretFromYaml.mockResolvedValue(true);
});

async function mountDetail(mode = "transparent") {
  const w = mount(SecretDetail, {
    props: { namespace: "default", name: "api-token", mode },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

function row(w, i) {
  return w.findAll("tbody tr")[i];
}

function tab(w, label) {
  return w.findAll('[role="tab"]').find((b) => b.text().toLowerCase() === label.toLowerCase());
}

async function enterEdit(w) {
  await tab(w, "Edit").trigger("click");
}

describe("SecretDetail — open & focus", () => {
  it("fetches the secret and moves focus to the heading", async () => {
    const w = await mountDetail();
    expect(api.getSecret).toHaveBeenCalledWith("default", "api-token");
    expect(document.activeElement?.id).toBe("secret-detail-heading");
    w.unmount();
  });

  it("reports load errors", async () => {
    api.getSecret.mockRejectedValue(new Error("not found"));
    const w = await mountDetail();
    expect(w.find('[role="alert"]').text()).toMatch(/not found/i);
    w.unmount();
  });
});

describe("SecretDetail — view mode", () => {
  it("renders one row per entry, masked by default", async () => {
    const w = await mountDetail();
    expect(w.findAll("tbody tr")).toHaveLength(3);
    expect(row(w, 0).text()).toContain("username");
    expect(row(w, 0).text()).toContain("••••••••");
    w.unmount();
  });

  it("reveals and hides a single value", async () => {
    const w = await mountDetail();
    const reveal = row(w, 0).findAll("button").find((b) => b.text() === "Reveal");
    await reveal.trigger("click");
    expect(row(w, 0).text()).toContain("admin");
    expect(row(w, 0).findAll("button").find((b) => b.text() === "Hide")).toBeTruthy();
    w.unmount();
  });

  it("copies the revealed value to the clipboard", async () => {
    const w = await mountDetail();
    await row(w, 0).findAll("button").find((b) => b.text() === "Copy").trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("admin");
    w.unmount();
  });

  it("reveals all values and hides them again", async () => {
    const w = await mountDetail();
    await w.findAll("button").find((b) => b.text() === "Reveal all").trigger("click");
    expect(row(w, 0).text()).toContain("admin");
    expect(row(w, 1).text()).toContain("s3cret");
    await w.findAll("button").find((b) => b.text() === "Hide all").trigger("click");
    expect(row(w, 0).text()).toContain("••••••••");
    w.unmount();
  });

  it("shows raw base64 values in base64 mode", async () => {
    const w = await mountDetail("base64");
    await row(w, 0).findAll("button").find((b) => b.text() === "Reveal").trigger("click");
    expect(row(w, 0).text()).toContain("YWRtaW4=");
    // Copy in base64 mode copies the base64, not the decoded text.
    await row(w, 0).findAll("button").find((b) => b.text() === "Copy").trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("YWRtaW4=");
    w.unmount();
  });

  it("marks binary values unreadable in transparent mode", async () => {
    const w = await mountDetail("transparent");
    const cert = row(w, 2);
    expect(cert.text()).toContain("binary");
    // Like every value it is masked; the "(binary)" tag is the only hint.
    expect(cert.text()).toContain("••••••••");
    expect(cert.findAll("button")).toHaveLength(0); // no reveal/copy possible
    w.unmount();
  });

  it("makes binary values readable in base64 mode", async () => {
    const w = await mountDetail("base64");
    const cert = row(w, 2);
    expect(cert.findAll("button").length).toBeGreaterThan(0);
    await cert.findAll("button").find((b) => b.text() === "Reveal").trigger("click");
    expect(cert.text()).toContain("aGVsbG8gd29ybGQ=");
    w.unmount();
  });
});

describe("SecretDetail — edit mode", () => {
  it("seeds the draft from the entries and saves a change", async () => {
    const w = await mountDetail();
    await enterEdit(w);
    const editPanel = w.find("#secret-submode-panel-edit");
    const textareas = editPanel.findAll("textarea");
    // Two textareas: the binary cert row renders a note, not an editor.
    expect(textareas).toHaveLength(2);
    await textareas[1].setValue("new-pass"); // password
    await w.findAll("button").find((b) => b.text() === "Review & save").trigger("click");

    // The APG alertdialog appears with a summary of the single change.
    const dialog = w.find('[role="alertdialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("1 changed");

    await dialog.findAll("button").find((b) => b.text() === "Apply to cluster").trigger("click");
    await flushPromises();
    expect(api.updateSecret).toHaveBeenCalledWith(
      "default",
      "api-token",
      [{ key: "password", value: "new-pass", delete: false }],
      "transparent"
    );
    expect(w.emitted("updated")).toBeTruthy();
    // Back in view mode: the edit panel is hidden again.
    expect(w.find("#secret-submode-panel-edit").isVisible()).toBe(false);
    expect(w.find("#secret-submode-panel-view").isVisible()).toBe(true);
    w.unmount();
  });

  it("sends base64 values and mode in base64 mode", async () => {
    const w = await mountDetail("base64");
    await enterEdit(w);
    const textareas = w.find("#secret-submode-panel-edit").findAll("textarea");
    // In base64 mode every row (including the binary cert) is editable.
    expect(textareas).toHaveLength(3);
    // Draft holds raw base64 in base64 mode.
    expect(textareas[0].element.value).toBe("YWRtaW4=");
    await textareas[2].setValue("aGVsbG8="); // "hello" — differs from cert
    await w.findAll("button").find((b) => b.text() === "Review & save").trigger("click");
    await w.find('[role="alertdialog"]').findAll("button").find((b) => b.text() === "Apply to cluster").trigger("click");
    await flushPromises();
    expect(api.updateSecret).toHaveBeenCalledWith(
      "default",
      "api-token",
      [{ key: "cert", value: "aGVsbG8=", delete: false }],
      "base64"
    );
    w.unmount();
  });

  it("warns when there are no changes to save", async () => {
    const w = await mountDetail();
    await enterEdit(w);
    await w.findAll("button").find((b) => b.text() === "Review & save").trigger("click");
    expect(w.find('[role="alertdialog"]').exists()).toBe(false);
    expect(w.text()).toContain("No changes to save.");
    w.unmount();
  });

  it("rejects duplicate keys in the draft", async () => {
    const w = await mountDetail();
    await enterEdit(w);
    await w.findAll("button").find((b) => b.text() === "Add key").trigger("click");
    const newKey = w
      .findAll("input")
      .filter((i) => (i.attributes("id") || "").startsWith("secret-key-"))
      .at(-1);
    await newKey.setValue("username");
    await w.findAll("button").find((b) => b.text() === "Review & save").trigger("click");
    expect(w.text()).toMatch(/Duplicate/);
    expect(w.find('[role="alertdialog"]').exists()).toBe(false);
    w.unmount();
  });

  it("rejects invalid base64 in base64 mode", async () => {
    const w = await mountDetail("base64");
    await enterEdit(w);
    await w.findAll("textarea")[0].setValue("!!!not base64!!!");
    await w.findAll("button").find((b) => b.text() === "Review & save").trigger("click");
    expect(w.text()).toMatch(/not valid base64/);
    expect(w.find('[role="alertdialog"]').exists()).toBe(false);
    w.unmount();
  });

  it("re-seeds the draft when the global value mode flips", async () => {
    const w = await mountDetail("transparent");
    await enterEdit(w);
    expect(w.findAll("textarea")[0].element.value).toBe("admin");
    await w.setProps({ mode: "base64" });
    await flushPromises();
    expect(w.findAll("textarea")[0].element.value).toBe("YWRtaW4=");
    w.unmount();
  });

  it("closes the confirm dialog on Escape and returns focus to Review", async () => {
    const w = await mountDetail();
    await enterEdit(w);
    await w.findAll("textarea")[0].setValue("changed");
    await w.findAll("button").find((b) => b.text() === "Review & save").trigger("click");
    await w.find('[role="alertdialog"]').trigger("keydown", { key: "Escape" });
    expect(w.find('[role="alertdialog"]').exists()).toBe(false);
    expect(document.activeElement?.textContent).toContain("Review");
    w.unmount();
  });
});

describe("SecretDetail — YAML mode", () => {
  it("loads the transparent manifest and applies an edit", async () => {
    const w = await mountDetail("transparent");
    await tab(w, "YAML").trigger("click");
    await flushPromises();
    expect(api.getSecretYaml).toHaveBeenCalledWith("default", "api-token", true);
    const ta = w.findAll("textarea")[0];
    expect(ta.element.value).toContain("stringData:");
    await ta.setValue(ta.element.value + "  password: new\n");
    await w.findAll("button").find((b) => b.text() === "Apply").trigger("click");
    await flushPromises();
    expect(api.updateSecretFromYaml).toHaveBeenCalledWith(
      "default",
      "api-token",
      expect.stringContaining("password: new")
    );
    expect(w.emitted("updated")).toBeTruthy();
    w.unmount();
  });

  it("loads the raw manifest in base64 mode", async () => {
    const w = await mountDetail("base64");
    await tab(w, "YAML").trigger("click");
    await flushPromises();
    expect(api.getSecretYaml).toHaveBeenCalledWith("default", "api-token", false);
    w.unmount();
  });

  it("rejects an empty manifest without calling the API", async () => {
    const w = await mountDetail();
    await tab(w, "YAML").trigger("click");
    await flushPromises();
    await w.findAll("textarea")[0].setValue("");
    await w.findAll("button").find((b) => b.text() === "Apply").trigger("click");
    expect(w.text()).toContain("empty");
    expect(api.updateSecretFromYaml).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe("SecretDetail — delete and Escape", () => {
  it("deletes the secret and emits deleted", async () => {
    const w = await mountDetail();
    await w.findAll("button").find((b) => b.text() === "Delete secret").trigger("click");
    await flushPromises();
    expect(api.deleteSecret).toHaveBeenCalledWith("default", "api-token");
    expect(w.emitted("deleted")).toBeTruthy();
    w.unmount();
  });

  it("keeps the panel open when deletion is cancelled", async () => {
    api.deleteSecret.mockResolvedValue(false);
    const w = await mountDetail();
    await w.findAll("button").find((b) => b.text() === "Delete secret").trigger("click");
    await flushPromises();
    expect(w.emitted("deleted")).toBeUndefined();
    w.unmount();
  });

  it("Escape in view mode asks the parent to close", async () => {
    const w = await mountDetail();
    await w.trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toBeTruthy();
    w.unmount();
  });

  it("Escape in edit mode returns to view instead of closing", async () => {
    const w = await mountDetail();
    await enterEdit(w);
    expect(w.find("#secret-submode-panel-edit").isVisible()).toBe(true);
    await w.trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toBeUndefined();
    expect(w.find("#secret-submode-panel-edit").isVisible()).toBe(false);
    expect(w.find("#secret-submode-panel-view").isVisible()).toBe(true);
    w.unmount();
  });
});
