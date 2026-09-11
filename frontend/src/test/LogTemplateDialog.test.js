import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";

vi.mock("../api.js", () => ({
  api: {
    getLogTemplateSettings: vi.fn(),
    saveLogTemplate: vi.fn(),
    deleteLogTemplate: vi.fn(),
  },
  onEvent: () => () => {},
}));

import LogTemplateDialog from "../components/LogTemplateDialog.vue";
import { api } from "../api.js";

const SAMPLE = '{"ts":1,"level":"info","msg":"m"}';
const T1 = { id: "t1", name: "App", fieldOrder: ["msg", "ts"] };

async function mountDialog() {
  const w = mount(LogTemplateDialog, { attachTo: document.body });
  await flushPromises(); // initial template load
  return w;
}

function rowButtons(w, field) {
  const row = w
    .findAll(".list-group-item")
    .find((li) => li.find("code")?.text() === field);
  return row ? row.findAll("button") : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getLogTemplateSettings.mockResolvedValue({ templates: [], activeId: "" });
  api.saveLogTemplate.mockResolvedValue({ id: "t1", name: "App" });
  api.deleteLogTemplate.mockResolvedValue(undefined);
});

describe("LogTemplateDialog - list", () => {
  it("lists saved templates with their field order", async () => {
    api.getLogTemplateSettings.mockResolvedValue({
      templates: [T1],
      activeId: "",
    });
    const w = await mountDialog();
    expect(w.text()).toContain("App");
    expect(w.text()).toContain("msg, ts");
    w.unmount();
  });

  it("shows the empty state when there are no templates", async () => {
    const w = await mountDialog();
    expect(w.text()).toContain("No templates yet");
    w.unmount();
  });
});

describe("LogTemplateDialog - create", () => {
  it("loads fields from a pasted sample, reorders them and saves", async () => {
    const w = await mountDialog();
    await w.find(".btn-primary").trigger("click"); // New template
    await w.find("#logtmpl-name").setValue("App");
    await w.find("#logtmpl-sample").setValue(SAMPLE);
    await w
      .findAll("button")
      .find((b) => b.text() === "Load fields")
      .trigger("click");

    let fields = w.findAll(".list-group-item code").map((c) => c.text());
    expect(fields).toEqual(["ts", "level", "msg"]);

    await rowButtons(w, "msg")[0].trigger("click");
    await rowButtons(w, "msg")[0].trigger("click");
    fields = w.findAll(".list-group-item code").map((c) => c.text());
    expect(fields).toEqual(["msg", "ts", "level"]);

    expect(w.find(".logtmpl-preview").text()).toBe(
      '{"msg":"m", "ts":1, "level":"info"}',
    );

    await w
      .findAll("button")
      .find((b) => b.text() === "Save template")
      .trigger("click");
    await flushPromises();
    expect(api.saveLogTemplate).toHaveBeenCalledWith({
      id: "",
      name: "App",
      fieldOrder: ["msg", "ts", "level"],
    });
    expect(w.findAll("button").some((b) => b.text() === "New template")).toBe(
      true,
    );
    w.unmount();
  });

  it("reports when the pasted line has no JSON object", async () => {
    const w = await mountDialog();
    await w.find(".btn-primary").trigger("click"); // New template
    await w.find("#logtmpl-sample").setValue("plain text");
    await w
      .findAll("button")
      .find((b) => b.text() === "Load fields")
      .trigger("click");
    expect(w.find(".alert-danger").text()).toContain("No JSON object");
    expect(api.saveLogTemplate).not.toHaveBeenCalled();
    w.unmount();
  });

  it("disables save without a name or without fields", async () => {
    const w = await mountDialog();
    await w.find(".btn-primary").trigger("click"); // New template
    const saveBtn = () =>
      w.findAll("button").find((b) => b.text() === "Save template");
    expect(saveBtn().attributes("disabled")).toBeDefined();

    await w.find("#logtmpl-name").setValue("App");
    expect(saveBtn().attributes("disabled")).toBeDefined();

    await w.find("#logtmpl-sample").setValue(SAMPLE);
    await w
      .findAll("button")
      .find((b) => b.text() === "Load fields")
      .trigger("click");
    expect(saveBtn().attributes("disabled")).toBeUndefined();
    w.unmount();
  });

  it("adds a field by hand and removes one from the template", async () => {
    const w = await mountDialog();
    await w.find(".btn-primary").trigger("click"); // New template
    await w.find("#logtmpl-name").setValue("App");
    await w.find("#logtmpl-sample").setValue(SAMPLE);
    await w
      .findAll("button")
      .find((b) => b.text() === "Load fields")
      .trigger("click");

    await w.find("#logtmpl-newfield").setValue("caller");
    await w
      .findAll("button")
      .find((b) => b.text() === "Add field")
      .trigger("click");
    let fields = w.findAll(".list-group-item code").map((c) => c.text());
    expect(fields).toEqual(["ts", "level", "msg", "caller"]);

    const [up, down, remove] = rowButtons(w, "ts");
    expect(up).toBeTruthy();
    expect(down).toBeTruthy();
    await remove.trigger("click");
    fields = w.findAll(".list-group-item code").map((c) => c.text());
    expect(fields).toEqual(["level", "msg", "caller"]);
    w.unmount();
  });
});

describe("LogTemplateDialog - edit and delete", () => {
  it("edits an existing template with its id and current fields", async () => {
    api.getLogTemplateSettings.mockResolvedValue({
      templates: [T1],
      activeId: "",
    });
    const w = await mountDialog();
    await w
      .findAll("button")
      .find((b) => b.text() === "Edit")
      .trigger("click");

    expect(w.find("#logtmpl-name").element.value).toBe("App");
    let fields = w.findAll(".list-group-item code").map((c) => c.text());
    expect(fields).toEqual(["msg", "ts"]);

    await rowButtons(w, "msg")[1].trigger("click");
    await w
      .findAll("button")
      .find((b) => b.text() === "Save template")
      .trigger("click");
    await flushPromises();
    expect(api.saveLogTemplate).toHaveBeenCalledWith({
      id: "t1",
      name: "App",
      fieldOrder: ["ts", "msg"],
    });
    w.unmount();
  });

  it("deletes only after an explicit confirmation", async () => {
    api.getLogTemplateSettings.mockResolvedValue({
      templates: [T1],
      activeId: "",
    });
    const w = await mountDialog();
    await w
      .findAll("button")
      .find((b) => b.text() === "Delete")
      .trigger("click");
    expect(w.text()).toContain("Delete “App”?");
    expect(api.deleteLogTemplate).not.toHaveBeenCalled();

    await w
      .findAll("button")
      .find((b) => b.text() === "No")
      .trigger("click");
    await nextTick();
    expect(w.text()).not.toContain("Delete “App”?");
    expect(document.activeElement).toBe(
      w.find('[data-template-delete="t1"]').element,
    );

    await w
      .findAll("button")
      .find((b) => b.text() === "Delete")
      .trigger("click");
    await w
      .findAll("button")
      .find((b) => b.text() === "Yes, delete")
      .trigger("click");
    await flushPromises();
    await nextTick();
    expect(api.deleteLogTemplate).toHaveBeenCalledWith("t1");
    expect(document.activeElement).toBe(w.find("#logtmpl-heading").element);
    w.unmount();
  });
});

describe("LogTemplateDialog - Escape handling", () => {
  it("cancels the editor first, then closes the dialog", async () => {
    const w = await mountDialog();
    await w.find(".btn-primary").trigger("click"); // New template

    const dialog = w.find('[role="dialog"]');
    await dialog.trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(w.find("#logtmpl-name").exists()).toBe(false); // back on the list
    expect(w.emitted("close")).toBeUndefined();

    await dialog.trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("Escape cancels an open delete confirmation before closing", async () => {
    api.getLogTemplateSettings.mockResolvedValue({
      templates: [T1],
      activeId: "",
    });
    const w = await mountDialog();
    await w
      .findAll("button")
      .find((b) => b.text() === "Delete")
      .trigger("click");
    expect(w.text()).toContain("Delete “App”?");

    await w.find('[role="dialog"]').trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(w.text()).not.toContain("Delete “App”?");
    expect(w.emitted("close")).toBeUndefined();
    w.unmount();
  });
});

describe("LogTemplateDialog - error and edge paths", () => {
  it("shows the loading error when templates cannot be loaded", async () => {
    api.getLogTemplateSettings.mockRejectedValue(new Error("unreadable"));
    const w = await mountDialog();
    expect(w.find(".alert-danger").text()).toContain("unreadable");
    w.unmount();
  });

  it("keeps the editor open and shows the backend error when saving fails", async () => {
    api.saveLogTemplate.mockRejectedValue(
      new Error('a template named "App" already exists'),
    );
    const w = await mountDialog();
    await w.find(".btn-primary").trigger("click"); // New template
    await w.find("#logtmpl-name").setValue("App");
    await w.find("#logtmpl-sample").setValue(SAMPLE);
    await w
      .findAll("button")
      .find((b) => b.text() === "Load fields")
      .trigger("click");
    await w
      .findAll("button")
      .find((b) => b.text() === "Save template")
      .trigger("click");
    await flushPromises();

    expect(w.find(".alert-danger").text()).toContain("already exists");
    expect(w.find("#logtmpl-name").exists()).toBe(true); // still editing
    expect(w.findAll("button").some((b) => b.text() === "New template")).toBe(
      false,
    );
    w.unmount();
  });

  it("re-pasting a sample replaces the field list", async () => {
    const w = await mountDialog();
    await w.find(".btn-primary").trigger("click"); // New template
    await w.find("#logtmpl-name").setValue("App");
    await w.find("#logtmpl-sample").setValue(SAMPLE);
    await w
      .findAll("button")
      .find((b) => b.text() === "Load fields")
      .trigger("click");
    expect(w.findAll(".list-group-item code").map((c) => c.text())).toEqual([
      "ts",
      "level",
      "msg",
    ]);

    await w.find("#logtmpl-sample").setValue('{"caller":"c","msg":"m"}');
    await w
      .findAll("button")
      .find((b) => b.text() === "Load fields")
      .trigger("click");
    expect(w.findAll(".list-group-item code").map((c) => c.text())).toEqual([
      "caller",
      "msg",
    ]);
    w.unmount();
  });

  it("does not add a field twice by hand", async () => {
    const w = await mountDialog();
    await w.find(".btn-primary").trigger("click"); // New template
    await w.find("#logtmpl-newfield").setValue("msg");
    await w
      .findAll("button")
      .find((b) => b.text() === "Add field")
      .trigger("click");
    await w.find("#logtmpl-newfield").setValue("msg");
    await w
      .findAll("button")
      .find((b) => b.text() === "Add field")
      .trigger("click");
    expect(w.findAll(".list-group-item code").map((c) => c.text())).toEqual([
      "msg",
    ]);
    w.unmount();
  });

  it("disables save again when every field is removed", async () => {
    const w = await mountDialog();
    await w.find(".btn-primary").trigger("click"); // New template
    await w.find("#logtmpl-name").setValue("App");
    await w.find("#logtmpl-sample").setValue(SAMPLE);
    await w
      .findAll("button")
      .find((b) => b.text() === "Load fields")
      .trigger("click");
    const saveBtn = () =>
      w.findAll("button").find((b) => b.text() === "Save template");
    expect(saveBtn().attributes("disabled")).toBeUndefined();

    for (const _ of ["ts", "level", "msg"]) {
      await rowButtons(
        w,
        w.findAll(".list-group-item code")[0].text(),
      )[2].trigger("click");
    }
    expect(w.findAll(".list-group-item code")).toHaveLength(0);
    expect(saveBtn().attributes("disabled")).toBeDefined();
    w.unmount();
  });
});

describe("LogTemplateDialog - field reorder focus", () => {
  async function openEditor() {
    const w = await mountDialog();
    await w.find(".btn-primary").trigger("click"); // New template
    await w.find("#logtmpl-sample").setValue(SAMPLE);
    await w
      .findAll("button")
      .find((b) => b.text() === "Load fields")
      .trigger("click");
    return w;
  }

  function row(w, field) {
    return w
      .findAll(".list-group-item")
      .find((li) => li.find("code")?.text() === field);
  }

  it("keeps focus in the row when the clicked Move up button becomes disabled", async () => {
    const w = await openEditor();
    // Fields: ts, level, msg. Moving "level" up puts it first, where its
    // Move up button becomes disabled; focus must not leave the dialog.
    const up = row(w, "level").findAll("button")[0];
    up.element.focus();
    await up.trigger("click");
    await nextTick();
    expect(w.findAll(".list-group-item code").map((c) => c.text())).toEqual([
      "level",
      "ts",
      "msg",
    ]);
    expect(document.activeElement).toBe(
      row(w, "level").findAll("button")[1].element,
    );
    w.unmount();
  });

  it("keeps focus in the row when the clicked Move down button becomes disabled", async () => {
    const w = await openEditor();
    const down = row(w, "level").findAll("button")[1];
    down.element.focus();
    await down.trigger("click");
    await nextTick();
    expect(w.findAll(".list-group-item code").map((c) => c.text())).toEqual([
      "ts",
      "msg",
      "level",
    ]);
    expect(document.activeElement).toBe(
      row(w, "level").findAll("button")[0].element,
    );
    w.unmount();
  });

  it("keeps focus on the clicked button while it stays enabled", async () => {
    const w = await openEditor();
    // Move "msg" up: it lands in the middle, so the button stays enabled.
    const up = row(w, "msg").findAll("button")[0];
    up.element.focus();
    await up.trigger("click");
    await nextTick();
    expect(document.activeElement).toBe(up.element);
    w.unmount();
  });
});

describe("LogTemplateDialog - focus trap", () => {
  it("wraps Tab and Shift+Tab inside the modal", async () => {
    api.getLogTemplateSettings.mockResolvedValue({
      templates: [T1],
      activeId: "",
    });
    const w = await mountDialog();
    const dialog = w.find('[role="dialog"]');
    const firstBtn = w.find(".btn-close");
    const lastBtn = w.findAll("button").find((b) => b.text() === "Close");

    // Tab from the last focusable wraps to the first.
    lastBtn.element.focus();
    await dialog.trigger("keydown", { key: "Tab" });
    await nextTick();
    expect(document.activeElement).toBe(firstBtn.element);

    // Shift+Tab from the first focusable wraps to the last.
    await dialog.trigger("keydown", { key: "Tab", shiftKey: true });
    await nextTick();
    expect(document.activeElement).toBe(lastBtn.element);

    // Tab in the middle of the dialog is left to the browser.
    const editBtn = w.findAll("button").find((b) => b.text() === "Edit");
    editBtn.element.focus();
    await dialog.trigger("keydown", { key: "Tab" });
    await nextTick();
    expect(document.activeElement).toBe(editBtn.element);
    w.unmount();
  });

  it("treats the focused heading as a tab edge instead of letting focus escape", async () => {
    api.getLogTemplateSettings.mockResolvedValue({
      templates: [T1],
      activeId: "",
    });
    const w = await mountDialog();
    const dialog = w.find('[role="dialog"]');
    const firstBtn = w.find(".btn-close");
    const lastBtn = w.findAll("button").find((b) => b.text() === "Close");

    // The dialog opens with focus on the heading (tabindex="-1"), which is
    // not part of the tab sequence. Shift+Tab must land on the last tabbable
    // element, not on whatever sits behind the dialog.
    const heading = w.find("#logtmpl-heading");
    heading.element.focus();
    await dialog.trigger("keydown", { key: "Tab", shiftKey: true });
    await nextTick();
    expect(document.activeElement).toBe(lastBtn.element);

    heading.element.focus();
    await dialog.trigger("keydown", { key: "Tab" });
    await nextTick();
    expect(document.activeElement).toBe(firstBtn.element);
    w.unmount();
  });
});
