import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SecretCreate from "../components/SecretCreate.vue";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { createSecret: vi.fn(), createSecretFromYaml: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

function rowInputs(w) {
  const form = w.find("#secret-create-panel-form");
  const keys = form
    .findAll("input")
    .filter((i) => (i.attributes("id") || "").startsWith("secret-key-"));
  const vals = form.findAll("textarea");
  return { keys, vals };
}

async function mountCreate(mode = "transparent") {
  const w = mount(SecretCreate, {
    props: { namespace: "default", mode },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.createSecret.mockResolvedValue(true);
  api.createSecretFromYaml.mockResolvedValue(true);
});

describe("SecretCreate - focus and layout", () => {
  it("moves focus to the panel heading on open", async () => {
    const w = await mountCreate();
    expect(document.activeElement?.id).toBe("secret-create-heading");
    w.unmount();
  });

  it("starts with one empty key row", async () => {
    const w = await mountCreate();
    expect(
      w.find("#secret-create-panel-form").findAll("textarea"),
    ).toHaveLength(1);
    w.unmount();
  });

  it("adds a row via Add key", async () => {
    const w = await mountCreate();
    await w
      .findAll("button")
      .find((b) => b.text() === "Add key")
      .trigger("click");
    expect(
      w.find("#secret-create-panel-form").findAll("textarea"),
    ).toHaveLength(2);
    w.unmount();
  });
});

describe("SecretCreate - form validation", () => {
  async function fill(
    w,
    { name = "api-token", key = "user", value = "admin" } = {},
  ) {
    if (name !== undefined) await w.find("#secret-create-name").setValue(name);
    const { keys, vals } = rowInputs(w);
    await keys[0].setValue(key);
    await vals[0].setValue(value);
  }

  it("requires a name", async () => {
    const w = await mountCreate();
    await fill(w, { name: "" });
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toContain("Name is required");
    expect(api.createSecret).not.toHaveBeenCalled();
    w.unmount();
  });

  it("rejects duplicate keys", async () => {
    const w = await mountCreate();
    await fill(w);
    await w
      .findAll("button")
      .find((b) => b.text() === "Add key")
      .trigger("click");
    const { keys } = rowInputs(w);
    await keys[1].setValue("user");
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toMatch(/Duplicate/);
    expect(api.createSecret).not.toHaveBeenCalled();
    w.unmount();
  });

  it("rejects invalid base64 values in base64 mode", async () => {
    const w = await mountCreate("base64");
    await fill(w, { value: "not base64!!" });
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toMatch(/not valid base64/);
    expect(api.createSecret).not.toHaveBeenCalled();
    w.unmount();
  });

  it("accepts base64 values in base64 mode", async () => {
    const w = await mountCreate("base64");
    await fill(w, { value: "YWRtaW4=" });
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createSecret).toHaveBeenCalledWith(
      "default",
      { name: "api-token", type: "", data: { user: "YWRtaW4=" } },
      "base64",
    );
    w.unmount();
  });
});

describe("SecretCreate - create flow", () => {
  it("creates with transparent values and emits created", async () => {
    const w = await mountCreate();
    await w.find("#secret-create-name").setValue("api-token");
    const { keys, vals } = rowInputs(w);
    await keys[0].setValue("user");
    await vals[0].setValue("admin");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createSecret).toHaveBeenCalledWith(
      "default",
      { name: "api-token", type: "", data: { user: "admin" } },
      "transparent",
    );
    expect(w.emitted("created")).toBeTruthy();
    w.unmount();
  });

  it("keeps the form open when the user cancels the confirmation", async () => {
    api.createSecret.mockResolvedValue(false);
    const w = await mountCreate();
    await w.find("#secret-create-name").setValue("api-token");
    const { keys, vals } = rowInputs(w);
    await keys[0].setValue("user");
    await vals[0].setValue("admin");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createSecret).toHaveBeenCalled();
    expect(w.emitted("created")).toBeUndefined();
    w.unmount();
  });

  it("shows the error when creation fails", async () => {
    api.createSecret.mockRejectedValue(new Error("forbidden"));
    const w = await mountCreate();
    await w.find("#secret-create-name").setValue("api-token");
    const { keys, vals } = rowInputs(w);
    await keys[0].setValue("user");
    await vals[0].setValue("admin");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("forbidden");
    expect(w.emitted("created")).toBeUndefined();
    w.unmount();
  });
});

describe("SecretCreate - YAML surface", () => {
  it("renders a stringData starter template in transparent mode", async () => {
    const w = await mountCreate("transparent");
    await w
      .findAll('[role="tab"]')
      .find((b) => b.text() === "YAML")
      .trigger("click");
    const ta = w.find("#secret-create-yaml");
    expect(ta.exists()).toBe(true);
    expect(ta.element.value).toContain("stringData:");
    expect(ta.element.value).toContain("kind: Secret");
    w.unmount();
  });

  it("renders a data (base64) starter template in base64 mode", async () => {
    const w = await mountCreate("base64");
    await w
      .findAll('[role="tab"]')
      .find((b) => b.text() === "YAML")
      .trigger("click");
    const ta = w.find("#secret-create-yaml");
    expect(ta.element.value).toContain("data:");
    expect(ta.element.value).not.toContain("stringData:");
    w.unmount();
  });

  it("creates from YAML and emits created", async () => {
    const w = await mountCreate("transparent");
    await w
      .findAll('[role="tab"]')
      .find((b) => b.text() === "YAML")
      .trigger("click");
    const ta = w.find("#secret-create-yaml");
    await ta.setValue(
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: mine\ntype: Opaque\nstringData:\n  a: b\n",
    );
    await w
      .findAll("button")
      .find((b) => b.text() === "Create from YAML")
      .trigger("click");
    await flushPromises();
    expect(api.createSecretFromYaml).toHaveBeenCalledWith(
      "default",
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: mine\ntype: Opaque\nstringData:\n  a: b\n",
    );
    expect(w.emitted("created")).toBeTruthy();
    w.unmount();
  });

  it("keeps the YAML form open when creation is cancelled", async () => {
    api.createSecretFromYaml.mockResolvedValue(false);
    const w = await mountCreate("transparent");
    await w
      .findAll('[role="tab"]')
      .find((b) => b.text() === "YAML")
      .trigger("click");
    await w
      .findAll("button")
      .find((b) => b.text() === "Create from YAML")
      .trigger("click");
    await flushPromises();
    expect(api.createSecretFromYaml).toHaveBeenCalled();
    expect(w.emitted("created")).toBeUndefined();
    w.unmount();
  });

  it("reports empty YAML without calling the API", async () => {
    const w = await mountCreate("transparent");
    await w
      .findAll('[role="tab"]')
      .find((b) => b.text() === "YAML")
      .trigger("click");
    await w.find("#secret-create-yaml").setValue("");
    await w
      .findAll("button")
      .find((b) => b.text() === "Create from YAML")
      .trigger("click");
    expect(w.find('[role="alert"]').text()).toContain("empty");
    expect(api.createSecretFromYaml).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe("SecretCreate - close paths", () => {
  it("emits close from Cancel, the panel Close button and Escape", async () => {
    const w = await mountCreate();
    await w
      .findAll("button")
      .find((b) => b.text() === "Cancel")
      .trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    await w
      .findAll("button")
      .find((b) => b.text() === "Close")
      .trigger("click");
    expect(w.emitted("close")).toHaveLength(2);
    await w.trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toHaveLength(3);
    w.unmount();
  });
});
