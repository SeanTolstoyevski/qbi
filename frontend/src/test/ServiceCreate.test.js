import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ServiceCreate from "../components/ServiceCreate.vue";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: { createService: vi.fn(), renderServiceYaml: vi.fn() },
  onEvent: vi.fn(() => () => {}),
}));

const YAML = "kind: Service\nmetadata:\n  name: web";

beforeEach(() => {
  vi.clearAllMocks();
  api.createService.mockResolvedValue(true);
  api.renderServiceYaml.mockResolvedValue(YAML);
});

async function mountForm() {
  const w = mount(ServiceCreate, {
    props: { namespace: "default", openerId: "svc-create-btn" },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

function findBtn(w, label) {
  return w.findAll("button").find((b) => b.text().includes(label));
}

// A minimal valid form: name + one port. Selector stays empty, which is legal.
async function fillBasic(w, over = {}) {
  await w.find("#svc-name").setValue(over.name ?? "web");
  await w.find("#svc-port-0").setValue(over.port ?? 80);
  if (over.type) await w.find("#svc-type").setValue(over.type);
  if (over.target) await w.find("#svc-target-0").setValue(over.target);
  if (over.nodePort) await w.find("#svc-nodeport-0").setValue(over.nodePort);
}

describe("ServiceCreate — layout", () => {
  it("moves focus to the panel heading on open", async () => {
    const w = await mountForm();
    expect(w.find("#svc-create-heading").element).toBe(document.activeElement);
    w.unmount();
  });

  it("shows the node port field only for NodePort and LoadBalancer", async () => {
    const w = await mountForm();
    expect(w.find("#svc-nodeport-0").exists()).toBe(false);
    await w.find("#svc-type").setValue("NodePort");
    expect(w.find("#svc-nodeport-0").exists()).toBe(true);
    await w.find("#svc-type").setValue("LoadBalancer");
    expect(w.find("#svc-nodeport-0").exists()).toBe(true);
    await w.find("#svc-type").setValue("ClusterIP");
    expect(w.find("#svc-nodeport-0").exists()).toBe(false);
    w.unmount();
  });

  it("adds and removes port rows", async () => {
    const w = await mountForm();
    expect(w.findAll('[id^="svc-port-"]')).toHaveLength(1);
    await findBtn(w, "Add port").trigger("click");
    expect(w.findAll('[id^="svc-port-"]')).toHaveLength(2);
    await w.find('[aria-label="Remove port 2"]').trigger("click");
    expect(w.findAll('[id^="svc-port-"]')).toHaveLength(1);
    w.unmount();
  });
});

describe("ServiceCreate — validation", () => {
  it("requires a name", async () => {
    const w = await mountForm();
    await findBtn(w, "Create").trigger("click");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("Name is required.");
    expect(api.createService).not.toHaveBeenCalled();
    w.unmount();
  });

  it("requires at least one port", async () => {
    const w = await mountForm();
    await w.find("#svc-name").setValue("web");
    await findBtn(w, "Create").trigger("click");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain(
      "At least one port is required.",
    );
    w.unmount();
  });

  it("lets the browser block an out-of-range port before submission", async () => {
    // The number input declares min=1 max=65535; happy-dom (like a real
    // browser) refuses to submit the form while the control is out of range,
    // so neither the inline validation nor the API call ever runs.
    const w = await mountForm();
    await fillBasic(w, { port: 70000 });
    expect(w.find("#svc-port-0").element.validity.rangeOverflow).toBe(true);
    await findBtn(w, "Create").trigger("click");
    await flushPromises();
    expect(api.createService).not.toHaveBeenCalled();
    expect(w.find('[role="alert"]').exists()).toBe(false);
    w.unmount();
  });

  it("rejects an invalid target port name", async () => {
    const w = await mountForm();
    await fillBasic(w, { target: "1bad-name" });
    await findBtn(w, "Create").trigger("click");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain(
      'Invalid target port "1bad-name"',
    );
    w.unmount();
  });

  it("lets the browser block an out-of-range node port before submission", async () => {
    // Same constraint validation: min=30000 makes 100 invalid, so the form
    // cannot submit and the API is never reached.
    const w = await mountForm();
    await fillBasic(w, { type: "NodePort", nodePort: 100 });
    expect(w.find("#svc-nodeport-0").element.validity.rangeUnderflow).toBe(
      true,
    );
    await findBtn(w, "Create").trigger("click");
    await flushPromises();
    expect(api.createService).not.toHaveBeenCalled();
    expect(w.find('[role="alert"]').exists()).toBe(false);
    w.unmount();
  });

  it("rejects a selector value without a key", async () => {
    const w = await mountForm();
    await fillBasic(w);
    await w.find("#svc-sel-val-0").setValue("gitea");
    await findBtn(w, "Create").trigger("click");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain(
      "Selector rows need a key.",
    );
    w.unmount();
  });
});

describe("ServiceCreate — create flow", () => {
  it("creates a service with the chosen options and emits created", async () => {
    const w = await mountForm();
    await fillBasic(w, { type: "NodePort", target: "8080", nodePort: 30080 });
    await w.find("#svc-sel-key-0").setValue("app");
    await w.find("#svc-sel-val-0").setValue("gitea");
    // Advanced options: session affinity, cluster IP, external IPs.
    w.find("details").element.open = true;
    await w.find("#svc-affinity").setValue("ClientIP");
    await w.find("#svc-clusterip").setValue("10.96.0.10");
    await findBtn(w, "Add IP").trigger("click");
    await w.find("#svc-extip-0").setValue("1.2.3.4");

    await findBtn(w, "Create").trigger("click");
    await flushPromises();
    expect(api.createService).toHaveBeenCalledWith("default", {
      name: "web",
      type: "NodePort",
      selector: { app: "gitea" },
      ports: [
        {
          name: "",
          port: 80,
          targetPort: "8080",
          protocol: "TCP",
          nodePort: 30080,
        },
      ],
      sessionAffinity: "ClientIP",
      clusterIP: "10.96.0.10",
      externalIPs: ["1.2.3.4"],
    });
    expect(w.emitted("created")).toHaveLength(1);
    w.unmount();
  });

  it("keeps the form open when the user cancels the confirmation", async () => {
    api.createService.mockResolvedValue(false);
    const w = await mountForm();
    await fillBasic(w);
    await findBtn(w, "Create").trigger("click");
    await flushPromises();
    expect(api.createService).toHaveBeenCalledTimes(1);
    expect(w.emitted("created")).toBeUndefined();
    expect(w.find("#svc-name").element.value).toBe("web");
    w.unmount();
  });

  it("shows the error when creation fails", async () => {
    api.createService.mockRejectedValue(new Error("forbidden"));
    const w = await mountForm();
    await fillBasic(w);
    await findBtn(w, "Create").trigger("click");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("forbidden");
    expect(w.emitted("created")).toBeUndefined();
    w.unmount();
  });

  it("closes via Cancel and via the panel Close button", async () => {
    const w = await mountForm();
    await findBtn(w, "Cancel").trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    await w
      .findAll("button")
      .find((b) => b.text() === "Close")
      .trigger("click");
    expect(w.emitted("close")).toHaveLength(2);
    w.unmount();
  });
});

describe("ServiceCreate — YAML preview", () => {
  it("renders the manifest for a valid form and hides it on toggle", async () => {
    const w = await mountForm();
    await fillBasic(w);
    await findBtn(w, "Preview YAML").trigger("click");
    await flushPromises();
    expect(api.renderServiceYaml).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ name: "web", type: "ClusterIP" }),
    );
    expect(w.find("pre").text()).toContain("kind: Service");
    expect(findBtn(w, "Hide preview")).toBeDefined();
    await findBtn(w, "Hide preview").trigger("click");
    expect(w.find("pre").exists()).toBe(false);
    w.unmount();
  });

  it("refuses to preview an invalid form", async () => {
    const w = await mountForm();
    await findBtn(w, "Preview YAML").trigger("click");
    await flushPromises();
    expect(api.renderServiceYaml).not.toHaveBeenCalled();
    expect(w.find('[role="alert"]').text()).toContain("Name is required.");
    w.unmount();
  });
});
