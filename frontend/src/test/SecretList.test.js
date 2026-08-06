/*
 * Tests for SecretList.vue — the secrets tab container.
 *
 * The editor logic lives in SecretDetail/SecretCreate (covered by their own
 * tests); here we cover the list orchestration:
 *   - rendering the secret list, filtering it, and its empty/error states
 *   - selecting a secret opens the detail panel with the right props
 *   - the New secret button opens the create panel
 *   - the value-mode toggle (Plain text / Base64) persists and flows down
 *   - a namespace switch closes whatever panel is open (names are scoped)
 *   - closing / deleting a secret resets the right column
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import SecretList from "../components/SecretList.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { listSecrets: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

const { setConnection, setNamespace } = useStore();

// Stub the two right-column panels so list tests never touch editor logic.
const PanelStub = defineComponent({
  name: "PanelStub",
  props: { namespace: String, name: String, mode: String },
  emits: ["close", "updated", "deleted", "created"],
  setup(props, { emit }) {
    return () =>
      h(
        "div",
        {
          class: "panel-stub",
          "data-name": props.name || "",
          "data-mode": props.mode || "",
        },
        [
          h(
            "button",
            { class: "stub-close", onClick: () => emit("close") },
            "close",
          ),
          h(
            "button",
            { class: "stub-updated", onClick: () => emit("updated") },
            "updated",
          ),
          h(
            "button",
            { class: "stub-deleted", onClick: () => emit("deleted") },
            "deleted",
          ),
          h(
            "button",
            { class: "stub-created", onClick: () => emit("created") },
            "created",
          ),
        ],
      );
  },
});

const stubs = { SecretDetail: PanelStub, SecretCreate: PanelStub };

const SECRETS = [
  { name: "api-token", type: "Opaque", keys: ["token"], age: "2d" },
  {
    name: "web-tls",
    type: "kubernetes.io/tls",
    keys: ["tls.crt", "tls.key"],
    age: "5h",
  },
];

async function mountList(list = SECRETS) {
  api.listSecrets.mockResolvedValue(list);
  const w = mount(SecretList, { attachTo: document.body, global: { stubs } });
  await flushPromises();
  return w;
}

function option(w, text) {
  return w.findAll('[role="option"]').find((o) => o.text().includes(text));
}

async function selectSecret(w, name) {
  await option(w, name).trigger("click");
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");
  vi.clearAllMocks();
});

describe("SecretList — list rendering", () => {
  it("renders every secret as a listbox option", async () => {
    const w = await mountList();
    expect(w.findAll('[role="option"]')).toHaveLength(2);
    expect(w.text()).toContain("api-token");
    expect(w.text()).toContain("kubernetes.io/tls");
    w.unmount();
  });

  it("filters options by name", async () => {
    const w = await mountList();
    await w.find("#secret-filter").setValue("tls");
    expect(w.findAll('[role="option"]')).toHaveLength(1);
    expect(w.text()).toContain("web-tls");
    w.unmount();
  });

  it("shows an honest empty state when there are no secrets", async () => {
    const w = await mountList([]);
    expect(w.text()).toContain("No secrets found.");
    w.unmount();
  });

  it("shows the error message when listing fails", async () => {
    api.listSecrets.mockRejectedValue(new Error("boom"));
    const w = mount(SecretList, { attachTo: document.body, global: { stubs } });
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("boom");
    w.unmount();
  });
});

describe("SecretList — detail panel", () => {
  it("opens the detail panel for the selected secret", async () => {
    const w = await mountList();
    await selectSecret(w, "api-token");
    const panel = w.findComponent(PanelStub);
    expect(panel.exists()).toBe(true);
    expect(panel.props("name")).toBe("api-token");
    expect(panel.props("namespace")).toBe("default");
    expect(panel.props("mode")).toBe("transparent");
    w.unmount();
  });

  it("closes the detail panel when the secret disappears from the list", async () => {
    const w = await mountList();
    await selectSecret(w, "api-token");
    api.listSecrets.mockResolvedValue([SECRETS[1]]);
    await w
      .findAll("button")
      .find((b) => b.text().includes("Refresh"))
      .trigger("click");
    await flushPromises();
    expect(w.findComponent(PanelStub).exists()).toBe(false);
    w.unmount();
  });

  it("emitting updated reloads the list", async () => {
    const w = await mountList();
    await selectSecret(w, "api-token");
    api.listSecrets.mockClear();
    await w.find(".stub-updated").trigger("click");
    await flushPromises();
    expect(api.listSecrets).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("emitting deleted closes the panel and reloads", async () => {
    const w = await mountList();
    await selectSecret(w, "api-token");
    api.listSecrets.mockClear();
    await w.find(".stub-deleted").trigger("click");
    await flushPromises();
    expect(w.findComponent(PanelStub).exists()).toBe(false);
    expect(api.listSecrets).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("emitting close resets the right column", async () => {
    const w = await mountList();
    await selectSecret(w, "api-token");
    await w.find(".stub-close").trigger("click");
    expect(w.findComponent(PanelStub).exists()).toBe(false);
    expect(w.text()).toContain("Select a secret to view it.");
    w.unmount();
  });
});

describe("SecretList — create panel", () => {
  it("opens the create panel from the New secret button", async () => {
    const w = await mountList();
    await w.find("#secret-create-btn").trigger("click");
    const panel = w.findComponent(PanelStub);
    expect(panel.exists()).toBe(true);
    expect(panel.props("name")).toBeUndefined(); // create has no secret name
    w.unmount();
  });

  it("emitting created closes the panel and reloads", async () => {
    const w = await mountList();
    await w.find("#secret-create-btn").trigger("click");
    api.listSecrets.mockClear();
    await w.find(".stub-created").trigger("click");
    await flushPromises();
    expect(w.findComponent(PanelStub).exists()).toBe(false);
    expect(api.listSecrets).toHaveBeenCalled();
    w.unmount();
  });
});

describe("SecretList — value mode toggle", () => {
  it("defaults to plain text and persists a switch to base64", async () => {
    const w = await mountList();
    await w
      .findAll('[role="radio"]')
      .find((b) => b.text() === "Base64")
      .trigger("click");
    expect(localStorage.getItem("qba.secretValueMode")).toBe("base64");
    w.unmount();
  });

  it("starts in base64 mode when the persisted value says so", async () => {
    localStorage.setItem("qba.secretValueMode", "base64");
    const w = await mountList();
    await selectSecret(w, "api-token");
    expect(w.findComponent(PanelStub).props("mode")).toBe("base64");
    w.unmount();
  });

  it("passes the selected mode down to the open panel", async () => {
    const w = await mountList();
    await w
      .findAll('[role="radio"]')
      .find((b) => b.text() === "Base64")
      .trigger("click");
    await selectSecret(w, "api-token");
    expect(w.findComponent(PanelStub).props("mode")).toBe("base64");
    w.unmount();
  });
});

describe("SecretList — namespace scoping", () => {
  it("closes the detail panel when the namespace changes", async () => {
    const w = await mountList();
    await selectSecret(w, "api-token");
    setNamespace("other");
    await flushPromises();
    expect(w.findComponent(PanelStub).exists()).toBe(false);
    w.unmount();
  });

  it("closes the create panel when the namespace changes", async () => {
    const w = await mountList();
    await w.find("#secret-create-btn").trigger("click");
    expect(w.findComponent(PanelStub).exists()).toBe(true);
    setNamespace("other");
    await flushPromises();
    expect(w.findComponent(PanelStub).exists()).toBe(false);
    w.unmount();
  });
});
