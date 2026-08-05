/*
 * Tests for NetworkingView.vue — the services/ingresses screen plus the
 * create-service panel. The form is option-driven: the user picks type,
 * selector, ports and node ports; nothing is inferred by the app.
 *
 * We cover:
 *   - Renders services returned by the API
 *   - Creates a service with the user's chosen options
 *   - Renders a YAML preview from the form
 *   - Rejects creation when no port is given
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import NetworkingView from "../components/NetworkingView.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: {
    listServices: vi.fn(),
    listIngresses: vi.fn(),
    createService: vi.fn(),
    renderServiceYaml: vi.fn(),
    deleteService: vi.fn(),
    getIngressDetail: vi.fn(),
    deleteIngress: vi.fn(),
    listIngressClasses: vi.fn(),
    renderIngressYaml: vi.fn(),
    createIngress: vi.fn(),
    ingressEdit: vi.fn(),
    updateIngress: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

const { setConnection, setNamespace } = useStore();

beforeEach(() => {
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");
  vi.clearAllMocks();
  api.listServices.mockResolvedValue([
    {
      name: "web",
      type: "ClusterIP",
      age: "2d",
      dnsName: "web.default.svc",
      clusterIP: "10.0.0.5",
      ports: [],
      selector: { app: "web" },
      endpoints: [],
    },
  ]);
  api.listIngresses.mockResolvedValue([]);
});

function mountView() {
  return mount(NetworkingView, { attachTo: document.body });
}

function findBtn(w, label) {
  return w.findAll("button").find((b) => b.text().includes(label));
}

// Actions live behind an "Actions" dropdown button; open it before clicking a
// menu item (same helper convention as PodList tests).
async function openActions(w) {
  await findBtn(w, "Actions").trigger("click");
  await nextTick();
}

describe("NetworkingView — rendering", () => {
  it("renders services returned by the API", async () => {
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("web");
    expect(w.text()).toContain("web.default.svc");
    w.unmount();
  });
});

describe("NetworkingView — ingresses", () => {
  const brokenIngress = {
    name: "web",
    class: "nginx",
    age: "2d",
    addresses: ["1.2.3.4"],
    tls: [{ hosts: ["a.example.com"], secretName: "web-tls", secretStatus: "missing" }],
    rules: [
      {
        host: "a.example.com",
        paths: [
          {
            path: "/",
            pathType: "Prefix",
            serviceName: "web",
            servicePort: "80",
            status: "no-endpoints",
            readyEndpoints: 0,
          },
        ],
      },
    ],
    issues: [
      "TLS secret \"web-tls\" not found in this namespace (hosts: a.example.com).",
      "Host a.example.com, path / routes to service \"web\", which has no ready endpoints — requests will fail.",
    ],
  };

  it("renders the enriched ingress: addresses, TLS status and backend health", async () => {
    api.listIngresses.mockResolvedValue([brokenIngress]);
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("web");
    expect(w.text()).toContain("1.2.3.4");
    expect(w.text()).toContain("secret missing");
    expect(w.text()).toContain("no ready endpoints");
    expect(w.text()).toContain("2 issues");
    expect(w.text()).toContain("Prefix");
    w.unmount();
  });

  it("renders an ingress without rules in the list without crashing", async () => {
    // Regression: a broken ingress with no rules must render the "none" note,
    // not throw on a null rules array.
    api.listIngresses.mockResolvedValue([
      { ...brokenIngress, rules: [], issues: ["No routing rules defined: this ingress forwards no traffic."] },
    ]);
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("none");
    expect(w.text()).toContain("1 issue");
    w.unmount();
  });

  it("opens the ingress detail panel from Inspect", async () => {
    api.listIngresses.mockResolvedValue([brokenIngress]);
    api.getIngressDetail.mockResolvedValue({
      ingress: brokenIngress,
      events: [],
      eventsError: "",
    });
    const w = mountView();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Inspect").trigger("click");
    await flushPromises();
    expect(api.getIngressDetail).toHaveBeenCalledWith("default", "web");
    expect(w.text()).toContain("Ingress: web");
    expect(w.text()).toContain("Issues");
    w.unmount();
  });

  it("deletes an ingress from its list row after confirmation", async () => {
    api.listIngresses.mockResolvedValue([brokenIngress]);
    api.deleteIngress.mockResolvedValue(true);
    const w = mountView();
    await flushPromises();
    await openActions(w);
    await w.find('[role="menu"] .dropdown-item.text-danger').trigger("click");
    await flushPromises();
    expect(api.deleteIngress).toHaveBeenCalledWith("default", "web");
    w.unmount();
  });

  it("closes the detail panel when the inspected ingress is deleted", async () => {
    api.listIngresses.mockResolvedValue([brokenIngress]);
    api.getIngressDetail.mockResolvedValue({
      ingress: brokenIngress,
      events: [],
      eventsError: "",
    });
    api.deleteIngress.mockResolvedValue(true);
    const w = mountView();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Inspect").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("Ingress: web");
    // Delete inside the detail panel
    const deleteBtn = w.findAll("button").find((b) => b.text().includes("Delete ingress"));
    await deleteBtn.trigger("click");
    await flushPromises();
    expect(api.deleteIngress).toHaveBeenCalledWith("default", "web");
    expect(w.text()).not.toContain("Ingress: web");
    w.unmount();
  });

  it("closes the open detail panel when the namespace changes", async () => {
    api.listIngresses.mockResolvedValue([brokenIngress]);
    api.getIngressDetail.mockResolvedValue({
      ingress: brokenIngress,
      events: [],
      eventsError: "",
    });
    const w = mountView();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Inspect").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("Ingress: web");
    setNamespace("other");
    await flushPromises();
    expect(w.text()).not.toContain("Ingress: web");
    w.unmount();
  });

  it("closes an open action menu when the namespace changes", async () => {
    api.listIngresses.mockResolvedValue([brokenIngress]);
    const w = mountView();
    await flushPromises();
    await openActions(w);
    expect(w.find('[role="menu"]').exists()).toBe(true);

    setNamespace("other");
    await flushPromises();
    expect(w.find('[role="menu"]').exists()).toBe(false);
    w.unmount();
  });
});

describe("NetworkingView — create service", () => {
  it("creates a service with the user's chosen options", async () => {
    api.createService.mockResolvedValue(true);
    const w = mountView();
    await flushPromises();
    await findBtn(w, "Create service").trigger("click");
    await nextTick();
    await w.find("#svc-name").setValue("gitea");
    await w.find("#svc-type").setValue("NodePort");
    await w.find("#svc-sel-key-0").setValue("app");
    await w.find("#svc-sel-value-0").setValue("gitea");
    await w.find("#svc-port-0").setValue(3000);
    await w.find("#svc-target-0").setValue("3000");
    await w.find("#svc-nodeport-0").setValue(30080);
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createService).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        name: "gitea",
        type: "NodePort",
        selector: { app: "gitea" },
        ports: [
          { name: "", port: 3000, targetPort: "3000", protocol: "TCP", nodePort: 30080 },
        ],
      })
    );
    w.unmount();
  });

  it("renders a YAML preview from the form", async () => {
    api.renderServiceYaml.mockResolvedValue(
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n"
    );
    const w = mountView();
    await flushPromises();
    await findBtn(w, "Create service").trigger("click");
    await nextTick();
    await w.find("#svc-name").setValue("web");
    await w.find("#svc-port-0").setValue(80);
    await findBtn(w, "Preview YAML").trigger("click");
    await flushPromises();
    expect(api.renderServiceYaml).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ name: "web" })
    );
    expect(w.text()).toContain("kind: Service");
    w.unmount();
  });

  it("rejects creation when no port is given", async () => {
    const w = mountView();
    await flushPromises();
    await findBtn(w, "Create service").trigger("click");
    await nextTick();
    api.createService.mockClear(); // ignore creates sent by earlier tests
    await w.find("#svc-name").setValue("web");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createService).not.toHaveBeenCalled();
    expect(w.text()).toContain("At least one port");
    w.unmount();
  });
});

describe("NetworkingView — delete service", () => {
  it("deletes a service via the API after confirmation", async () => {
    api.deleteService.mockResolvedValue(true);
    const w = mountView();
    await flushPromises();
    const btn = w.findAll("button").find((b) => b.text().includes("Delete"));
    await btn.trigger("click");
    await flushPromises();
    expect(api.deleteService).toHaveBeenCalledWith("default", "web");
    w.unmount();
  });
});

// Shared fixture: a minimal ingress row as returned by the list API.
const minimalIngress = {
  name: "web",
  class: "nginx",
  age: "2d",
  addresses: ["1.2.3.4"],
  tls: [],
  rules: [
    {
      host: "example.com",
      paths: [
        { path: "/", pathType: "Prefix", serviceName: "web", servicePort: "80", status: "ok", readyEndpoints: 1 },
      ],
    },
  ],
  issues: [],
};

describe("NetworkingView — create/edit ingress", () => {
  beforeEach(() => {
    api.listIngressClasses.mockResolvedValue(["nginx"]);
    api.ingressEdit.mockResolvedValue({
      spec: {
        name: "web",
        ingressClassName: "nginx",
        rules: [
          {
            host: "example.com",
            paths: [
              { path: "/", pathType: "Prefix", serviceName: "web", servicePort: "80" },
            ],
          },
        ],
        tls: [],
        defaultBackend: null,
        annotations: {},
        labels: {},
      },
      unsupported: [],
    });
  });

  it("opens the create-ingress panel from the Create ingress button", async () => {
    const w = mountView();
    await flushPromises();
    await findBtn(w, "Create ingress").trigger("click");
    await flushPromises();
    expect(w.find("#ing-create-name").exists()).toBe(true);
    expect(w.text()).toContain("Create ingress");
    w.unmount();
  });

  it("opens the edit panel from the row Actions dropdown", async () => {
    api.listIngresses.mockResolvedValue([minimalIngress]);
    const w = mountView();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Edit").trigger("click");
    await flushPromises();
    expect(api.ingressEdit).toHaveBeenCalledWith("default", "web");
    expect(w.text()).toContain("Edit ingress: web");
    w.unmount();
  });

  it("keeps only one side panel open at a time", async () => {
    const w = mountView();
    await flushPromises();
    await findBtn(w, "Create service").trigger("click");
    await nextTick();
    expect(w.find("#svc-name").exists()).toBe(true);
    await findBtn(w, "Create ingress").trigger("click");
    await flushPromises();
    expect(w.find("#svc-name").exists()).toBe(false);
    expect(w.find("#ing-create-name").exists()).toBe(true);
    w.unmount();
  });

  it("closes the create-ingress panel when the namespace changes", async () => {
    const w = mountView();
    await flushPromises();
    await findBtn(w, "Create ingress").trigger("click");
    await flushPromises();
    expect(w.find("#ing-create-name").exists()).toBe(true);
    setNamespace("other");
    await flushPromises();
    expect(w.find("#ing-create-name").exists()).toBe(false);
    w.unmount();
  });

  it("swaps the detail panel to the edit form via Edit", async () => {
    api.listIngresses.mockResolvedValue([minimalIngress]);
    api.getIngressDetail.mockResolvedValue({
      ingress: minimalIngress,
      events: [],
      eventsError: "",
    });
    const w = mountView();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Inspect").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("Ingress: web");
    // Click the Edit button inside the DETAIL panel (not the row's), which
    // exercises the onIngressEdit swap path.
    await w.find("#ing-detail-edit-btn").trigger("click");
    await flushPromises();
    expect(api.ingressEdit).toHaveBeenCalledWith("default", "web");
    expect(w.text()).toContain("Edit ingress: web");
    expect(w.text()).not.toContain("Issues");
    // Closing the edit form returns to the row's Actions button, not the
    // Inspect button of the (now closed) detail panel.
    await w.find("#ing-create-heading").trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(document.activeElement?.id).toBe("actions-btn-ing-web");
    w.unmount();
  });
});

describe("NetworkingView — visible button labels", () => {
  it("labels the create buttons with their full visible names", async () => {
    const w = mountView();
    await flushPromises();
    const svcBtn = w.find("#svc-create-btn");
    const ingBtn = w.find("#ing-create-btn");
    // The distinguishing word must be visible, not only in a
    // visually-hidden span: two buttons both reading "Create" are
    // indistinguishable for sighted users.
    expect(svcBtn.find(".visually-hidden").exists()).toBe(false);
    expect(ingBtn.find(".visually-hidden").exists()).toBe(false);
    expect(svcBtn.text()).toBe("Create service");
    expect(ingBtn.text()).toBe("Create ingress");
    w.unmount();
  });
});

describe("NetworkingView — focus returns to the trigger on close", () => {
  beforeEach(() => {
    api.listIngressClasses.mockResolvedValue(["nginx"]);
    api.ingressEdit.mockResolvedValue({
      spec: {
        name: "web",
        ingressClassName: "",
        rules: [
          {
            host: "example.com",
            paths: [{ path: "/", pathType: "Prefix", serviceName: "web", servicePort: "80" }],
          },
        ],
        tls: [],
        defaultBackend: null,
        annotations: {},
        labels: {},
      },
      unsupported: [],
    });
    api.listIngresses.mockResolvedValue([minimalIngress]);
  });

  async function closeWithEscape(w, headingId) {
    await w.find(`#${headingId}`).trigger("keydown", { key: "Escape" });
    await flushPromises();
  }

  it("returns focus to the Create ingress button after an Escape close", async () => {
    const w = mountView();
    await flushPromises();
    await findBtn(w, "Create ingress").trigger("click");
    await flushPromises();
    expect(document.activeElement?.id).toBe("ing-create-heading");
    await closeWithEscape(w, "ing-create-heading");
    expect(document.activeElement?.id).toBe("ing-create-btn");
    w.unmount();
  });

  it("returns focus to the Create ingress button after closing via the Close button", async () => {
    const w = mountView();
    await flushPromises();
    await findBtn(w, "Create ingress").trigger("click");
    await flushPromises();
    await findBtn(w, "Close").trigger("click");
    await flushPromises();
    expect(document.activeElement?.id).toBe("ing-create-btn");
    w.unmount();
  });

  it("returns focus to the row Actions button after closing the edit panel", async () => {
    const w = mountView();
    await flushPromises();
    const actionsBtn = w.find("#actions-btn-ing-web");
    await actionsBtn.trigger("click");
    await nextTick();
    await findBtn(w, "Edit").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("Edit ingress: web");
    await closeWithEscape(w, "ing-create-heading");
    // The trigger must have been focused before the panel mounted, so the
    // panel returns focus to exactly the button that opened it — never to
    // the body or a stale element.
    expect(document.activeElement).toBe(actionsBtn.element);
    w.unmount();
  });

  it("returns focus to the Create service button after closing the service panel", async () => {
    const w = mountView();
    await flushPromises();
    await findBtn(w, "Create service").trigger("click");
    await flushPromises();
    await closeWithEscape(w, "svc-create-heading");
    expect(document.activeElement?.id).toBe("svc-create-btn");
    w.unmount();
  });

  it("captures the new trigger when panels swap in the same render pass", async () => {
    const w = mountView();
    await flushPromises();
    await findBtn(w, "Create service").trigger("click");
    await flushPromises();
    // Swap straight to the ingress create panel without closing first: the
    // service panel's focus-return (to svc-create-btn) runs in the same
    // render pass and must NOT become the ingress panel's opener.
    await findBtn(w, "Create ingress").trigger("click");
    await flushPromises();
    await closeWithEscape(w, "ing-create-heading");
    expect(document.activeElement?.id).toBe("ing-create-btn");
    w.unmount();
  });
});
